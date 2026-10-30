/* ============================================================
   comfy.js — ComfyUI HTTP API 封装
   · POST /prompt        提交 API 格式工作流
   · GET  /history/{id}  取执行结果
   · GET  /view          取输出图片
   · POST /upload/image  上传参考图
   · GET  /object_info   节点定义（用于工作流格式转换）
   ============================================================ */

window.Comfy = (function () {
  'use strict';

  const KEY = 'vault.comfy';
  let cfg = { baseUrl: 'http://127.0.0.1:8188', lastTest: 0 };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) cfg = { ...cfg, ...JSON.parse(raw) };
    } catch { }
    return cfg;
  }

  function save(patch) {
    cfg = { ...cfg, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { }
    return cfg;
  }

  const base = () => String(cfg.baseUrl || '').trim().replace(/\/+$/, '');

  function url(path) {
    const b = base();
    if (!b) throw new Error('还没设置 ComfyUI 地址');
    return b + path;
  }

  function friendly(e) {
    const m = String(e?.message || e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return `连不上 ComfyUI（${base()}）。确认它正在运行，并且允许跨域：` +
        `启动时加 \`--enable-cors-header\`，或用官方桌面版。`;
    }
    return m;
  }

  // 请求路由：'auto' 先直连，被拒（跨域 403 / TypeError）就改走 serve.py 的本地反代并记住
  let route = 'auto';

  function loomProxy(abs) {
    return '/comfy?u=' + encodeURIComponent(abs);
  }

  async function finishRes(path, res) {
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { }
      throw new Error(`ComfyUI ${path} → HTTP ${res.status}${detail ? ' · ' + detail : ''}`);
    }
    return res;
  }

  async function req(path, opts = {}) {
    const abs = url(path);
    let lastErr = null;

    // 1) 直连（ComfyUI 带 --enable-cors-header 或桌面版时可用）
    if (route !== 'proxy') {
      try {
        const res = await fetch(abs, opts);
        if (res.status !== 403) {
          if (route === 'auto') route = 'direct';
          return finishRes(path, res);
        }
        lastErr = new Error('ComfyUI 拒绝了跨源请求（HTTP 403）');
      } catch (e) {
        lastErr = e;
      }
    }

    // 2) 走本地 serve.py 反代 /comfy?u=<目标>，绕开浏览器跨域限制
    try {
      const res = await fetch(loomProxy(abs), opts);
      if (res.status === 404) {
        let t = '';
        try { t = (await res.text()).slice(0, 120); } catch { }
        if (/File not found/i.test(t)) {
          throw new Error('本地 serve.py 没有 /comfy 代理（版本太旧），请重启 serve.py 后刷新页面');
        }
      }
      route = 'proxy';
      return finishRes(path, res);
    } catch (e) {
      if (e && /serve\.py/.test(e.message)) throw e;
      // 代理也不通时，优先报直连的错误（更有指向性）
      throw new Error(friendly(lastErr || e));
    }
  }

  /* ---------------- 基础 ---------------- */
  async function ping() {
    const res = await req('/system_stats');
    const j = await res.json().catch(() => ({}));
    return j;
  }

  async function objectInfo() {
    const res = await req('/object_info');
    return res.json();
  }

  let objCache = null, objAt = 0;
  async function objectInfoCached(maxAge = 864e5) {
    if (objCache && Date.now() - objAt < maxAge) return objCache;
    objCache = await objectInfo();
    objAt = Date.now();
    return objCache;
  }

  async function queueInfo() {
    const res = await req('/queue');
    return res.json();
  }

  /* ---------------- 上传参考图 ---------------- */
  async function uploadImage(blob, filename) {
    const fd = new FormData();
    const name = filename || `ref_${Date.now()}.png`;
    fd.append('image', blob, name);
    fd.append('overwrite', 'true');
    fd.append('type', 'input');
    const res = await req('/upload/image', { method: 'POST', body: fd });
    const j = await res.json();
    return j.name || name;
  }

  /* ---------------- 提交 ---------------- */
  const clientId = 'vault_' + Math.random().toString(36).slice(2, 10);

  async function queue(apiPrompt) {
    const res = await req('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: apiPrompt, client_id: clientId })
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    if (j.node_errors && Object.keys(j.node_errors).length) {
      const first = Object.values(j.node_errors)[0];
      throw new Error('工作流校验失败：' + (first?.errors?.[0]?.message || JSON.stringify(first).slice(0, 200)));
    }
    return j.prompt_id;
  }

  async function history(promptId) {
    const res = await req('/history/' + promptId);
    const j = await res.json();
    return j[promptId] || null;
  }

  function extractImages(entry) {
    const out = [];
    if (!entry?.outputs) return out;
    Object.values(entry.outputs).forEach(o => {
      (o.images || []).forEach(img => out.push(img));
      (o.gifs || []).forEach(img => out.push(img));
    });
    return out;
  }

  async function fetchImage(img) {
    const q = new URLSearchParams({
      filename: img.filename,
      subfolder: img.subfolder || '',
      type: img.type || 'output'
    });
    const res = await req('/view?' + q.toString());
    return res.blob();
  }

  /* ---------------- WebSocket 实时进度 ---------------- */
  let ws = null;
  let wsHook = null;
  const MAX_WAIT = 6 * 60 * 1000;

  function wsUrl() {
    return base().replace(/^http/, 'ws') + '/ws?clientId=' + encodeURIComponent(clientId);
  }

  function closeWs() {
    if (ws) { try { ws.close(); } catch { } ws = null; }
  }

  function onWsMessage(raw) {
    if (typeof raw !== 'string') return;            // 二进制预览帧直接跳过
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const d = m.data || {};
    // 只认自己这条队列的消息；老版本 ComfyUI 不带 prompt_id 时就不筛
    if (wsHook?.promptId && d.prompt_id && d.prompt_id !== wsHook.promptId) return;

    switch (m.type) {
      case 'execution_start':
        wsHook?.onProgress?.({ phase: 'start' });
        break;
      case 'executing':
        if (d.node == null) wsHook?.finish?.();
        else wsHook?.onProgress?.({ phase: 'node', node: d.node });
        break;
      case 'progress':
        wsHook?.onProgress?.({ phase: 'step', step: d.value, total: d.max, node: d.node });
        break;
      case 'execution_cached':
        wsHook?.onProgress?.({ phase: 'cached' });
        break;
      case 'execution_success':
        wsHook?.finish?.();
        break;
      case 'execution_error':
        wsHook?.fail?.(Object.assign(
          new Error('执行出错：' + (d.exception_message || d.node_type || '未知错误')),
          { fatal: true }
        ));
        break;
    }
  }

  function openWs(timeout = 4000) {
    if (ws && ws.readyState === 1) return Promise.resolve(true);
    closeWs();
    return new Promise((resolve, reject) => {
      let settled = false;
      let sock;
      try { sock = new WebSocket(wsUrl()); } catch (e) { return reject(e); }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch { }
        reject(new Error('WebSocket 连接超时'));
      }, timeout);

      sock.onopen = () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        ws = sock;
        resolve(true);
      };
      sock.onmessage = ev => onWsMessage(ev.data);
      sock.onerror = () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(new Error('WebSocket 连不上'));
      };
      sock.onclose = () => { if (ws === sock) ws = null; };
    });
  }

  /* ---------------- 取图 ---------------- */
  async function collectImages(images, onStatus) {
    onStatus('取图中…');
    const blobs = [];
    for (const img of images) {
      try { blobs.push({ meta: img, blob: await fetchImage(img) }); } catch { }
    }
    if (!blobs.length) throw new Error('图片下载失败');
    return blobs;
  }

  /** WS 说完成了，history 可能还差一拍，再补问几次 */
  async function waitEntry(promptId, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const e = await history(promptId);
      if (e && (e.outputs && Object.keys(e.outputs).length)) return e;
      if (e?.status?.completed) return e;
      await new Promise(r => setTimeout(r, 300));
    }
    return await history(promptId);
  }

  /**
   * 跑一次工作流
   * 优先走 WebSocket 拿 step 级进度，连不上就退回轮询
   * @param {object} apiPrompt   API 格式（{nodeId:{class_type,inputs}}）
   * @param {function} onStatus  (text, state, step, total)
   * @param {function} onProgress ({phase, step, total, node, elapsed})
   */
  async function run(apiPrompt, onStatus = () => { }, onProgress = () => { }) {
    onStatus('提交中…');
    const promptId = await queue(apiPrompt);
    onStatus('已排队，等待执行…');

    const started = Date.now();
    let viaWs = false;
    try { viaWs = await openWs(4000); } catch { viaWs = false; }

    if (viaWs) {
      let finished = false;
      let fatal = null;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Object.assign(new Error('等待超时'), { soft: true })), MAX_WAIT);
          wsHook = {
            promptId,
            onProgress: x => {
              if (x.phase === 'step') {
                const elapsed = Math.round((Date.now() - started) / 1000);
                onStatus(`生成中 ${x.step}/${x.total}`, 'running', x.step, x.total);
                onProgress({ ...x, elapsed });
              } else if (x.phase === 'start') {
                onStatus('开始执行…');
                onProgress(x);
              } else if (x.phase === 'node') {
                onProgress(x);
              }
            },
            finish: () => { clearTimeout(timer); finished = true; resolve(); },
            fail: e => { clearTimeout(timer); fatal = e; reject(e); }
          };
        });
      } catch (e) {
        if (fatal) { wsHook = null; throw fatal; }
        // 超时或连接断了 —— 退回轮询
      } finally {
        wsHook = null;
      }

      if (finished) {
        const entry = await waitEntry(promptId);
        const images = extractImages(entry);
        if (!images.length) throw new Error('执行结束但没有输出图片');
        return { promptId, images: await collectImages(images, onStatus), viaWs: true };
      }
    }

    // ---------------- 轮询兜底 ----------------
    let entry = null;
    while (Date.now() - started < MAX_WAIT) {
      await new Promise(r => setTimeout(r, 900));
      entry = await history(promptId);
      if (entry) {
        const st = entry.status;
        if (st?.status_str === 'error') {
          const msg = (st.messages || []).find(m => m[0] === 'execution_error');
          throw new Error('执行出错：' + (msg ? JSON.stringify(msg[1]).slice(0, 300) : '未知错误'));
        }
        if (st?.completed || extractImages(entry).length) break;
      }
      const sec = Math.round((Date.now() - started) / 1000);
      onStatus(`生成中… ${sec}s`);
    }

    const images = extractImages(entry);
    if (!images.length) throw new Error('执行结束但没有输出图片');
    return { promptId, images: await collectImages(images, onStatus), viaWs: false };
  }

  /* ---------------- UI 格式 → API 格式 ---------------- */
  const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
  const CONTROL_WORDS = new Set(['randomize', 'fixed', 'increment', 'decrement']);

  function isWidgetType(t) {
    if (Array.isArray(t)) return true;          // COMBO 的选项列表
    return WIDGET_TYPES.has(String(t));
  }

  /**
   * 把 ComfyUI 的 UI 格式工作流转成可提交的 API 格式
   * 依赖 /object_info 的节点定义（widget 顺序、类型、forceInput）
   * @returns {{api: object, stats: object, warnings: string[]}}
   */
  function uiToApi(uiWf, objectInfo) {
    if (!uiWf || !Array.isArray(uiWf.nodes)) throw new Error('这不是 UI 格式工作流');
    if (!objectInfo || typeof objectInfo !== 'object') throw new Error('缺少节点定义，先连上 ComfyUI');

    const nodesById = {};
    uiWf.nodes.forEach(n => { if (n && n.id != null) nodesById[n.id] = n; });

    // 某个节点的「连接型输入」名字顺序 —— target_slot 就是这个数组的下标
    const connNamesOf = (node) => {
      const def = objectInfo[node.type];
      if (!def) return [];
      const specs = { ...(def.input?.required || {}), ...(def.input?.optional || {}) };
      return Object.entries(specs)
        .filter(([, sp]) => {
          const t = Array.isArray(sp) ? sp[0] : sp;
          const o = (Array.isArray(sp) ? sp[1] : null) || {};
          return o.forceInput || !isWidgetType(t);
        })
        .map(([k]) => k);
    };

    // linkId → 来源节点/槽：[linkId, originId, originSlot, ...] 或对象形式
    const linkMap = {};
    (uiWf.links || []).forEach(l => {
      if (Array.isArray(l)) linkMap[l[0]] = { origin: l[1], slot: l[2] };
      else if (l && l.id != null) linkMap[l.id] = { origin: l.origin_id, slot: l.origin_slot };
    });

    // 每个节点收到的输入，键用 node.inputs 里的名字 —— 这样 widget 输入被链接也能覆盖到
    // （如 rgthree 的 Seed 节点连到 KSampler 的 seed widget 输入）
    const incoming = {};
    uiWf.nodes.forEach(tn => {
      if (!tn || tn.id == null) return;
      (tn.inputs || []).forEach(inp => {
        if (!inp || inp.link == null || !inp.name) return;
        const lm = linkMap[inp.link];
        if (!lm) return;
        (incoming[tn.id] = incoming[tn.id] || {})[inp.name] = [String(lm.origin), lm.slot];
      });
    });

    // links 数组兜底（node.inputs 缺失时，target_slot 按「连接型输入」顺序对号）
    (uiWf.links || []).forEach(l => {
      let oid, oslot, tid, tslot;
      if (Array.isArray(l)) { oid = l[1]; oslot = l[2]; tid = l[3]; tslot = l[4]; }
      else if (l && l.id != null) { oid = l.origin_id; oslot = l.origin_slot; tid = l.target_id; tslot = l.target_slot; }
      else return;
      const tn = nodesById[tid];
      if (!tn) return;
      const name = connNamesOf(tn)[tslot];
      if (!name || (incoming[tid] && incoming[tid][name])) return;
      (incoming[tid] = incoming[tid] || {})[name] = [String(oid), oslot];
    });

    // 旁路(mode 4)与 Reroute 节点不会被提交 —— 沿它们的第一条输入把连线直通过去
    // （例：UNET → 旁路LoRA → 旁路LoRA → LoRA，直通后等价于 UNET → LoRA）
    const isPassThrough = n => !!n && (n.mode === 4 || n.type === 'Reroute');
    const firstLinkOf = n => {
      for (const inp of (n.inputs || [])) {
        if (inp && inp.link != null && linkMap[inp.link]) {
          return [String(linkMap[inp.link].origin), linkMap[inp.link].slot];
        }
      }
      return null;
    };
    function resolveRef(oid, oslot) {
      for (let i = 0; i < 32; i++) {
        const on = nodesById[oid];
        if (!isPassThrough(on)) return [oid, oslot];
        const nxt = firstLinkOf(on);
        if (!nxt) return null;
        [oid, oslot] = nxt;
      }
      return null;
    }

    const api = {};
    const warnings = [];
    let widgetCount = 0, linkedCount = 0;

    for (const node of uiWf.nodes) {
      if (!node || node.type == null) continue;
      // 纯前端节点不提交
      if (['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'].includes(node.type)) continue;
      if (node.mode === 2) { warnings.push(`${node.type} 已静音，已跳过`); continue; }
      if (node.mode === 4) { warnings.push(`${node.type} 已旁路，连线已直通到它的上游`); continue; }

      const def = objectInfo[node.type];
      if (!def) throw new Error(`ComfyUI 里找不到节点「${node.type}」，确认对应插件已安装`);

      const specs = { ...(def.input?.required || {}), ...(def.input?.optional || {}) };
      const values = Array.isArray(node.widgets_values)
        ? [...node.widgets_values]
        : (node.widgets_values ? Object.values(node.widgets_values) : []);
      let wi = 0;

      // node.inputs 里已连线的槽（兜底用）
      const linkedBySlot = {};
      (node.inputs || []).forEach(inp => {
        if (inp && inp.link != null && inp.name) linkedBySlot[inp.name] = inp.link;
      });

      const inputs = {};
      const takeLink = (name, raw) => {
        const r = resolveRef(raw[0], raw[1]);
        if (!r) return false;
        inputs[name] = r;
        linkedCount++;
        return true;
      };
      for (const [name, spec] of Object.entries(specs)) {
        const type = Array.isArray(spec) ? spec[0] : spec;
        const opts = (Array.isArray(spec) ? spec[1] : null) || {};
        const widgetish = !opts.forceInput && isWidgetType(type);
        // widget 输入即使被链接，widgets_values 里仍占一位（seed 后面还跟着 randomize/fixed 控制项）
        const bumpWidget = () => {
          if (!widgetish || wi >= values.length) return;
          wi++;
          const ctrl = values[wi];
          if (typeof ctrl === 'string' && CONTROL_WORDS.has(ctrl)) wi++;
        };

        // 1) 已连线的输入：解析直通后引用上游节点
        const raw = (incoming[node.id] || {})[name];
        if (raw && takeLink(name, raw)) { bumpWidget(); continue; }
        // 2) node.inputs 兜底
        if (!raw && linkedBySlot[name] != null && linkMap[linkedBySlot[name]]) {
          const l = linkMap[linkedBySlot[name]];
          if (takeLink(name, [String(l.origin), l.slot])) { bumpWidget(); continue; }
        }
        if (opts.forceInput) continue;
        if (!isWidgetType(type)) continue;

        // 3) 其余按顺序吃 widgets_values
        if (wi < values.length) {
          inputs[name] = values[wi++];
          widgetCount++;
          // seed 之类后面跟一个控制项（randomize / fixed…），占一个 widget 位
          const ctrl = values[wi];
          if (typeof ctrl === 'string' && CONTROL_WORDS.has(ctrl)) wi++;
        } else if ('default' in opts) {
          inputs[name] = opts.default;
        }
      }

      api[String(node.id)] = {
        class_type: node.type,
        inputs,
        _meta: { title: node.title || node.type }
      };
    }

    const ids = Object.keys(api);
    if (!ids.length) throw new Error('转换后没有可执行的节点');

    ids.forEach(id => {
      Object.entries(api[id].inputs).forEach(([k, v]) => {
        if (Array.isArray(v) && !api[v[0]]) {
          warnings.push(`节点 ${id} 的 ${k} 指向了未提交的节点 ${v[0]}`);
        }
      });
    });

    return {
      api,
      stats: { nodes: ids.length, widgets: widgetCount, links: linkedCount },
      warnings
    };
  }

  /* ---------------- 工作流工具 ---------------- */
  /**
   * 在 API 格式里找采样器与正负提示词节点
   */
  function analyzeApi(api) {
    const nodes = Object.entries(api || {}).filter(([, n]) => n && n.class_type);
    const find = cls => nodes.filter(([, n]) => n.class_type === cls);

    const sampler = (find('KSampler')[0] || find('KSamplerAdvanced')[0] || find('SamplerCustom')[0] || [])[1];
    let positive = '', negative = '';
    if (sampler) {
      positive = refId(sampler.inputs?.positive);
      negative = refId(sampler.inputs?.negative);
    }
    const clipNodes = nodes.filter(([, n]) => /CLIPTextEncode/i.test(n.class_type));
    if (!positive && clipNodes[0]) positive = clipNodes[0][0];
    if (!negative && clipNodes[1]) negative = clipNodes[1][0];

    const ckpt = (find('CheckpointLoaderSimple')[0] || find('UNETLoader')[0] || [])[1];

    // 所有 LoadImage，按节点 id 升序 —— 多参考图按这个顺序依次填入
    const imageIds = nodes
      .filter(([, n]) => n.class_type === 'LoadImage')
      .map(([id]) => id)
      .sort((a, b) => (Number(a) || 0) - (Number(b) || 0));

    return {
      positiveId: positive || '',
      negativeId: negative || '',
      imageId: imageIds[0] || '',
      imageIds,
      model: ckpt?.inputs?.ckpt_name || ckpt?.inputs?.unet_name || '',
      nodeCount: nodes.length
    };
  }

  function refId(ref) {
    if (Array.isArray(ref)) return String(ref[0]);
    if (typeof ref === 'string') return ref;
    return '';
  }

  /**
   * 把正向/负向文本、参考图写进 API 工作流（返回新对象，不改原对象）
   */
  /**
   * 把提示词与参考图写进 API 工作流
   * @param {string[]} images  参考图文件名数组，按顺序填进各个 LoadImage 节点
   */
  function applyInputs(api, { prompt, negative, images }) {
    const next = JSON.parse(JSON.stringify(api));
    const info = analyzeApi(next);
    const list = Array.isArray(images) ? images.filter(Boolean) : (images ? [images] : []);

    if (prompt && info.positiveId && next[info.positiveId]) {
      const n = next[info.positiveId];
      if (n.inputs && 'text' in n.inputs) n.inputs.text = prompt;
    }
    if (negative && info.negativeId && next[info.negativeId]) {
      const n = next[info.negativeId];
      if (n.inputs && 'text' in n.inputs) n.inputs.text = negative;
    }

    // 多参考图：按 LoadImage 节点顺序依次填
    const used = Math.min(list.length, info.imageIds.length);
    for (let i = 0; i < used; i++) {
      const nid = info.imageIds[i];
      if (next[nid] && next[nid].inputs) next[nid].inputs.image = list[i];
    }

    return {
      api: next,
      used,
      slots: info.imageIds.length,
      dropped: Math.max(0, list.length - info.imageIds.length)
    };
  }

  return {
    load, save, cfg: () => cfg, base,
    ping, objectInfo, objectInfoCached, queueInfo, uiToApi,
    uploadImage, queue, history, fetchImage, run,
    openWs, closeWs, wsConnected: () => !!ws && ws.readyState === 1,
    analyzeApi, applyInputs, extractImages
  };
})();
