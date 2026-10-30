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

  async function req(path, opts = {}) {
    let res;
    try {
      res = await fetch(url(path), opts);
    } catch (e) {
      throw new Error(friendly(e));
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { }
      throw new Error(`ComfyUI ${path} → HTTP ${res.status}${detail ? ' · ' + detail : ''}`);
    }
    return res;
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

  /**
   * 跑一次工作流
   * @param {object} apiPrompt   API 格式（{nodeId:{class_type,inputs}}）
   * @param {function} onStatus  状态回调 (text)
   */
  async function run(apiPrompt, onStatus = () => { }) {
    onStatus('提交中…');
    const promptId = await queue(apiPrompt);
    onStatus('已排队，等待执行…');

    const started = Date.now();
    let entry = null;
    while (Date.now() - started < 6 * 60 * 1000) {
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
    onStatus('取图中…');
    const blobs = [];
    for (const img of images) {
      try { blobs.push({ meta: img, blob: await fetchImage(img) }); } catch { }
    }
    if (!blobs.length) throw new Error('图片下载失败');
    return { promptId, images: blobs };
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

    // 从 links 反查每个节点收到的输入：[linkId, originId, originSlot, targetId, targetSlot, type]
    const incoming = {};
    (uiWf.links || []).forEach(l => {
      let oid, oslot, tid, tslot;
      if (Array.isArray(l)) { oid = l[1]; oslot = l[2]; tid = l[3]; tslot = l[4]; }
      else if (l && l.id != null) { oid = l.origin_id; oslot = l.origin_slot; tid = l.target_id; tslot = l.target_slot; }
      else return;
      const tn = nodesById[tid];
      if (!tn) return;
      const name = connNamesOf(tn)[tslot];
      if (!name) return;
      (incoming[tid] = incoming[tid] || {})[name] = [String(oid), oslot];
    });

    // 补充：node.inputs 里带 link 的（links 数组缺失时的兜底）
    const linkMap = {};
    (uiWf.links || []).forEach(l => {
      if (Array.isArray(l)) linkMap[l[0]] = { origin: l[1], slot: l[2] };
      else if (l && l.id != null) linkMap[l.id] = { origin: l.origin_id, slot: l.origin_slot };
    });

    const api = {};
    const warnings = [];
    let widgetCount = 0, linkedCount = 0;

    for (const node of uiWf.nodes) {
      if (!node || node.type == null) continue;
      // 纯前端节点不提交
      if (['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'].includes(node.type)) continue;
      if (node.mode === 2) { warnings.push(`${node.type} 已静音，已跳过`); continue; }
      if (node.mode === 4) { warnings.push(`${node.type} 已旁路，已跳过`); continue; }

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
      for (const [name, spec] of Object.entries(specs)) {
        const type = Array.isArray(spec) ? spec[0] : spec;
        const opts = (Array.isArray(spec) ? spec[1] : null) || {};

        // 1) links 反查优先
        if (incoming[node.id] && incoming[node.id][name]) {
          inputs[name] = incoming[node.id][name];
          linkedCount++;
          continue;
        }
        // 2) node.inputs 兜底
        if (linkedBySlot[name] != null && linkMap[linkedBySlot[name]]) {
          const l = linkMap[linkedBySlot[name]];
          inputs[name] = [String(l.origin), l.slot];
          linkedCount++;
          continue;
        }
        if (opts.forceInput) continue;
        if (!isWidgetType(type)) continue;

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
    analyzeApi, applyInputs, extractImages
  };
})();
