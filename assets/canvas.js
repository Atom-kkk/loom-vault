/* ============================================================
   canvas.js — 无限画布
   · 平移缩放、节点拖拽、连线、删除
   · 节点：图片 / 提示词 / 参考图 / 生成（ComfyUI）/ 工作流节点
   · 上传 ComfyUI 工作流 → 自动识别节点与连线铺到画布
   ============================================================ */

window.Canvas = (function () {
  'use strict';

  const V = window.Vault;
  const esc = U.esc;

  let cv = null;          // 当前画布
  let host = null;        // #view 容器
  let world = null;       // 世界层
  let edgeLayer = null;   // SVG 层
  let list = [];          // 画布列表
  let selected = new Set();
  let drag = null;
  let link = null;        // {from, x, y}
  let spaceDown = false;
  let globalsBound = false;
  let saveTimer = null;
  let boxSel = null;      // 框选中的矩形（屏幕坐标）
  let clipboard = null;   // 复制出来的节点快照

  const MIN_K = 0.2, MAX_K = 2.4;

  /* ============================================================
     数据
     ============================================================ */
  function newCanvas(name) {
    return {
      id: U.uid('cv'),
      name: name || '未命名画布',
      nodes: [],
      edges: [],
      view: { x: 80, y: 60, k: 1 },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  async function loadList() {
    list = (await DB.getAll('canvases')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  }

  async function persist() {
    if (!cv) return;
    cv.updatedAt = Date.now();
    await DB.put('canvases', JSON.parse(JSON.stringify(cv)));
    const i = list.findIndex(c => c.id === cv.id);
    if (i >= 0) list[i] = cv; else list.unshift(cv);
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persist().catch(() => { }), 500);
  }

  const nodeById = id => cv.nodes.find(n => n.id === id);

  /* ---------------- 撤销 / 重做 ---------------- */
  const HIST_MAX = 60;
  let undoStack = [], redoStack = [], histLock = false;

  const snapshot = () => (cv ? JSON.stringify({ n: cv.nodes, e: cv.edges }) : '{}');

  function pushHistory() {
    if (histLock || !cv) return;
    const s = snapshot();
    if (undoStack[undoStack.length - 1] === s) return;   // 连续同状态不重复压栈
    undoStack.push(s);
    if (undoStack.length > HIST_MAX) undoStack.shift();
    redoStack.length = 0;
  }

  function restoreSnapshot(raw) {
    if (!cv || !raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    histLock = true;
    cv.nodes = data.n || [];
    cv.edges = data.e || [];
    selected.clear();
    renderAll();
    queueSave();
    histLock = false;
  }

  function undo() {
    if (!undoStack.length) return V.toast('没有可撤销的操作');
    redoStack.push(snapshot());
    restoreSnapshot(undoStack.pop());
    V.toast('已撤销');
  }

  function redo() {
    if (!redoStack.length) return V.toast('没有可重做的操作');
    undoStack.push(snapshot());
    restoreSnapshot(redoStack.pop());
    V.toast('已重做');
  }

  /* ---------------- 图片地址（blob 地址重开即失效，需要重新解析） ---------------- */
  const urlCache = new Map();

  async function urlForBlob(blobId) {
    if (!blobId) return '';
    if (urlCache.has(blobId)) return urlCache.get(blobId);
    const u = await V.blobURL(blobId);
    if (u) urlCache.set(blobId, u);
    return u || '';
  }

  /** 节点可能只记了图库编号，先补出 blobId */
  function blobIdOf(n) {
    if (n.data.blobId) return n.data.blobId;
    const img = (V.state.images || []).find(i => i.id === n.data.imageId);
    if (img?.blobId) { n.data.blobId = img.blobId; return img.blobId; }
    return '';
  }

  /** 进画布时把失效的 blob 地址换掉，否则重开一张图都看不见 */
  async function ensureUrls() {
    let changed = false;
    for (const n of (cv?.nodes || [])) {
      if (n.type !== 'image' && n.type !== 'ref' && n.type !== 'simple') continue;
      const bid = blobIdOf(n);
      if (!bid) continue;
      const u = await urlForBlob(bid);
      if (u && n.data.src !== u) { n.data.src = u; changed = true; }
    }
    if (changed) renderAll();
  }

  /** 参考库节点按需换成高清原图；自己图库里的图本来就是原图，不重复下载 */
  async function ensureHiRes(reset = false) {
    if (!window.REF?.hiRes || !cv) return;
    const target = cv;
    for (const n of target.nodes) {
      if (n.type !== 'ref' || !n.data.refId || n.data.blobId) continue;
      if (reset) n.data.hiSrc = '';
      const url = await REF.hiRes(n.data.refId);
      if (!url || cv !== target || !cv.nodes.includes(n)) continue;
      if (n.data.hiSrc !== url) {
        n.data.hiSrc = url;
        const img = world?.querySelector(`.cv-node[data-id="${n.id}"] .cv-img`);
        if (img) img.src = url;
        queueSave();
      }
    }
  }

  /* ---------------- 从图库送往画布 ---------------- */
  async function ensureCanvas() {
    await loadList();
    if (!cv) cv = list[0] || newCanvas();
    if (!list.find(x => x.id === cv.id)) list.unshift(cv);
    return cv;
  }

  /** 参考图 id → 缩略图相对路径（服装编号形如 SPR-0001，人脸是 11 位 hash） */
  function refThumbPath(id) {
    if (!id) return '';
    return /^[A-Z]{2,4}-\d+$/.test(id)
      ? `reference/outfits/${id}.webp`
      : `reference/faces/${id}.webp`;
  }

  function rightEdgeOf() {
    return cv.nodes.reduce((m, n) => Math.max(m, n.x + (n.w || 240)), -Infinity);
  }

  /**
   * 把图库里的一张图送进画布
   * @param {object} img   图库记录
   * @param {'ref'|'image'|'rerun'} mode
   */
  async function sendImage(img, mode = 'ref') {
    if (!img) return;
    await ensureCanvas();

    if (mode === 'ref' || mode === 'image') {
      const src = await urlForBlob(img.blobId);
      if (!src) return V.toast('原图不在本地了', 'err');
      const base = rightEdgeOf();
      const n = {
        id: U.uid('n'),
        type: mode,
        x: Number.isFinite(base) ? base + 90 : 60,
        y: 60,
        w: mode === 'ref' ? 200 : 240,
        data: {
          src, label: img.id,
          imageId: img.id, refId: img.id, blobId: img.blobId
        }
      };
      pushHistory();
      cv.nodes.push(n);
      await persist();
      V.go('canvas');
      setTimeout(() => { fitView(); }, 200);
      V.toast(mode === 'ref' ? `${img.id} 已作为参考图加入画布` : `${img.id} 已加入画布`, 'ok');
      return;
    }

    // ---- 用这套参数复现：铺「正向/负向提示词 → 输出」三节点，参考图挂到输出 ----
    const pv = (img.prompts || []).find(v => v.id === img.activePromptId)
      || (img.prompts || []).slice(-1)[0] || {};
    const text = pv.text || img.promptNodeText || '';
    const neg = pv.negative || '';

    const wf = (V.state.workflows || []).find(w => w.id === img.workflowId);

    pushHistory();
    const out = addSimpleFlow(wf ? wf.id : '', {
      pos: { x: 90, y: 100 },
      text,
      neg
    });

    // 原图的参考图挂到输出节点上
    const refs = (img.refIds || []).filter(Boolean);
    refs.forEach((rid, i) => {
      const rn = addNode('ref', {
        pos: { x: 90, y: 520 + i * 210 },
        data: { src: refThumbPath(rid), label: rid, refId: rid }
      });
      cv.edges.push({ id: U.uid('e'), from: rn.id, to: out.id });
    });

    if (!wf) V.toast('原图没有关联工作流，输出节点需要手动绑定一个', 'err');

    await persist();
    V.go('canvas');
    setTimeout(() => { fitView(); }, 200);
  }

  /* ============================================================
     视图注册
     ============================================================ */
  V.registerView('canvas', {
    title: '无限画布',
    sub: () => cv ? `${cv.name} · ${cv.nodes.length} 个节点` : '自由摆放节点，连起来就能跑 ComfyUI',
    upload: false,
    actions: () => `
      <button class="btn" data-cv="import-wf">${V.icon('flow', 14)} 导入工作流</button>
      <button class="btn" data-cv="pack">${V.icon('layers', 14)} 简易节点包</button>
      <button class="btn" data-cv="outputs">${V.icon('img', 14)} 引擎出图</button>
      <button class="btn" data-cv="adv">${V.icon('cpu', 14)} 高级选项</button>
      <button class="btn" data-cv="list">${V.icon('layers', 14)} 画布</button>`,
    render: async (c) => {
      host = c;
      c.classList.add('cv-host');
      await loadList();
      if (!cv) cv = list[0] || newCanvas();
      if (!list.find(x => x.id === cv.id)) list.unshift(cv);
      buildShell(c);
      renderAll();
      resumePending();     // 刷新前提交的任务，进来就接回去
      await ensureUrls();
      ensureHiRes(true);   // 后台换原图，不阻塞画布
    }
  });

  /* ============================================================
     DOM 骨架
     ============================================================ */
  function buildShell(c) {
    c.innerHTML = `
      <div class="cv-wrap" id="cv-wrap">
        <div class="cv-viewport" id="cv-viewport">
          <div class="cv-world" id="cv-world">
            <svg class="cv-edges" id="cv-edges"></svg>
          </div>
        </div>
        <div class="cv-hud">
          <button class="cv-tool cv-exit" data-cv="exit" title="退出画布（Esc）">${V.icon('back', 15)}<span>图库</span></button>
          <div class="cv-hud-sep"></div>
          <button class="cv-tool" data-cv="undo" title="撤销 (⌘Z)">${V.icon('undo', 15)}</button>
          <button class="cv-tool" data-cv="redo" title="重做 (⇧⌘Z)">${V.icon('redo', 15)}</button>
          <div class="cv-hud-sep"></div>
          <button class="cv-tool" data-cv="fit" title="适应窗口">${V.icon('search', 15)}</button>
          <button class="cv-tool" data-cv="reset" title="100%">${V.icon('back', 15)}</button>
          <button class="cv-zoom" id="cv-zoom" data-cv="zoom100" title="回到 100%（点一下）">100%</button>
        </div>
        <div class="cv-map" id="cv-map" title="小地图：点一下跳过去">
          <canvas id="cv-map-cv" width="200" height="140"></canvas>
        </div>
        <div class="cv-hint" id="cv-hint">
          拖动空白处平移 · 滚轮缩放 · <b>Shift+拖拽</b> 框选 · <b>⌘C/⌘V</b> 复制粘贴 · Delete 删除 · Esc 退出画布
        </div>
      </div>`;

    host = c;
    world = c.querySelector('#cv-world');
    edgeLayer = c.querySelector('#cv-edges');

    bindCanvasEvents(c);
    bindMinimap();
  }

  /* ============================================================
     渲染
     ============================================================ */
  /** 画布只显示「正向提示词 / 负向提示词 / 输出 / 参考图」，完整工作流节点图(wf)不显示 */
  function visibleNode(n) {
    return n.type !== 'wf';
  }

  function renderAll() {
    if (!cv || !world) return;
    // 老版本画布 / 外部写入的数据可能缺字段，缺一个 view 就会让整个画布视图崩掉
    if (!Array.isArray(cv.nodes)) cv.nodes = [];
    if (!Array.isArray(cv.edges)) cv.edges = [];
    if (!cv.view || typeof cv.view.x !== 'number') cv.view = { x: 80, y: 60, k: 1 };
    world.style.transform = `translate(${cv.view.x}px, ${cv.view.y}px) scale(${cv.view.k})`;
    const zoomEl = host.querySelector('#cv-zoom');
    if (zoomEl) zoomEl.textContent = Math.round(cv.view.k * 100) + '%';

    world.querySelectorAll('.cv-node').forEach(n => n.remove());
    cv.nodes.filter(visibleNode).forEach(n => world.appendChild(makeNodeEl(n)));
    renderEdges();

    const sub = document.querySelector('#view-sub');
    if (sub) {
      const vis = cv.nodes.filter(visibleNode).length;
      sub.textContent = `${cv.name} · ${vis} 个节点`;
    }
    drawMinimap();
  }

  function makeNodeEl(n) {
    const d = document.createElement('div');
    d.className = `cv-node node-${n.type}${selected.has(n.id) ? ' sel' : ''}`;
    d.style.left = n.x + 'px';
    d.style.top = n.y + 'px';
    d.dataset.id = n.id;
    if (n.w) d.style.width = n.w + 'px';
    if (n.h) d.style.height = n.h + 'px';

    const tagText = n.type === 'wf'
      ? '#' + (n.data.rawId ?? n.data.apiId ?? '')
      : typeLabel(n.type);
    const head = `<div class="cv-node-head">
        <span class="cv-tag">${esc(tagText)}</span>
        <span class="cv-title">${esc(nodeTitle(n))}</span>
        <div class="cv-head-ops">
          ${n.type === 'gen' ? `<button class="cv-mini" data-cvnode="addref" title="加一个参考图节点">${V.icon('img', 13)}</button>` : ''}
          ${n.type === 'gen' ? `<button class="cv-mini" data-cvnode="run" title="生成">${V.icon('spark', 13)}</button>` : ''}
          ${n.type === 'image' || n.type === 'ref' ? `<button class="cv-mini" data-cvnode="replace" title="换图">${V.icon('upload', 13)}</button>` : ''}
          ${n.type === 'image' || n.type === 'ref' ? `<button class="cv-mini${n.data.maskSrc ? ' on' : ''}" data-cvnode="mask" title="画重绘遮罩">${V.icon('edit', 13)}</button>` : ''}
          <button class="cv-mini" data-cvnode="del" title="删除">${V.icon('close', 13)}</button>
        </div>
      </div>`;

    let body = '';
    if (n.type === 'prompt') {
      body = `<div class="cv-role">
          ${['正向', '负向'].map(r => `<button class="cv-role-btn ${n.data.role === r ? 'on' : ''}" data-role="${r}">${r}</button>`).join('')}
        </div>
        <textarea class="cv-text" data-cvtext placeholder="写提示词…">${esc(n.data.text || '')}</textarea>`;
    } else if (n.type === 'image' || n.type === 'ref') {
      const shownSrc = n.type === 'ref' ? (n.data.hiSrc || n.data.src) : n.data.src;
      body = shownSrc
        ? `<img class="cv-img" src="${esc(shownSrc)}" alt="">`
        : `<div class="cv-drop">${V.icon('img', 26)}<span>双击或点右上角上传图片</span></div>`;
      if (n.data.maskSrc) {
        body += `<div class="cv-mask-chip" title="已加遮罩：白色区域会被重绘">${V.icon('edit', 11)}遮罩</div>`;
      }
    } else if (n.type === 'gen') {
      const st = n.data.status || 'idle';
      const refCount = (cv ? cv.edges.filter(e => e.to === n.id) : [])
        .map(e => nodeById(e.from))
        .filter(x => x && (x.type === 'ref' || x.type === 'image')).length;
      const slots = n.data.imageSlots || 0;
      const refTxt = refCount
        ? `${refCount} 张参考图${slots ? ' / ' + slots + ' 位' : ''}`
        : (slots ? `${slots} 个图位` : '');
      body = `
        <div class="cv-gen-body">
          ${n.data.resultSrc
            ? `<img class="cv-img" src="${esc(n.data.resultSrc)}" alt="">`
            : `<div class="cv-drop">${V.icon('spark', 24)}<span>${st === 'running' ? '生成中…' : '还没有结果'}</span></div>`}
        </div>
        <div class="cv-gen-meta">
          <span>${esc(wfLabel(n))}</span>
          <span>${esc(refTxt || n.data.model || '')}</span>
        </div>
        ${slotChips(n)}
        ${batchRow(n)}
        ${st === 'running' && n.data.prog
          ? `<div class="cv-prog"><i style="width:${Math.min(100, Math.max(2, Math.round(n.data.prog.step / Math.max(1, n.data.prog.total) * 100)))}%"></i></div>`
          : ''}
        ${n.data.statusText ? `<div class="cv-gen-status ${st}">${esc(n.data.statusText)}</div>` : ''}
        <button class="cv-run" data-cvnode="run" ${st === 'running' ? 'disabled' : ''}>
          ${st === 'running' ? '<span class="spinner"></span> 生成中' : '生成'}
        </button>
        ${st === 'running' ? '<button class="cv-cancel" data-cvnode="cancel">取消</button>' : ''}
        ${st === 'error' ? '<button class="cv-cancel retry" data-cvnode="retry">重试</button>' : ''}`;
    } else if (n.type === 'simple') {
      const st = n.data.status || 'idle';
      const slots = n.data.imageSlots || 0;
      const pct = n.data.prog ? Math.min(100, Math.max(2, Math.round(n.data.prog.step / Math.max(1, n.data.prog.total) * 100))) : 0;
      body = `
        <textarea class="cv-text" data-cvtext placeholder="写提示词…（想要什么）">${esc(n.data.text || '')}</textarea>
        <textarea class="cv-text sm" data-cvneg placeholder="负向提示词 · 不想要什么（可留空）">${esc(n.data.neg || '')}</textarea>
        <div class="cv-simple-ref" data-cvnode="pick" title="点一下放参考图">
          ${n.data.src
    ? `<img class="cv-img sm" src="${esc(n.data.src)}" alt="">`
    : `<div class="cv-drop sm">${V.icon('img', 20)}<span>${slots ? '放参考图（可留空）' : '这套工作流没有图位'}</span></div>`}
        </div>
        ${n.data.status === 'done' && n.data.resultSrc ? `<img class="cv-img" src="${esc(n.data.resultSrc)}" alt="">` : ''}
        <div class="cv-gen-meta" title="点这里换工作流">
          <span>${esc(wfLabel(n))}</span>
          <span>${slots ? slots + ' 个图位' : '纯文生图'}</span>
        </div>
        ${slotChips(n)}
        ${batchRow(n)}
        ${st === 'running' && n.data.prog ? `<div class="cv-prog"><i style="width:${pct}%"></i></div>` : ''}
        ${n.data.statusText ? `<div class="cv-gen-status ${st}">${esc(n.data.statusText)}</div>` : ''}
        <button class="cv-run" data-cvnode="run" ${st === 'running' ? 'disabled' : ''}>
          ${st === 'running' ? '<span class="spinner"></span> 生成中' : '生成'}
        </button>
        ${st === 'running' ? '<button class="cv-cancel" data-cvnode="cancel">取消</button>' : ''}
        ${st === 'error' ? '<button class="cv-cancel retry" data-cvnode="retry">重试</button>' : ''}`;
    } else if (n.type === 'group') {
      const items = groupItems(n);
      const act = Math.min(items.length - 1, Math.max(0, Number(n.data.active) || 0));
      const cur = items[act] || {};
      body = `
        <div class="cv-group-main">
          ${cur.src
            ? `<img class="cv-img" src="${esc(cur.src)}" alt="">`
            : `<div class="cv-drop">${V.icon('img', 24)}<span>空图片组</span></div>`}
          ${items.length > 1 ? `<span class="cv-group-count">${act + 1} / ${items.length}</span>` : ''}
        </div>
        ${items.length > 1
            ? `<div class="cv-group-strip">${items.map((it, i) =>
              `<img class="cv-thumb${i === act ? ' on' : ''}" data-cvnode="g-pick" data-i="${i}" src="${esc(it.src)}" alt="">`).join('')}</div>`
            : ''}
        <div class="cv-group-ops">
          <button data-cvnode="g-expand">展开</button>
          <button data-cvnode="g-split">拆开</button>
        </div>`;
    } else if (n.type === 'wf') {
      const keys = n.data.keys;
      const vals = n.data.widgets || [];
      const off = n.data.mode === 4;
      body = `<div class="cv-wf${off ? ' bypassed' : ''}">
          ${n.data.title !== n.data.cls ? `<div class="cv-wf-cls">${esc(n.data.cls || '')}</div>` : ''}
          ${keys && keys.length
    ? `<div class="cv-wf-rows">${keys.map((k, i) => {
      const vi = (n.data.slots && n.data.slots[i] != null) ? n.data.slots[i] : i;
      const v = vals[vi];
      const isLink = !!(n.data.linked && n.data.linked[k]);
      const long = typeof v === 'string' && v.length > 24;
      const num = typeof v === 'number';
      return `<label class="cv-wf-row">
                <span>${esc(k)}</span>
                ${isLink
        ? `<i class="cv-wf-linked">由连线提供</i>`
        : long
          ? `<textarea rows="2" data-cvw="${i}">${esc(String(v ?? ''))}</textarea>`
          : `<input type="${num ? 'number' : 'text'}" data-cvw="${i}" value="${esc(String(v ?? ''))}">`}
              </label>`;
    }).join('')}</div>`
    : (vals.length ? `<div class="cv-wf-w">${vals.slice(0, 8).map(w =>
      `<div><b>${esc(String(w).slice(0, 60))}</b></div>`).join('')}</div>` : '')}
          ${n.data.outputs?.length || off
    ? `<div class="cv-wf-io">出 ${n.data.outputs?.length || 0} · 入 ${n.data.inputs?.length || 0}${off ? ' · <b>已旁路</b>' : ''}</div>`
    : ''}
        </div>`;
    }

    d.innerHTML = head + body + `
      <div class="cv-port in" data-port="in"></div>
      ${n.type !== 'gen' || true ? `<div class="cv-port out" data-port="out"></div>` : ''}
      <i class="cv-resize" data-resize="se" title="拖这里自由缩放"></i>`;

    bindNodeEvents(d, n);
    return d;
  }

  /* ---------------- 小地图 ---------------- */
  const NODE_COLOR = {
    prompt: 'rgba(150,140,200,.9)', gen: 'rgba(214,120,145,.95)', simple: 'rgba(214,120,145,.95)',
    image: 'rgba(110,170,155,.9)', ref: 'rgba(200,160,110,.9)', group: 'rgba(110,150,200,.9)',
    wf: 'rgba(140,140,140,.7)'
  };

  function visibleBoxes() {
    const out = [];
    (cv ? cv.nodes : []).forEach(n => {
      if (!visibleNode(n)) return;
      const el = world && world.querySelector(`.cv-node[data-id="${n.id}"]`);
      const w = n.w || (el && el.offsetWidth) || 240;
      const h = n.h || (el && el.offsetHeight) || 150;
      out.push({ n, x: n.x, y: n.y, w, h });
    });
    return out;
  }

  function drawMinimap() {
    const wrap = host && host.querySelector('#cv-map');
    const cvs = host && host.querySelector('#cv-map-cv');
    if (!wrap || !cvs || !cv) return;
    const ctx = cvs.getContext('2d');
    const W = cvs.width, H = cvs.height;
    ctx.clearRect(0, 0, W, H);

    const boxes = visibleBoxes();
    const vp = host.querySelector('#cv-viewport');
    const vpW = vp ? vp.clientWidth : 800;
    const vpH = vp ? vp.clientHeight : 600;
    // 视口在世界里的矩形
    const viewRect = {
      x: -cv.view.x / cv.view.k,
      y: -cv.view.y / cv.view.k,
      w: vpW / cv.view.k,
      h: vpH / cv.view.k
    };

    let minX = viewRect.x, minY = viewRect.y, maxX = viewRect.x + viewRect.w, maxY = viewRect.y + viewRect.h;
    boxes.forEach(b => {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    });
    const pad = 60;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const k = Math.min(W / bw, H / bh);
    const ox = (W - bw * k) / 2 - minX * k;
    const oy = (H - bh * k) / 2 - minY * k;
    const toMap = (x, y) => ({ x: x * k + ox, y: y * k + oy });

    wrap.dataset.k = String(k);
    wrap.dataset.ox = String(ox);
    wrap.dataset.oy = String(oy);

    boxes.forEach(b => {
      const p = toMap(b.x, b.y);
      ctx.fillStyle = NODE_COLOR[b.n.type] || 'rgba(150,150,150,.8)';
      const w = Math.max(2, b.w * k), h = Math.max(2, b.h * k);
      ctx.fillRect(p.x, p.y, w, h);
      if (selected.has(b.n.id)) {
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x - 0.5, p.y - 0.5, w + 1, h + 1);
      }
    });

    const v = toMap(viewRect.x, viewRect.y);
    ctx.strokeStyle = 'rgba(120,120,120,.95)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(v.x, v.y, viewRect.w * k, viewRect.h * k);
  }

  function bindMinimap() {
    const wrap = host && host.querySelector('#cv-map');
    const cvs = host && host.querySelector('#cv-map-cv');
    if (!wrap || !cvs) return;
    let dragging = false;
    const jump = e => {
      const r = cvs.getBoundingClientRect();
      const mx = (e.clientX - r.left) * (cvs.width / r.width);
      const my = (e.clientY - r.top) * (cvs.height / r.height);
      const k = Number(wrap.dataset.k) || 0.1;
      const ox = Number(wrap.dataset.ox) || 0;
      const oy = Number(wrap.dataset.oy) || 0;
      const wx = (mx - ox) / k, wy = (my - oy) / k;
      const vp = host.querySelector('#cv-viewport');
      cv.view.x = (vp ? vp.clientWidth : 800) / 2 - wx * cv.view.k;
      cv.view.y = (vp ? vp.clientHeight : 600) / 2 - wy * cv.view.k;
      applyTransform();
      drawMinimap();
    };
    cvs.addEventListener('pointerdown', e => {
      e.stopPropagation();
      dragging = true;
      jump(e);
      try { cvs.setPointerCapture(e.pointerId); } catch { }
    });
    cvs.addEventListener('pointermove', e => { if (dragging) jump(e); });
    cvs.addEventListener('pointerup', () => { dragging = false; queueSave(); });
    cvs.addEventListener('wheel', e => e.stopPropagation());
  }

  /* ---------------- 框选 ---------------- */
  function startBoxSelect(e) {
    const vp = host.querySelector('#cv-viewport');
    const r = vp.getBoundingClientRect();
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    boxSel = { x0, y0, x1: x0, y1: y0, add: e.shiftKey && e.altKey };
    let el = host.querySelector('#cv-box');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cv-box';
      el.className = 'cv-box';
      vp.appendChild(el);
    }
    el.style.display = 'block';
    el.style.left = x0 + 'px';
    el.style.top = y0 + 'px';
    el.style.width = '0px';
    el.style.height = '0px';
  }

  function updateBoxSelect(e) {
    const vp = host.querySelector('#cv-viewport');
    const r = vp.getBoundingClientRect();
    boxSel.x1 = e.clientX - r.left;
    boxSel.y1 = e.clientY - r.top;
    const el = host.querySelector('#cv-box');
    if (el) {
      el.style.left = Math.min(boxSel.x0, boxSel.x1) + 'px';
      el.style.top = Math.min(boxSel.y0, boxSel.y1) + 'px';
      el.style.width = Math.abs(boxSel.x1 - boxSel.x0) + 'px';
      el.style.height = Math.abs(boxSel.y1 - boxSel.y0) + 'px';
    }
  }

  function endBoxSelect() {
    if (!boxSel) return;
    const vp = host.querySelector('#cv-viewport');
    const el = host.querySelector('#cv-box');
    if (el) el.style.display = 'none';

    const a = screenToWorld(
      Math.min(boxSel.x0, boxSel.x1) + vp.getBoundingClientRect().left,
      Math.min(boxSel.y0, boxSel.y1) + vp.getBoundingClientRect().top
    );
    const b = screenToWorld(
      Math.abs(boxSel.x1 - boxSel.x0) + Math.min(boxSel.x0, boxSel.x1) + vp.getBoundingClientRect().left,
      Math.abs(boxSel.y1 - boxSel.y0) + Math.min(boxSel.y0, boxSel.y1) + vp.getBoundingClientRect().top
    );
    const rx1 = Math.min(a.x, b.x), rx2 = Math.max(a.x, b.x);
    const ry1 = Math.min(a.y, b.y), ry2 = Math.max(a.y, b.y);

    if (!boxSel.add) selected.clear();
    visibleBoxes().forEach(bx => {
      const hit = bx.x < rx2 && bx.x + bx.w > rx1 && bx.y < ry2 && bx.y + bx.h > ry1;
      if (hit) selected.add(bx.n.id);
    });
    world.querySelectorAll('.cv-node').forEach(el2 =>
      el2.classList.toggle('sel', selected.has(el2.dataset.id)));

    boxSel = null;
    drawMinimap();
  }

  /* ---------------- 复制 / 粘贴 ---------------- */
  function copySelection() {
    if (!cv || !selected.size) return false;
    const ids = new Set(selected);
    const nodes = cv.nodes.filter(n => ids.has(n.id));
    if (!nodes.length) return false;
    const edges = cv.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    clipboard = JSON.parse(JSON.stringify({ nodes, edges }));
    return true;
  }

  function pasteClipboard() {
    if (!cv || !clipboard || !clipboard.nodes.length) return false;
    pushHistory();
    const idMap = new Map();
    const off = 48;
    const newNodes = clipboard.nodes.map(n => {
      const nid = U.uid('n');
      idMap.set(n.id, nid);
      const copy = JSON.parse(JSON.stringify(n));
      copy.id = nid;
      copy.x = (n.x || 0) + off;
      copy.y = (n.y || 0) + off;
      if (copy.data) {
        delete copy.data.promptId;      // 复制品不该继承别人的任务
        delete copy.data.canceled;
        if (copy.data.status === 'running') { copy.data.status = 'idle'; copy.data.statusText = ''; copy.data.prog = null; }
      }
      return copy;
    });
    const newEdges = clipboard.edges
      .map(e => ({ id: U.uid('e'), from: idMap.get(e.from), to: idMap.get(e.to) }))
      .filter(e => e.from && e.to);

    cv.nodes.push(...newNodes);
    cv.edges.push(...newEdges);
    selected = new Set(newNodes.map(n => n.id));
    renderAll();
    queueSave();
    return true;
  }

  /* ---------------- 槽位 / 批量 / 图片组 工具 ---------------- */
  const slotCache = new Map();

  /** 取某个工作流的槽位解析结果（按内容缓存，工作流一改自动失效） */
  function wfSlots(wf) {
    if (!wf || typeof wf.content !== 'string') return null;
    const hit = slotCache.get(wf.id);
    if (hit && hit.content === wf.content) return hit.slots;
    let slots = null;
    try {
      const api = JSON.parse(wf.content);
      if (api && !Array.isArray(api.nodes)) slots = Comfy.parseSlots(api);
    } catch { }
    slotCache.set(wf.id, { content: wf.content, slots });
    return slots;
  }

  function slotsOfNode(n) {
    const wf = V.state.workflows.find(w => w.id === n.data.workflowId);
    return wf ? wfSlots(wf) : null;
  }

  /** 节点上显示的工作流名：优先缓存的名字，其次按 id 现查（导入/复用时 wfName 可能是空的） */
  function wfLabel(n) {
    if (n.data.wfName) return n.data.wfName;
    const wf = V.state.workflows.find(w => w.id === n.data.workflowId);
    return wf ? wf.name : '未绑定工作流';
  }

  /** 只重画一个节点（不整屏重建） */
  function refreshNode(n) {
    const el = world.querySelector(`.cv-node[data-id="${n.id}"]`);
    if (el) el.replaceWith(makeNodeEl(n));
  }

  function slotChips(n) {
    const s = slotsOfNode(n);
    if (!s) return '';
    if (!s.labeled) {
      return `<div class="cv-slots none" title="工作流没有 _meta.title 标注，按节点类型猜的；复杂工作流建议加标注">按类型猜 · 未标注</div>`;
    }
    const chips = (s.capabilities || []).map(c => `<i>${esc(Comfy.capLabel(c))}</i>`).join('');
    const slots = s.imageSlots ? `<i class="num">${s.imageSlots} 图位</i>` : '';
    const mask = s.mask ? `<i class="num">遮罩位</i>` : '';
    return `<div class="cv-slots">${chips}${slots}${mask}</div>`;
  }

  function batchRow(n) {
    const b = Math.max(1, Math.min(8, Number(n.data.batch) || 1));
    const fixed = !!n.data.seedFixed;
    return `<div class="cv-batch">
        <span>张数</span>
        <button data-cvnode="batch-" ${b <= 1 ? 'disabled' : ''}>−</button>
        <b>${b}</b>
        <button data-cvnode="batch+" ${b >= 8 ? 'disabled' : ''}>+</button>
        <label class="cv-seedfix" title="固定种子：同一提示词可复现同一张图"><input type="checkbox" data-seedfix ${fixed ? 'checked' : ''}>固定种子</label>
      </div>`;
  }

  /* ---------------- 遮罩编辑器 ---------------- */
  async function openMaskEditor(n) {
    const src = n.data.hiSrc || n.data.src;
    if (!src) return V.toast('先给这个节点放一张图，再画遮罩', 'err');

    const img = new Image();
    img.src = src;
    try { await img.decode(); } catch { }
    const natW = img.naturalWidth || 512;
    const natH = img.naturalHeight || 512;
    const scale = Math.min(1, 640 / natW, 480 / natH);
    const dispW = Math.max(64, Math.round(natW * scale));
    const dispH = Math.max(64, Math.round(natH * scale));

    V.openModal({
      title: '画笔遮罩 · 涂哪里重绘哪里',
      sub: `原图 ${natW}×${natH} · 遮罩会按原图尺寸导出，提交到工作流的 ref_mask 槽位`,
      wide: true,
      body: `<div class="mask-stage" style="width:${dispW}px;height:${dispH}px">
          <img src="${esc(src)}" alt="">
          <canvas id="mask-cv" width="${dispW}" height="${dispH}"></canvas>
        </div>
        <div class="mask-tools">
          <label class="mask-size">笔刷 <input type="range" id="mask-size" min="4" max="140" value="36"><b id="mask-size-v">36</b></label>
          <button class="btn sm" id="mask-erase">橡皮</button>
          <button class="btn sm" id="mask-clear">清空</button>
          <button class="btn sm" id="mask-invert">反选</button>
          <span class="hint" id="mask-tip">按住左键涂抹；空白 = 不重绘</span>
        </div>`,
      footer: `<button class="btn" data-close>取消</button>
               <button class="btn" id="mask-remove">移除遮罩</button>
               <button class="btn primary" id="mask-save">保存遮罩</button>`,
      onMount: (box, close) => {
        const cvs = box.querySelector('#mask-cv');
        const ctx = cvs.getContext('2d');
        let erasing = false;
        let drawing = false;
        let last = null;

        const paint = (from, to) => {
          ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
          ctx.strokeStyle = 'rgba(255,74,110,.62)';
          ctx.lineWidth = Number(box.querySelector('#mask-size').value);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          if (from) { ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); }
          else { ctx.moveTo(to.x, to.y); ctx.lineTo(to.x + 0.01, to.y); }
          ctx.stroke();
        };
        const pos = e => {
          const r = cvs.getBoundingClientRect();
          return { x: (e.clientX - r.left) * (cvs.width / r.width), y: (e.clientY - r.top) * (cvs.height / r.height) };
        };

        cvs.addEventListener('pointerdown', e => {
          e.stopPropagation();
          drawing = true;
          last = pos(e);
          paint(null, last);
          try { cvs.setPointerCapture(e.pointerId); } catch { }
        });
        cvs.addEventListener('pointermove', e => {
          if (!drawing) return;
          const p = pos(e);
          paint(last, p);
          last = p;
        });
        cvs.addEventListener('pointerup', () => { drawing = false; last = null; });
        cvs.addEventListener('pointerleave', () => { drawing = false; last = null; });

        box.querySelector('#mask-size').addEventListener('input', e => {
          box.querySelector('#mask-size-v').textContent = e.target.value;
        });
        const eraseBtn = box.querySelector('#mask-erase');
        eraseBtn.addEventListener('click', () => {
          erasing = !erasing;
          eraseBtn.classList.toggle('on', erasing);
          box.querySelector('#mask-tip').textContent = erasing ? '橡皮：擦掉涂过的区域' : '按住左键涂抹；空白 = 不重绘';
        });
        box.querySelector('#mask-clear').addEventListener('click', () => {
          ctx.clearRect(0, 0, cvs.width, cvs.height);
        });
        box.querySelector('#mask-invert').addEventListener('click', () => {
          // 反选：把「涂过的」变「没涂」，全图铺满再挖掉原遮罩
          const tmp = document.createElement('canvas');
          tmp.width = cvs.width; tmp.height = cvs.height;
          const tctx = tmp.getContext('2d');
          tctx.drawImage(cvs, 0, 0);
          ctx.globalCompositeOperation = 'source-over';
          ctx.clearRect(0, 0, cvs.width, cvs.height);
          ctx.fillStyle = 'rgba(255,74,110,.62)';
          ctx.fillRect(0, 0, cvs.width, cvs.height);
          ctx.globalCompositeOperation = 'destination-out';
          ctx.drawImage(tmp, 0, 0);
          ctx.globalCompositeOperation = 'source-over';
        });

        // 已有遮罩：把白色区域铺回红色，方便继续改
        if (n.data.maskSrc) {
          const old = new Image();
          old.src = n.data.maskSrc;
          old.onload = () => {
            const t = document.createElement('canvas');
            t.width = cvs.width; t.height = cvs.height;
            const tc = t.getContext('2d');
            tc.drawImage(old, 0, 0, cvs.width, cvs.height);
            const data = tc.getImageData(0, 0, cvs.width, cvs.height);
            for (let i = 0; i < data.data.length; i += 4) {
              const white = data.data[i] > 127;
              data.data[i] = 255; data.data[i + 1] = 74; data.data[i + 2] = 110;
              data.data[i + 3] = white ? 158 : 0;
            }
            tc.putImageData(data, 0, 0);
            ctx.drawImage(t, 0, 0);
          };
        }

        box.querySelector('#mask-remove').addEventListener('click', () => {
          delete n.data.maskSrc;
          queueSave();
          refreshNode(n);
          close();
          V.toast('遮罩已移除', 'ok');
        });

        box.querySelector('#mask-save').addEventListener('click', () => {
          const src32 = ctx.getImageData(0, 0, cvs.width, cvs.height).data;
          // 缩放到原图尺寸，输出「白=重绘、黑=保留」的 1 位掩码
          const tiny = document.createElement('canvas');
          tiny.width = cvs.width; tiny.height = cvs.height;
          const tctx = tiny.getContext('2d');
          const id = tctx.createImageData(cvs.width, cvs.height);
          let painted = 0;
          for (let i = 0; i < cvs.width * cvs.height; i++) {
            const on = src32[i * 4 + 3] > 24;
            if (on) painted++;
            const v = on ? 255 : 0;
            id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
          }
          tctx.putImageData(id, 0, 0);

          const out = document.createElement('canvas');
          out.width = natW; out.height = natH;
          const octx = out.getContext('2d');
          octx.imageSmoothingEnabled = false;
          octx.drawImage(tiny, 0, 0, natW, natH);

          if (!painted) {
            V.toast('一笔都没涂，遮罩没有意义；想清空请点「移除遮罩」', 'err');
            return;
          }
          let dataUrl = '';
          try { dataUrl = out.toDataURL('image/png'); } catch { }
          if (!dataUrl) return V.toast('导出遮罩失败（画布被浏览器限制）', 'err');
          n.data.maskSrc = dataUrl;
          queueSave();
          refreshNode(n);
          close();
          V.toast('遮罩已保存，下次生成会一起提交', 'ok');
        });
      }
    });
  }

  /* ---------------- 图片组 ---------------- */
  function groupItems(n) {
    return Array.isArray(n.data.items) ? n.data.items : [];
  }

  function expandGroup(n) {
    const items = groupItems(n);
    if (!items.length) return V.toast('这个组里还没有图', 'err');
    V.openModal({
      title: '图片组 · ' + items.length + ' 张',
      sub: '点一张设为主图；也可以「拆开」变成独立图片节点',
      wide: true,
      body: `<div class="group-grid">${items.map((it, i) => `
        <figure class="group-cell ${i === (n.data.active || 0) ? 'on' : ''}" data-gi="${i}">
          <img src="${esc(it.src)}" alt="">
          <figcaption>${esc(it.imageId || '未入库')}</figcaption>
        </figure>`).join('')}</div>`,
      footer: `<button class="btn" data-close>关闭</button>
               <button class="btn primary" id="g-split-all">拆成 ${items.length} 个节点</button>`,
      onMount: (box, close) => {
        box.querySelectorAll('[data-gi]').forEach(el => {
          el.addEventListener('click', () => {
            n.data.active = Number(el.dataset.gi);
            queueSave();
            refreshNode(n);
            close();
          });
        });
        box.querySelector('#g-split-all').addEventListener('click', () => {
          close();
          splitGroup(n);
        });
      }
    });
  }

  function splitGroup(n) {
    const items = groupItems(n);
    if (!items.length) return;
    pushHistory();
    const baseX = n.x, baseY = n.y + (n.h || 220) + 40;
    items.forEach((it, i) => {
      addNode('image', {
        pos: { x: baseX + i * 300, y: baseY },
        data: { src: it.src, label: it.imageId || '生成结果', imageId: it.imageId || '' }
      });
    });
    V.toast(`已拆出 ${items.length} 个图片节点`, 'ok');
  }

  function typeLabel(t) {
    return { prompt: '提示词', image: '图片', ref: '参考', gen: '输出', simple: '简易', wf: '节点', group: '图片组' }[t] || t;
  }

  function nodeTitle(n) {
    if (n.type === 'prompt') return (n.data.role === '负向' ? '负向提示词' : '正向提示词') || '提示词';
    if (n.type === 'simple') return n.data.wfName || '简易节点';
    if (n.type === 'gen') return n.data.wfName || (n.data.workflowId ? '输出' : '输出');
    if (n.type === 'wf') return n.data.title || n.data.cls || '节点';
    if (n.type === 'group') return `图片组 · ${groupItems(n).length} 张`;
    return n.data.label || (n.type === 'ref' ? '参考图' : '图片');
  }

  function renderEdges() {
    if (!edgeLayer) return;
    const paths = cv.edges.map(e => {
      const a = nodeById(e.from), b = nodeById(e.to);
      if (!a || !b) return '';
      if (a.type === 'wf' || b.type === 'wf') return '';
      const aEl = world.querySelector(`.cv-node[data-id="${a.id}"]`);
      const bEl = world.querySelector(`.cv-node[data-id="${b.id}"]`);
      const aw = a.w || aEl?.offsetWidth || 240;
      const ah = aEl?.offsetHeight || 120;
      const bh = bEl?.offsetHeight || 120;
      const x1 = a.x + aw, y1 = a.y + ah / 2;
      const x2 = b.x, y2 = b.y + bh / 2;
      const dx = Math.max(50, Math.abs(x2 - x1) * 0.5);
      const dir = x2 >= x1 ? 1 : -1;
      return `<path d="M${x1},${y1} C${x1 + dx * dir},${y1} ${x2 - dx * dir},${y2} ${x2},${y2}"
        stroke="currentColor" stroke-width="2" fill="none" opacity=".55"/>`;
    }).join('');

    let temp = '';
    if (link) {
      const d2 = Math.max(50, Math.abs(link.x2 - link.x1) * 0.5) * (link.x2 >= link.x1 ? 1 : -1);
      temp = `<path d="M${link.x1},${link.y1} C${link.x1 + d2},${link.y1} ${link.x2 - d2},${link.y2} ${link.x2},${link.y2}"
          stroke="currentColor" stroke-width="2" stroke-dasharray="5 4" fill="none" opacity=".8"/>`;
    }

    edgeLayer.innerHTML = paths + temp;
  }

  /* ============================================================
     节点事件
     ============================================================ */
  function bindNodeEvents(el, n) {
    const head = el.querySelector('.cv-node-head');
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      e.stopPropagation();
      selectNode(n.id, e.shiftKey);
      startDrag(e, 'node', n);
    });

    el.addEventListener('pointerdown', e => {
      if (e.target.closest('textarea, button, img, input')) return;
      if (e.target.classList.contains('cv-port')) return;
      selectNode(n.id, e.shiftKey);
      startDrag(e, 'node', n);
    });

    el.querySelectorAll('[data-cvnode]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const act = btn.dataset.cvnode;
        if (act === 'del') removeNode(n.id);
        if (act === 'replace') pickImageFor(n);
        if (act === 'run') runGen(n);
        if (act === 'cancel') cancelRun(n);
        if (act === 'addref') addRefToOutput(n);
        if (act === 'pick' && n.type === 'simple') pickImageFor(n);
        if (act === 'retry') runGen(n);
        if (act === 'mask') openMaskEditor(n);
        if (act === 'batch-') { n.data.batch = Math.max(1, (Number(n.data.batch) || 1) - 1); queueSave(); refreshNode(n); }
        if (act === 'batch+') { n.data.batch = Math.min(8, (Number(n.data.batch) || 1) + 1); queueSave(); refreshNode(n); }
        if (act === 'g-pick') { n.data.active = Number(btn.dataset.i); queueSave(); refreshNode(n); }
        if (act === 'g-expand') expandGroup(n);
        if (act === 'g-split') splitGroup(n);
      });
    });

    const ta = el.querySelector('[data-cvtext]');
    if (ta) {
      ta.addEventListener('input', () => {
        n.data.text = ta.value;
        const t = el.querySelector('.cv-title');
        if (t) t.textContent = nodeTitle(n);
        queueSave();
      });
      ta.addEventListener('focus', () => pushHistory());     // 编辑前留快照
      ta.addEventListener('pointerdown', e => e.stopPropagation());
      ta.addEventListener('wheel', e => e.stopPropagation());
    }

    // 工作流节点的参数：改完写回源工作流并重新生成 API
    el.querySelectorAll('[data-cvw]').forEach(inp => {
      const i = Number(inp.dataset.cvw);
      const commit = () => {
        const raw = inp.value;
        // slots[i] 才是这个参数在 widgets_values 里的真实位置（seed 后可能夹着 fixed 控制位）
        const vi = (n.data.slots && n.data.slots[i] != null) ? n.data.slots[i] : i;
        const old = n.data.widgets?.[vi];
        n.data.widgets = n.data.widgets || [];
        n.data.widgets[vi] = (typeof old === 'number' && raw !== '') ? Number(raw) : raw;
        syncWfNode(n);
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('blur', commit);
      inp.addEventListener('pointerdown', e => e.stopPropagation());
      inp.addEventListener('wheel', e => e.stopPropagation());
      inp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter' && inp.tagName === 'INPUT') commit();
      });
    });

    el.querySelectorAll('[data-cvneg]').forEach(ta => {
      ta.addEventListener('input', () => { n.data.neg = ta.value; queueSave(); });
      ta.addEventListener('pointerdown', e => e.stopPropagation());
      ta.addEventListener('wheel', e => e.stopPropagation());
    });

    const seedFix = el.querySelector('[data-seedfix]');
    if (seedFix) {
      seedFix.addEventListener('change', () => {
        n.data.seedFixed = seedFix.checked;
        if (seedFix.checked && !Number.isFinite(Number(n.data.seed))) {
          n.data.seed = Math.floor(Math.random() * 1125899906842624);
        }
        queueSave();
        refreshNode(n);
      });
    }

    el.querySelectorAll('[data-role]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        pushHistory();
        n.data.role = b.dataset.role;
        el.querySelectorAll('[data-role]').forEach(x => x.classList.toggle('on', x === b));
        queueSave();
      });
    });

    el.addEventListener('dblclick', () => {
      if (n.type === 'image' || n.type === 'ref') pickImageFor(n);
    });

    const gm = el.querySelector('.cv-gen-meta');
    if (gm) gm.addEventListener('click', e => { e.stopPropagation(); pickWorkflow(n); });

    // 右下角手柄：自由拉伸（上下左右都可）
    const rz = el.querySelector('.cv-resize');
    if (rz) {
      rz.addEventListener('pointerdown', e => {
        e.stopPropagation();
        e.preventDefault();
        selectNode(n.id, e.shiftKey);
        const curW = n.w || el.offsetWidth || 220;
        const curH = el.offsetHeight || 120;
        startResize(e, n, curW, curH);
        try { rz.setPointerCapture?.(e.pointerId); } catch { }
      });
    }

    // 端口拖拽连线
    const out = el.querySelector('.cv-port.out');
    if (out) {
      out.addEventListener('pointerdown', e => {
        e.stopPropagation();
        const rect = world.getBoundingClientRect();
        const aw = n.w || el.offsetWidth;
        const ah = el.offsetHeight;
        link = {
          from: n.id,
          x1: n.x + aw, y1: n.y + ah / 2,
          x2: (e.clientX - rect.left) / cv.view.k,
          y2: (e.clientY - rect.top) / cv.view.k
        };
        renderEdges();
        try { el.setPointerCapture?.(e.pointerId); } catch { }
      });
    }
  }

  function selectNode(id, add) {
    if (!add) selected.clear();
    else if (selected.has(id) && selected.size > 1) {
      // Shift 再点一次 = 取消这个节点
      selected.delete(id);
      world.querySelectorAll('.cv-node').forEach(el =>
        el.classList.toggle('sel', selected.has(el.dataset.id)));
      drawMinimap();
      return;
    }
    selected.add(id);
    world.querySelectorAll('.cv-node').forEach(el =>
      el.classList.toggle('sel', selected.has(el.dataset.id)));
    drawMinimap();
  }

  /* ============================================================
     画布交互
     ============================================================ */
  function bindCanvasEvents(c) {
    const vp = c.querySelector('#cv-viewport');

    vp.addEventListener('pointerdown', e => {
      if (e.target.closest('.cv-node')) return;
      if (e.target.closest('.cv-map') || e.target.closest('.cv-hud')) return;
      // Shift + 拖空白 = 框选；普通拖 = 平移
      if (e.button === 0 && e.shiftKey && !spaceDown) {
        e.preventDefault();
        startBoxSelect(e);
        return;
      }
      if (e.button === 0 && !spaceDown) {
        selected.clear();
        world.querySelectorAll('.cv-node.sel').forEach(el => el.classList.remove('sel'));
        drawMinimap();
      }
      startDrag(e, 'pan');
    });

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const k0 = cv.view.k;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const k = Math.min(MAX_K, Math.max(MIN_K, k0 * factor));
      if (k === k0) return;
      // 以光标为锚点缩放
      cv.view.x = mx - (mx - cv.view.x) * (k / k0);
      cv.view.y = my - (my - cv.view.y) * (k / k0);
      cv.view.k = k;
      applyTransform();
      queueSave();
    }, { passive: false });

    // 全局监听只绑一次，否则每次进画布都会叠加一层（撤销会一次退好几步）
    if (!globalsBound) {
      globalsBound = true;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      document.addEventListener('keydown', onKey);
      document.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });
    }
  }

  function applyTransform() {
    world.style.transform = `translate(${cv.view.x}px, ${cv.view.y}px) scale(${cv.view.k})`;
    const z = host?.querySelector('#cv-zoom');
    if (z) z.textContent = Math.round(cv.view.k * 100) + '%';
    drawMinimap();
  }

  function screenToWorld(cx, cy) {
    const rect = host.querySelector('#cv-viewport').getBoundingClientRect();
    return {
      x: (cx - rect.left - cv.view.x) / cv.view.k,
      y: (cy - rect.top - cv.view.y) / cv.view.k
    };
  }

  function startDrag(e, kind, n) {
    drag = {
      kind, node: n,
      sx: e.clientX, sy: e.clientY,
      ox: kind === 'node' ? n.x : cv.view.x,
      oy: kind === 'node' ? n.y : cv.view.y,
      moved: false,
      hist: false,
      // 拖一个选中的节点时，整组一起动
      group: (kind === 'node' && selected.size > 1 && selected.has(n.id))
        ? cv.nodes.filter(x => selected.has(x.id)).map(x => ({ n: x, x: x.x, y: x.y }))
        : null
    };
  }

  function startResize(e, n, w, h) {
    drag = {
      kind: 'resize', node: n,
      sx: e.clientX, sy: e.clientY,
      ow: w, oh: h,
      moved: false, hist: false
    };
  }

  function onMove(e) {
    if (link) {
      const p = screenToWorld(e.clientX, e.clientY);
      link.x2 = p.x; link.y2 = p.y;
      renderEdges();
      return;
    }
    if (boxSel) { updateBoxSelect(e); return; }
    if (!drag) {
      if (link) return;
      return;
    }
    const dx = (e.clientX - drag.sx) / cv.view.k;
    const dy = (e.clientY - drag.sy) / cv.view.k;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;

    if (drag.kind === 'pan') {
      cv.view.x = drag.ox + (e.clientX - drag.sx);
      cv.view.y = drag.oy + (e.clientY - drag.sy);
      applyTransform();
      return;
    }
    if (drag.kind === 'node') {
      if (!drag.hist) { pushHistory(); drag.hist = true; }   // 拖动前留一份快照
      const ddx = Math.round(dx), ddy = Math.round(dy);
      const list = drag.group || [{ n: drag.node, x: drag.ox, y: drag.oy }];
      list.forEach(it => {
        it.n.x = it.x + ddx;
        it.n.y = it.y + ddy;
        const el = world.querySelector(`.cv-node[data-id="${it.n.id}"]`);
        if (el) { el.style.left = it.n.x + 'px'; el.style.top = it.n.y + 'px'; }
      });
      renderEdges();
      drawMinimap();
    }
    if (drag.kind === 'resize') {
      const n = drag.node;
      if (!drag.hist) { pushHistory(); drag.hist = true; }
      n.w = Math.max(140, Math.round(drag.ow + dx));
      n.h = Math.max(96, Math.round(drag.oh + dy));
      const el = world.querySelector(`.cv-node[data-id="${n.id}"]`);
      if (el) {
        el.style.width = n.w + 'px';
        el.style.height = n.h + 'px';
        el.classList.add('resizing');
      }
      renderEdges();
    }
  }

  function onUp(e) {
    if (boxSel) { endBoxSelect(); }
    if (link) {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cv-node');
      const inPort = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cv-port.in');
      if (target && (inPort || true)) {
        const toId = target.dataset.id;
        if (toId && toId !== link.from) addEdge(link.from, toId);
      }
      link = null;
      renderEdges();
    }
    if (drag?.moved) queueSave();
    if (drag?.kind === 'resize') {
      const el = world.querySelector(`.cv-node[data-id="${drag.node.id}"]`);
      el?.classList.remove('resizing');
    }
    drag = null;
  }

  function onKey(e) {
    if (e.code === 'Space') spaceDown = true;
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if (inField) return;
    if (!host || !host.classList.contains('cv-host')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected.size) {
        e.preventDefault();
        [...selected].forEach(id => removeNode(id));
      }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod && (e.key === 'c' || e.key === 'C')) {
      if (copySelection()) { e.preventDefault(); V.toast(`已复制 ${selected.size} 个节点`, 'ok'); }
      return;
    }
    if (mod && (e.key === 'v' || e.key === 'V')) {
      if (pasteClipboard()) { e.preventDefault(); V.toast('已粘贴', 'ok'); }
      return;
    }
    if (mod && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      if (copySelection() && pasteClipboard()) V.toast('已再制一份', 'ok');
      return;
    }
    if (mod && e.key === 'a') {
      e.preventDefault();
      selected = new Set(cv.nodes.map(n => n.id));
      world.querySelectorAll('.cv-node').forEach(el => el.classList.add('sel'));
      return;
    }
    if (e.key === 'Escape') {
      if (selected.size) { selected.clear(); renderAll(); }
      else V.go('gallery');       // 没选中任何东西时，Esc 直接退出画布
    }
  }

  /* ============================================================
     节点操作
     ============================================================ */
  function addEdge(from, to) {
    if (cv.edges.some(e => e.from === from && e.to === to)) return;
    pushHistory();
    cv.edges.push({ id: U.uid('e'), from, to });
    renderEdges();
    queueSave();
  }

  function removeNode(id) {
    pushHistory();
    cv.nodes = cv.nodes.filter(n => n.id !== id);
    cv.edges = cv.edges.filter(e => e.from !== id && e.to !== id);
    selected.delete(id);
    renderAll();
    queueSave();
  }

  function centerSpawn(w = 260, h = 160) {
    const vp = host.querySelector('#cv-viewport');
    const rect = vp.getBoundingClientRect();
    const c = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    // 级联错开，避免新节点叠在一起
    const step = cv.nodes.length % 8;
    return {
      x: Math.round(c.x - w / 2 + step * 42),
      y: Math.round(c.y - h / 2 + step * 38)
    };
  }

  function addNode(type, extra = {}) {
    const pos = extra.pos || centerSpawn();
    const base = { id: U.uid('n'), type, x: pos.x, y: pos.y };
    const defaults = {
      prompt: { w: 320, data: { text: '', role: '正向' } },
      image: { w: 260, data: { src: '', label: '图片' } },
      ref: { w: 220, data: { src: '', label: '参考图' } },
      gen: { w: 320, data: { wfName: '', model: '', status: 'idle', statusText: '' } },
      simple: { w: 300, data: { wfName: '', text: '', neg: '', src: '', imageSlots: 0, status: 'idle', statusText: '' } },
      wf: { w: 240, data: {} },
      group: { w: 300, data: { items: [], active: 0, label: '图片组' } }
    }[type];
    const n = { ...base, ...defaults, ...extra, data: { ...defaults.data, ...(extra.data || {}) } };
    pushHistory();
    cv.nodes.push(n);
    renderAll();
    queueSave();
    return n;
  }

  /* ============================================================
     图片选择（从图库 / 参考库 / 本地文件）
     ============================================================ */
  function pickImageFor(n) {
    V.openModal({
      title: '给节点选一张图',
      sub: '来自我的图库、参考库，或上传本地文件',
      wide: true,
      body: `
        <div class="chips" style="margin-bottom:14px">
          <button class="chip active" data-src="vault">我的图库</button>
          <button class="chip" data-src="outfits">服饰参考</button>
          <button class="chip" data-src="faces">人脸参考</button>
          <button class="chip" data-src="file">本地文件</button>
        </div>
        <div id="pick-body"></div>`,
      footer: `<button class="btn" data-close>取消</button>`,
      onMount: (box, close) => {
        const body = box.querySelector('#pick-body');
        let mode = 'vault';
        let refData = null;

        const paint = () => {
          if (mode === 'file') {
            body.innerHTML = `<div class="empty" style="padding:40px 0">
              ${V.icon('upload', 34)}<b>选一张本地图片</b>
              <button class="btn primary" id="pick-file-btn">选择文件</button></div>`;
            body.querySelector('#pick-file-btn').onclick = () => {
              const inp = document.createElement('input');
              inp.type = 'file'; inp.accept = 'image/*';
              inp.onchange = async () => {
                const f = inp.files[0];
                if (!f) return;
                const blob = await Parse.makeThumb(f, 1200, 0.9);
                const bid = U.uid('bl');
                await DB.putBlob(bid, blob, { kind: 'canvas' });
                pushHistory();
                n.data.blobId = bid;
                n.data.src = await urlForBlob(bid);
                n.data.label = f.name;
                close(); renderAll(); queueSave();
              };
              inp.click();
            };
            return;
          }
          if (mode === 'vault') {
            const imgs = V.state.images.slice(0, 80);
            body.innerHTML = imgs.length
              ? `<div class="ref-grid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">
                  ${imgs.map(i => `<div class="ref-card" data-pickv="${i.id}"><img src="" data-blob="${i.thumbId}" loading="lazy"></div>`).join('')}
                </div>`
              : `<div class="empty" style="padding:40px 0">${V.icon('img', 32)}<b>图库还是空的</b></div>`;
            body.querySelectorAll('img[data-blob]').forEach(async img => {
              const u = await V.blobURL(img.dataset.blob);
              if (u) img.src = u;
            });
            body.querySelectorAll('[data-pickv]').forEach(el => {
              el.onclick = async () => {
                const img = V.state.images.find(i => i.id === el.dataset.pickv);
                const u = await V.blobURL(img.blobId);
                pushHistory();
                n.data.src = u;
                n.data.blobId = img.blobId;
                n.data.label = img.id;
                close(); renderAll(); queueSave();
              };
            });
            return;
          }
          // 参考库
          const src = window.REF_DATA?.[mode]?.items || [];
          body.innerHTML = `<div class="ref-grid ${mode === 'faces' ? 'tall' : ''}" style="max-height:52vh;overflow:auto">
            ${src.slice(0, 120).map((it, i) => `<div class="ref-card" data-pickr="${i}"><img src="${esc(it.thumb)}" loading="lazy"></div>`).join('')}
          </div>`;
          body.querySelectorAll('[data-pickr]').forEach(el => {
            el.onclick = () => {
              const it = src[Number(el.dataset.pickr)];
              pushHistory();
              n.data.src = it.thumb;
              n.data.refId = it.id;
              n.data.label = it.id.slice(0, 10);
              close(); renderAll(); queueSave();
              ensureHiRes();
            };
          });
        };

        box.querySelectorAll('[data-src]').forEach(b => {
          b.onclick = () => {
            mode = b.dataset.src;
            box.querySelectorAll('[data-src]').forEach(x => x.classList.toggle('active', x === b));
            paint();
          };
        });
        paint();
      }
    });
  }

  /* ============================================================
     ComfyUI 生成
     ============================================================ */
  /** 统一的节点状态更新（runGen 与「接回任务」共用） */
  function nodeStatus(n, text, st = 'running', step, total) {
    n.data.status = st;
    n.data.statusText = text;
    if (step != null && total) n.data.prog = { step, total };
    if (st !== 'running') n.data.prog = null;
    const el = world.querySelector(`.cv-node[data-id="${n.id}"]`);
    if (el) el.replaceWith(makeNodeEl(n));
    const fresh = world.querySelector(`.cv-node[data-id="${n.id}"]`);
    if (fresh) bindNodeEvents(fresh, n);
  }

  function incoming(node) {
    const ids = cv.edges.filter(e => e.to === node.id).map(e => e.from);
    return ids.map(nodeById).filter(Boolean);
  }

  async function runGen(n) {
    if (n.data.status === 'running') return;
    const inputs = incoming(n);
    const prompts = inputs.filter(x => x.type === 'prompt');
    let refs = inputs.filter(x => x.type === 'ref' || x.type === 'image');

    // 简易节点：提示词和参考图就写在自己身上
    let positive, negative;
    if (n.type === 'simple') {
      positive = n.data.text || '';
      negative = n.data.neg || '';
      if (n.data.src || n.data.blobId) refs = [n, ...refs];
    } else {
      positive = prompts.find(p => p.data.role !== '负向')?.data.text || '';
      negative = prompts.find(p => p.data.role === '负向')?.data.text || '';
    }

    // 工作流
    const wfId = n.data.workflowId;
    const wf = V.state.workflows.find(w => w.id === wfId);
    if (!wf) return V.toast('这个生成节点还没绑定工作流：点标题栏下拉选一个，或先导入工作流', 'err');

    let api;
    try {
      const parsed = JSON.parse(wf.content || '{}');
      api = parsed.nodes ? null : parsed;   // 有 nodes 说明是 UI 格式
      if (!api) return V.toast('这是 UI 格式工作流，无法直接提交。请在 ComfyUI 里「导出 (API)」后再导入', 'err');
    } catch {
      return V.toast('工作流内容不是合法 JSON', 'err');
    }

    n.data.canceled = false;   // 新的一轮，清掉上一次的取消标记
    n.data.statusText = '';
    const setStatus = (text, st = 'running', step, total) => nodeStatus(n, text, st, step, total);

    const batch = Math.max(1, Math.min(8, Number(n.data.batch) || 1));
    const seedVal = n.data.seedFixed && Number.isFinite(Number(n.data.seed)) ? Number(n.data.seed) : null;

    setStatus('准备中…');
    try {
      // 确保本地引擎在跑（没跑就静默拉起），而不是直接盲报 502
      try {
        await Comfy.ensureEngine((t) => setStatus(t));
      } catch (e) {
        setStatus('引擎启动失败', 'error');
        throw new Error('本地引擎启动失败：' + e.message + '。请到「设置 → ComfyUI」里配置引擎目录。');
      }

      // 上传参考图（多张按连线顺序）
      const names = [];
      for (let i = 0; i < refs.length; i++) {
        const src = refs[i].data.hiSrc || refs[i].data.src;
        if (!src) continue;
        setStatus(refs.length > 1 ? `上传参考图 ${i + 1}/${refs.length}…` : '上传参考图…');
        const blob = await fetch(src).then(r => r.blob()).catch(() => null);
        if (!blob) continue;
        names.push(await Comfy.uploadImage(blob, `vault_${Date.now()}_${i}.png`));
      }

      // 上传遮罩（挂在参考图/图片节点上，白=重绘）
      let maskName = '';
      const masked = refs.find(r => r.data && r.data.maskSrc);
      if (masked) {
        setStatus('上传遮罩…');
        const mb = await fetch(masked.data.maskSrc).then(r => r.blob()).catch(() => null);
        if (mb) maskName = await Comfy.uploadImage(mb, `mask_${Date.now()}.png`);
      }

      const collected = [];
      let lastApplied = null;

      for (let bi = 0; bi < batch; bi++) {
        if (n.data.canceled) break;
        const tag = batch > 1 ? `第 ${bi + 1}/${batch} 张 · ` : '';

        const applied = Comfy.applyInputs(api, {
          prompt: positive, negative, images: names,
          mask: maskName || undefined,
          seed: seedVal === null ? undefined : seedVal
        });
        lastApplied = applied;
        n.data.imageSlots = applied.slots;

        if (bi === 0) {
          // 只提示一次，别每张都弹
          if (names.length && applied.slots === 0 && !(applied.slotMap && applied.slotMap.frames && applied.slotMap.frames.first_frame)) {
            throw new Error(applied.mode === 'slot'
              ? '这个工作流没有 ref_image_xx 槽位，参考图放不进去'
              : '这个工作流里没有 LoadImage 节点，参考图用不上');
          }
          if (maskName && applied.slotMap && !applied.slotMap.mask) {
            V.toast('工作流没有 ref_mask 槽位，遮罩不会生效（相当于只换了图）', 'err');
          }
          if (applied.dropped) {
            V.toast(`工作流只有 ${applied.slots} 个图位，多出的 ${applied.dropped} 张参考图没用上`, 'err');
          }
        }

        const res = await Comfy.run(
          applied.api,
          (t, st, step, total) => setStatus(tag + t, st || 'running', step, total),
          x => { if (x.phase === 'step') setStatus(`${tag}生成中 ${x.step}/${x.total}`, 'running', x.step, x.total); },
          // 记下 promptId：页面刷新后靠它把任务接回来
          (pid) => { n.data.promptId = pid; queueSave(); }
        );

        n.data.promptId = '';
        collected.push(...(res.images || []));
        if (batch > 1) nodeStatus(n, `已完成 ${bi + 1}/${batch}`, 'running', bi + 1, batch);
      }

      if (!collected.length) {
        throw new Error(n.data.canceled ? '已取消' : '一张都没拿到（任务可能被中断）');
      }
      await finishGen(n, { images: collected }, { api, positive, negative, refs, wf, applied: lastApplied });
    } catch (e) {
      // 用户主动取消时，别把中断报成红色错误
      if (n.data.canceled) {
        n.data.promptId = '';
        nodeStatus(n, '已取消', 'idle');
        queueSave();
        return;
      }
      // 只是等待超时（任务还在引擎里跑）就把 promptId 留着，刷新后能自动接回
      if (!/超时/.test(String(e.message || ''))) n.data.promptId = '';
      n.data.status = 'error';
      n.data.statusText = e.message.slice(0, 80);
      const el = world.querySelector(`.cv-node[data-id="${n.id}"]`);
      if (el) { el.replaceWith(makeNodeEl(n)); }
      V.toast(e.message, 'err');
    }
  }

  /** 取消：中断正在跑的 + 清空排队里还没开始的 */
  async function cancelRun(n) {
    if (n && n.data) {
      n.data.canceled = true;
      n.data.promptId = '';
      nodeStatus(n, '已取消', 'idle');
      queueSave();
    }
    try {
      const r = await Comfy.cancelAll();
      if (!(r.interrupted || r.cleared)) {
        V.toast('引擎没回应取消请求，可能已经空闲或卡死了', 'err');
        return;
      }
      // ComfyUI 只在「每一步之间」检查中断标记：重模型一步要几分钟，
      // 所以这里如实说明，别让用户以为点了没反应。
      let pending = 0;
      try {
        const q = await Comfy.queueInfo();
        pending = [].concat(q.queue_running || [], q.queue_pending || []).length;
      } catch { }
      V.toast(pending
        ? `已发出中断，排队已清空；正在跑的这一张要等当前这一步做完才停（重模型可能要几分钟）`
        : '已取消', 'ok');
    } catch (e) {
      V.toast('取消失败：' + e.message, 'err');
    }
  }

  /** 结果收尾：入库 + 节点显示 + 另起图片节点（runGen 与「接回任务」共用） */
  async function finishGen(n, res, ctx) {
    const { api, positive, negative, refs = [], wf } = ctx || {};
    const meta = (api && Parse.parseComfy(api)) || {};
    const refIds = refs.map(r => r.data.refId || r.data.label).filter(Boolean);

    n.data.statusText = '';
    nodeStatus(n, '入库中…', 'running');
    const savedIds = [];
    for (const item of (res.images || [])) {
      try {
        const newId = await saveResultToVault(item.blob, {
          meta, positive, negative, refIds,
          workflowId: wf ? wf.id : '',
          workflowName: wf ? wf.name : ''
        });
        if (newId) savedIds.push(newId);
      } catch (e) {
        console.warn('入库失败', e);
      }
    }

    const blobs = (res.images || []).map(x => x && x.blob).filter(Boolean);
    if (!blobs.length) {
      nodeStatus(n, '完成但没有拿到图片（去「引擎出图」里手动导入）', 'idle');
      n.data.promptId = '';
      queueSave();
      return;
    }

    // 每张都生成一个稳定 URL，图片组和结果节点都用它
    const items = blobs.map((b, i) => ({
      src: URL.createObjectURL(b),
      imageId: savedIds[i] || ''
    }));

    const url = items[0].src;
    n.data.resultSrc = url;
    n.data.status = 'done';
    n.data.prog = null;
    n.data.promptId = '';

    if (items.length > 1) {
      // 多张 → 一个图片组节点，别在画布上摊一地
      addNode('group', {
        pos: { x: n.x + (n.w || 300) + 80, y: n.y },
        data: { items, active: 0, label: `图片组 · ${items.length} 张` }
      });
    } else {
      addNode('image', {
        pos: { x: n.x + (n.w || 300) + 80, y: n.y },
        data: { src: url, label: savedIds[0] || '生成结果', imageId: savedIds[0] || '' }
      });
    }

    nodeStatus(n, `完成 · ${items.length} 张 · 已存 ${savedIds.length} 张${res.viaWs ? ' · WS' : ''}${res.resumed ? ' · 刷新后接回' : ''}`, 'done');
    queueSave();
    if (savedIds.length) {
      await V.reload();
      V.renderNav();
      V.toast(`生成完成，已存入图库：${savedIds.join('、')}`, 'ok');
    } else {
      V.toast('生成完成（未入库）', 'ok');
    }
  }

  /** 页面刷新后：把还带着 promptId 的节点接回引擎里的任务；顺便清理「僵在生成中」的节点 */
  let resumedOnce = false;
  async function resumePending() {
    if (resumedOnce) return;
    resumedOnce = true;
    const nodes = ((cv && cv.nodes) || []).filter(x => x && (x.type === 'gen' || x.type === 'simple') && x.data);
    const pend = nodes.filter(x => x.data.promptId);

    // 没有 promptId 却挂着「生成中」的：十有八九是刷新/断线时冻住的，
    // 先问引擎还有没有活干，没有就复位，别让节点一直转圈。
    const stale = nodes.filter(x => !x.data.promptId && x.data.status === 'running');
    if (stale.length) {
      let busy = 0;
      try {
        const q = await Comfy.queueInfo();
        busy = [].concat(q.queue_running || [], q.queue_pending || []).length;
      } catch { busy = 1; }   // 问不到就别乱复位
      if (!busy) {
        stale.forEach(x => nodeStatus(x, '上次的生成已中断（点生成重来）', 'idle'));
        queueSave();
      }
    }

    if (!pend.length) return;

    for (const n of pend) {
      const pid = n.data.promptId;
      nodeStatus(n, '正在接回刷新前的任务…', 'running');
      try {
        const res = await Comfy.waitFor(pid, t => nodeStatus(n, t, 'running'));
        const inputs = incoming(n);
        const prompts = inputs.filter(x => x.type === 'prompt');
        const positive = n.type === 'simple'
          ? (n.data.text || '')
          : (prompts.find(p => p.data.role !== '负向')?.data.text || '');
        const negative = n.type === 'simple'
          ? (n.data.neg || '')
          : (prompts.find(p => p.data.role === '负向')?.data.text || '');
        const wf = V.state.workflows.find(w => w.id === n.data.workflowId);
        let api = null;
        try { api = wf ? JSON.parse(wf.content) : null; } catch { }
        n.data.promptId = '';
        await finishGen(n, res, { api, positive, negative, refs: [], wf });
      } catch (e) {
        n.data.promptId = '';
        nodeStatus(n, '上次任务没接上：' + String(e.message || e).slice(0, 40), 'idle');
        queueSave();
      }
    }
  }

  /* ============================================================
     生成结果 → 图库
     ============================================================ */
  async function saveResultToVault(blob, ctx) {
    if (location.protocol === 'file:') return null;

    const cats = V.state.categories;
    const cat = cats.find(c => c.name === '未分类') || cats[0];
    if (!cat) return null;

    const meta = ctx.meta || {};
    const seq = await DB.nextSeq(cat.id);
    const prefix = cat.prefix || 'GEN';
    const id = `${prefix}-${U.pad(seq, 4)}`;

    const blobId = U.uid('bl');
    const thumbId = U.uid('th');
    await DB.putBlob(blobId, blob, { kind: 'original' });
    const thumb = await Parse.makeThumb(blob, 640, 0.85);
    await DB.putBlob(thumbId, thumb, { kind: 'thumb' });

    // 模型库匹配
    const modelLow = String(meta.model || '').toLowerCase();
    const matched = modelLow
      ? V.state.models.find(m => m.name.toLowerCase() === modelLow)
        || V.state.models.find(m => modelLow.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(modelLow))
        || V.state.models.find(m => m.base && modelLow.includes(String(m.base).toLowerCase()))
      : null;

    const loraNames = (meta.loras || []).map(l => l.name || l).filter(Boolean);
    const loraIds = loraNames.map(n => V.matchLoraId(n)).filter(Boolean);

    const ext = (blob.type || '').includes('png') ? 'png'
      : (blob.type || '').includes('webp') ? 'webp' : 'jpg';

    const now = Date.now();
    const pv = V.newVersion(
      ctx.positive || '', ctx.negative || '',
      'canvas', `画布生成 · ${ctx.workflowName || '工作流'}`
    );

    const tags = [
      ctx.workflowName,
      meta.model,
      ...loraNames
    ].filter(Boolean);

    await DB.put('images', {
      id,
      categoryId: cat.id,
      modelId: matched ? matched.id : '',
      blobId, thumbId,
      filename: `${id}.${ext}`,
      size: blob.size,
      mime: blob.type || 'image/png',
      width: meta.width || null,
      height: meta.height || null,
      favorite: false,
      tags: [...new Set(tags)].slice(0, 12),
      note: `画布生成 · ${ctx.workflowName || '工作流'}${ctx.refIds?.length ? ' · 参考 ' + ctx.refIds.join('/') : ''}`,

      // 来源与生成链路
      source: 'canvas',
      canvasId: cv?.id || '',
      canvasName: cv?.name || '',
      workflowId: ctx.workflowId || '',
      workflowName: ctx.workflowName || '',
      promptNodeText: ctx.positive || '',
      refIds: ctx.refIds || [],

      // 参数
      modelName: meta.model || '',
      loraNames,
      loraIds,
      sampler: meta.sampler || '',
      scheduler: meta.scheduler || '',
      steps: meta.steps ?? null,
      cfg: meta.cfg ?? null,
      seed: meta.seed != null ? String(meta.seed) : '',
      denoise: meta.denoise ?? null,

      prompts: [pv],
      activePromptId: pv.id,
      createdAt: now,
      updatedAt: now
    });

    return id;
  }

  /* ============================================================
     绑定工作流
     ============================================================ */
  function pickWorkflow(n) {
    const wfs = (V.state.workflows || []).filter(w => {
      // 只列出能直接提交的 API 格式；UI 格式绑了也跑不了，不列出来
      return !String(w.content || '').includes('"nodes"');
    });
    if (!wfs.length) return V.toast('还没有可用的工作流，先点顶部「导入工作流」', 'err');

    V.openModal({
      title: '绑定工作流',
      sub: '生成节点会把提示词和参考图写进这个工作流再提交',
      wide: true,
      body: `<div class="entity-list">
        ${wfs.map(w => {
          return `<div class="entity">
            <div class="entity-mark">${V.icon('flow', 15)}</div>
            <div class="entity-main">
              <b>${esc(w.name)}</b>
            </div>
            <button class="btn sm ${n.data.workflowId === w.id ? 'primary' : ''}" data-bindwf="${w.id}">
              ${n.data.workflowId === w.id ? '已绑定' : '绑定'}
            </button>
          </div>`;
        }).join('')}
      </div>`,
      footer: `<button class="btn" data-close>关闭</button>`,
      onMount: (box, close) => {
        box.querySelectorAll('[data-bindwf]').forEach(b => b.onclick = () => {
          const w = wfs.find(x => x.id === b.dataset.bindwf);
          pushHistory();
          n.data.workflowId = w.id;
          n.data.wfName = w.name;
          try {
            const j = JSON.parse(w.content || '{}');
            if (!j.nodes) {
              const info = Comfy.analyzeApi(j);
              n.data.model = info.model || '';
              n.data.imageSlots = info.imageIds.length;
            }
          } catch { }
          close();
          renderAll();
          queueSave();
          V.toast('已绑定：' + w.name, 'ok');
        });
      }
    });
  }

  /* ============================================================
     工作流导入 → 识别为画布
     ============================================================ */
  async function importWorkflow() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      const name = f.name.replace(/\.json$/i, '');
      try {
        const text = await f.text();
        const json = JSON.parse(text);
        const r = await buildFromWorkflow(json, name);

        // 导入 = 铺出「正向提示词 / 负向提示词 / 输出」三个节点并连线
        if (r.bindWfId) {
          addSimpleFlow(r.bindWfId, { pos: { x: 90, y: 100 } });
          await packAdd(r.bindWfId, name);
          renderAll();
          await persist();
          await fitView();
          V.toast(`已导入：${name}（正向提示词 · 负向提示词 · 输出）`, 'ok');
        } else if (r.convertError) {
          renderAll();
          V.toast(`转 API 失败：${r.convertError}`, 'err');
        } else if (r.count) {
          V.toast(`已识别 ${r.count} 个节点`, 'ok');
        }
      } catch (e) {
        V.toast('导入失败：' + e.message, 'err');
      }
    };
    inp.click();
  }

  async function buildFromWorkflow(json, name) {
    const isUI = Array.isArray(json.nodes);
    const isApi = !isUI && Object.values(json).some(v => v && v.class_type);
    if (!isUI && !isApi) throw new Error('既不是 UI 格式也不是 API 格式');

    const baseWf = {
      id: U.uid('wf'),
      name: name || '导入的工作流',
      modelId: '',
      format: isUI ? 'ui-json' : 'api-json',
      filename: (name || 'workflow') + '.json',
      size: JSON.stringify(json).length,
      nodes: isUI ? json.nodes.length : Object.keys(json).length,
      content: JSON.stringify(json),
      note: isUI ? 'UI 格式' : 'API 格式（可提交）',
      createdAt: Date.now()
    };

    // UI 格式：顺手转一份 API 格式出来
    let bindWf = baseWf;
    let convertError = '';
    let stats = null;
    let layout = null;   // 每个节点的 widgets_values 分别对应哪些输入名

    if (isUI) {
      V.toast('正在读取 ComfyUI 节点定义…');
      try {
        const info = await Comfy.objectInfoCached();
        layout = {};
        json.nodes.forEach(nd => {
          if (!nd || nd.id == null) return;
          const l = Comfy.widgetKeysOf(nd, info);
          if (l) layout[nd.id] = l;
        });
        const r = Comfy.uiToApi(json, info);
        stats = r.stats;
        const apiWf = {
          ...baseWf,
          id: U.uid('wf'),
          name: (name || '工作流') + ' · API',
          format: 'api-json',
          note: `由 UI 格式自动转换 · ${r.stats.nodes} 节点 / ${r.stats.links} 连线`,
          content: JSON.stringify(r.api)
        };
        await DB.put('workflows', apiWf);
        bindWf = apiWf;
        if (r.warnings.length) console.warn('[工作流转换]', r.warnings);
      } catch (e) {
        convertError = e.message;
      }
    }

    if (isUI) {
      if (convertError) baseWf.note = `UI 格式 · 转 API 失败：${convertError}`;
    }

    await DB.put('workflows', baseWf);
    await V.reload();

    // 不再把完整工作流节点图铺上画布 —— 画布只放「正向/负向提示词 → 输出」三个节点
    // 这里只清空画布并返回可提交的工作流 id，由调用方 addSimpleFlow 铺三个节点
    cv.nodes = [];
    cv.edges = [];
    cv.name = name || '导入的工作流';
    cv.view = { x: 40, y: 40, k: 0.7 };
    cv.wfSrc = {
      uiWfId: baseWf.id,
      apiWfId: bindWf !== baseWf ? bindWf.id : '',
      json: isUI ? json : null
    };

    renderAll();
    await persist();
    fitView();
    return {
      count: 0,
      converted: bindWf !== baseWf,
      convertError,
      stats,
      // 能直接跑的那套（API 格式）的 id —— 用它铺「正向/负向/输出」三节点
      bindWfId: bindWf && (isApi || bindWf !== baseWf) ? bindWf.id : ''
    };
  }

  /* ============================================================
     工作流节点编辑 → 回写（改参数 / 旁路 / 删节点）
     ============================================================ */
  const wfSrc = () => (cv && cv.wfSrc) || null;

  /** 把画布上某个 wf 节点的改动写回源工作流，并重新生成可提交的 API 版 */
  async function syncWfNode(n, opts = {}) {
    const src = wfSrc();

    // UI 格式：改原始 JSON → 重新转 API（旁路、删节点这类结构改动也走这条路）
    if (src && src.json) {
      const jn = (src.json.nodes || []).find(x => String(x.id) === String(n.data.rawId));
      if (jn) {
        if (n.data.widgets) jn.widgets_values = [...n.data.widgets];
        if (n.data.mode != null) jn.mode = n.data.mode;
      }
      return regenerateApi(opts);
    }

    // API 格式：直接改对应输入
    if (!src || !src.apiWfId) {
      if (!opts.silent) V.toast('这个画布不是从工作流导入的，改了也没地方同步', 'err');
      return false;
    }
    const wf = V.state.workflows.find(w => w.id === src.apiWfId);
    if (!wf) return false;
    const api = JSON.parse(wf.content || '{}');
    const id = String(n.data.apiId);
    if (api[id]) {
      (n.data.keys || []).forEach((k, i) => { api[id].inputs[k] = n.data.widgets[i]; });
      wf.content = JSON.stringify(api);
      await DB.put('workflows', wf);
      await refreshBoundMeta(wf.id, api);
      await V.reload();
      queueSave();
      return true;
    }
    return false;
  }

  /** 用画布上记的 UI 源重新转一次 API 工作流 */
  async function regenerateApi(opts = {}) {
    const src = wfSrc();
    if (!src || !src.json) return false;
    let info;
    try { info = await Comfy.objectInfoCached(); }
    catch (e) {
      if (!opts.silent) V.toast('改了，但同步不到 API 版：' + e.message, 'err');
      return false;
    }
    let r;
    try { r = Comfy.uiToApi(src.json, info); }
    catch (e) {
      if (!opts.silent) V.toast('重新转换失败：' + e.message, 'err');
      return false;
    }

    let wf = src.apiWfId && V.state.workflows.find(w => w.id === src.apiWfId);
    if (!wf) {
      wf = {
        id: U.uid('wf'), name: (cv.name || '画布') + ' · API', modelId: '',
        format: 'api-json', filename: 'canvas-api.json',
        size: JSON.stringify(r.api).length, nodes: Object.keys(r.api).length,
        content: JSON.stringify(r.api), note: '由画布上的节点改动自动生成',
        createdAt: Date.now()
      };
      src.apiWfId = wf.id;
      await DB.put('workflows', wf);
      cv.nodes.forEach(x => {
        if ((x.type === 'gen' || x.type === 'simple') && !x.data.workflowId) {
          x.data.workflowId = wf.id;
          x.data.wfName = wf.name;
        }
      });
    } else {
      wf.content = JSON.stringify(r.api);
      await DB.put('workflows', wf);
    }

    await V.reload();
    await refreshBoundMeta(wf.id, r.api);
    renderAll();
    queueSave();
    return true;
  }

  /** 绑定了这套工作流的生成/简易节点，刷新模型名与图位数 */
  async function refreshBoundMeta(wfId, api) {
    const a = Comfy.analyzeApi(api);
    (cv?.nodes || []).forEach(x => {
      if ((x.type === 'gen' || x.type === 'simple') && x.data.workflowId === wfId) {
        x.data.model = a.model || x.data.model || '';
        x.data.imageSlots = a.imageIds.length;
      }
    });
  }

  async function toggleBypass(n) {
    const src = wfSrc();
    if (!src || !src.json) return V.toast('只有 UI 格式导入的工作流才能切换旁路', 'err');
    pushHistory();
    n.data.mode = n.data.mode === 4 ? 0 : 4;
    const ok = await syncWfNode(n);
    renderAll();
    if (ok) V.toast(n.data.mode === 4 ? '已旁路：连线会绕开它（等于临时关掉 LoRA / 插件）' : '已恢复启用', 'ok');
  }

  async function deleteWfNode(n) {
    const src = wfSrc();
    if (src && src.json) {
      const id = String(n.data.rawId);
      pushHistory();
      src.json.nodes = (src.json.nodes || []).filter(x => String(x.id) !== id);
      src.json.links = (src.json.links || []).filter(l => {
        const o = Array.isArray(l) ? String(l[1]) : String(l?.origin_id);
        const t = Array.isArray(l) ? String(l[3]) : String(l?.target_id);
        return o !== id && t !== id;
      });
      removeNode(n.id);
      const ok = await regenerateApi();
      if (ok) V.toast('已从这个工作流里删掉该节点，并重新生成 API 版', 'ok');
      return;
    }
    removeNode(n.id);
  }

  /** 生成节点 ⇄ 简易节点 */
  function toSimple(n) {
    if (!n.data.workflowId) return V.toast('先给它绑定一个工作流', 'err');
    pushHistory();
    n.type = 'simple';
    n.w = 300;
    n.data.text = n.data.text || '';
    n.data.neg = n.data.neg || '';
    renderAll(); queueSave();
    V.toast('已变成简易节点：只留提示词和参考图', 'ok');
  }

  function toGen(n) {
    pushHistory();
    n.type = 'gen';
    n.w = 320;
    renderAll(); queueSave();
  }

  /** 从一套工作流铺出「正向提示词 → 输出 ← 负向提示词」三个节点并连线 */
  function addSimpleFlow(wfId, extra = {}) {
    const wf = (V.state.workflows || []).find(w => w.id === wfId);
    if (!wf) return V.toast('找不到这套工作流', 'err');
    let slots = 0, model = '';
    try {
      const j = JSON.parse(wf.content || '{}');
      if (!j.nodes) {
        const info = Comfy.analyzeApi(j);
        slots = info.imageIds.length;
        model = info.model || '';
      }
    } catch { }

    const base = extra.pos || centerSpawn();
    const col = 300, row = 240;

    const posPrompt = addNode('prompt', {
      pos: { x: base.x, y: base.y },
      w: 300,
      data: { text: extra.text || '', role: '正向' }
    });
    const negPrompt = addNode('prompt', {
      pos: { x: base.x, y: base.y + row },
      w: 300,
      data: { text: extra.neg || '', role: '负向' }
    });

    // 参考图节点：工作流有图位时铺出来（默认 1 个，用户可自行增删）
    const refCount = extra.refCount != null ? extra.refCount : (slots > 0 ? 1 : 0);
    const refNodes = [];
    for (let i = 0; i < refCount; i++) {
      const rn = addNode('ref', {
        pos: { x: base.x + col, y: base.y + row / 2 + 260 + i * 230 },
        w: 200,
        data: { src: '', label: '参考图' + (refCount > 1 ? ' ' + (i + 1) : '') }
      });
      refNodes.push(rn);
    }

    const out = addNode('gen', {
      pos: { x: base.x + col, y: base.y + row / 2 },
      w: 300,
      data: {
        workflowId: wf.id,
        wfName: wf.name,
        model,
        imageSlots: slots,
        status: 'idle', statusText: ''
      }
    });

    // 连线：正向 → 输出 ← 负向；参考图 → 输出
    cv.edges.push({ id: U.uid('e'), from: posPrompt.id, to: out.id });
    cv.edges.push({ id: U.uid('e'), from: negPrompt.id, to: out.id });
    refNodes.forEach(rn => cv.edges.push({ id: U.uid('e'), from: rn.id, to: out.id }));

    renderAll();
    queueSave();
    return out;
  }

  // 兼容旧名：有些地方还在用 addSimpleNode
  function addSimpleNode(wfId, extra = {}) {
    return addSimpleFlow(wfId, extra);
  }

  /** 给输出节点加一个参考图节点并连线 */
  function addRefToOutput(out) {
    pushHistory();
    const count = cv.edges.filter(e => e.to === out.id)
      .map(e => nodeById(e.from)).filter(x => x && x.type === 'ref').length;
    const rn = addNode('ref', {
      pos: { x: out.x + (out.w || 300), y: out.y + 100 + count * 230 },
      w: 200,
      data: { src: '', label: '参考图 ' + (count + 1) }
    });
    cv.edges.push({ id: U.uid('e'), from: rn.id, to: out.id });
    renderAll();
    queueSave();
  }

  function toXY(v) {
    if (!v) return null;
    if (Array.isArray(v)) return { x: Number(v[0]) || 0, y: Number(v[1]) || 0 };
    if (typeof v === 'object') return { x: Number(v[0] ?? v.x) || 0, y: Number(v[1] ?? v.y) || 0 };
    return null;
  }

  /* ============================================================
     视图控制
     ============================================================ */
  function fitView() {
    if (!cv || !world || !host || !cv.nodes.length) return;
    const els = [...world.querySelectorAll('.cv-node')];
    if (!els.length) return;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    cv.nodes.filter(visibleNode).forEach(n => {
      const el = world.querySelector(`.cv-node[data-id="${n.id}"]`);
      const w = n.w || el?.offsetWidth || 220;
      const h = el?.offsetHeight || 140;
      x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
      x2 = Math.max(x2, n.x + w); y2 = Math.max(y2, n.y + h);
    });
    const vp = host.querySelector('#cv-viewport');
    const rect = vp.getBoundingClientRect();
    const pad = 70;
    const k = Math.min(1.2, Math.max(MIN_K,
      Math.min((rect.width - pad * 2) / (x2 - x1), (rect.height - pad * 2) / (y2 - y1))));
    cv.view.k = k;
    cv.view.x = (rect.width - (x2 - x1) * k) / 2 - x1 * k;
    cv.view.y = (rect.height - (y2 - y1) * k) / 2 - y1 * k;
    applyTransform();
    queueSave();
  }

  /* ============================================================
     画布列表
     ============================================================ */
  function canvasListModal() {
    V.openModal({
      title: '画布',
      sub: `${list.length} 个画布`,
      wide: true,
      body: `<div class="entity-list">
        ${list.map(c => `<div class="entity ${c.id === cv.id ? 'is-cur' : ''}">
          <div class="entity-mark">${V.icon('layers', 15)}</div>
          <div class="entity-main">
            <b>${esc(c.name)}</b>
            <small>${(c.nodes || []).length} 节点 · ${(c.edges || []).length} 连线 · ${U.relTime(c.updatedAt)}</small>
          </div>
          <div class="entity-ops">
            <button class="btn sm" data-cvopen="${c.id}">${c.id === cv.id ? '当前' : '打开'}</button>
            <button class="icon-btn" data-cvren="${c.id}" title="重命名">${V.icon('edit', 14)}</button>
            <button class="icon-btn" data-cvdel="${c.id}" title="删除">${V.icon('trash', 14)}</button>
          </div>
        </div>`).join('')}
      </div>`,
      footer: `<button class="btn" data-close>关闭</button>
               <button class="btn primary" data-cvnew>${V.icon('plus', 14)} 新建画布</button>`,
      onMount: (box, close) => {
        box.querySelectorAll('[data-cvopen]').forEach(b => b.onclick = async () => {
          await persist();
          cv = list.find(c => c.id === b.dataset.cvopen);
          close(); renderAll();
        });
        box.querySelectorAll('[data-cvdel]').forEach(b => b.onclick = async () => {
          const id = b.dataset.cvdel;
          if (list.length <= 1) return V.toast('至少保留一个画布', 'err');
          await DB.del('canvases', id);
          await loadList();
          if (cv.id === id) cv = list[0];
          close(); renderAll();
          V.toast('已删除', 'ok');
        });
        box.querySelectorAll('[data-cvren]').forEach(b => b.onclick = async () => {
          const c2 = list.find(c => c.id === b.dataset.cvren);
          const name = prompt('画布名称', c2.name);
          if (!name) return;
          c2.name = name.trim();
          await DB.put('canvases', c2);
          await loadList();
          if (c2.id === cv.id) cv.name = c2.name;
          close(); renderAll();
        });
        box.querySelector('[data-cvnew]').onclick = async () => {
          await persist();
          cv = newCanvas('画布 ' + (list.length + 1));
          await persist();
          close(); renderAll();
        };
      }
    });
  }

  /* ============================================================
     从引擎 output 目录导入出图（刷新丢了结果、或在 ComfyUI 里直接跑的图）
     ============================================================ */
  async function importOutputFile(name) {
    const blob = await Comfy.fetchImage({ filename: name, subfolder: '', type: 'output' });
    let meta = {};
    try {
      const texts = await Parse.readPngText(await blob.arrayBuffer());
      const api = JSON.parse(texts.prompt || texts.workflow || '{}');
      meta = Parse.parseComfy(api) || {};
    } catch { /* 没有内嵌参数也能存 */ }
    return await saveResultToVault(blob, {
      meta,
      positive: meta.positive || '',
      negative: meta.negative || '',
      workflowName: '引擎出图'
    });
  }

  async function outputsModal() {
    let data;
    try { data = await Comfy.outputs(60); }
    catch (e) { return V.toast('拿不到出图目录：' + e.message, 'err'); }
    const items = data.items || [];
    if (!items.length) return V.toast('引擎的 output 目录里还没有图', 'err');

    const fmt = t => {
      const d = new Date(t * 1000);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const rows = items.map((it, i) => `
      <div class="out-row" data-out-i="${i}">
        <div class="out-main">
          <b>${esc(it.name)}</b>
          <span>${U.fmtSize(it.size)} · ${esc(fmt(it.mtime))}</span>
        </div>
        <button class="btn sm" data-out-one="${esc(it.name)}">导入</button>
      </div>`).join('');

    V.openModal({
      title: '引擎出图 · 导入到图库',
      sub: esc(data.dir || '') + ` · 共 ${data.total || items.length} 张`,
      wide: true,
      body: `<p class="hint" style="margin:0 0 10px">这里列的是 ComfyUI <code>output/</code> 目录里的图。刷新页面丢了结果的、或者你在 ComfyUI 界面里直接跑出来的，都能从这里收进 Loom（PNG 内嵌参数会自动解析）。</p>
             <div class="out-list">${rows}</div>`,
      footer: `<button class="btn" data-close>关闭</button>
               <button class="btn primary" id="out-import-all">全部导入（${items.length}）</button>`,
      onMount: (box, close) => {
        const doOne = async (name, btn) => {
          const old = btn ? btn.textContent : '';
          if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
          try {
            const id = await importOutputFile(name);
            V.toast(id ? `已入库：${id}` : '这张没存进去（可能在 file:// 下打开）', id ? 'ok' : 'err');
            return !!id;
          } catch (e) {
            V.toast('导入失败：' + e.message, 'err');
            return false;
          } finally {
            if (btn) { btn.disabled = false; btn.textContent = old; }
          }
        };

        box.querySelectorAll('[data-out-one]').forEach(b => {
          b.onclick = () => doOne(b.dataset.outOne, b);
        });

        const all = box.querySelector('#out-import-all');
        if (all) all.onclick = async () => {
          all.disabled = true;
          const total = items.length;
          let done = 0;
          for (let i = 0; i < total; i++) {
            all.textContent = `导入中 ${i + 1}/${total}…`;
            if (await doOne(items[i].name, null)) done++;
          }
          all.textContent = `完成 ${done}/${total}`;
          await V.reload();
          V.renderNav();
          V.toast(`已导入 ${done} 张`, done ? 'ok' : 'err');
          close();
        };
      }
    });
  }

  /* ============================================================
     高级选项：模型 / LoRA 等文件路径
     ============================================================ */
  async function advancedModal() {
    // 读当前引擎状态、已配路径，以及后端自动识别到的模型目录
    let st = {}, dirs = [], scan = { found: {}, files: {}, roots: [] };
    try { st = await Comfy.engineStatus(); } catch { st = {}; }
    try { dirs = (await Comfy.listDir('~')).entries?.filter(e => e.dir)?.map(e => e.path) || []; } catch { }
    try { scan = (await Comfy.scanModels()) || scan; } catch { }

    const PATH_FIELDS = [
      { key: 'checkpoints', label: '底模（checkpoints）', hint: '.safetensors / .ckpt 完整模型' },
      { key: 'diffusion_models', label: '扩散模型（diffusion_models）', hint: 'Flux、Krea、Qwen 等分离式 UNET' },
      { key: 'clip', label: 'CLIP（clip）', hint: '文本编码器' },
      { key: 'text_encoders', label: '文本编码器（text_encoders）', hint: 'Flux 等新模型的 T5/CLIP' },
      { key: 'vae', label: 'VAE', hint: '.safetensors' },
      { key: 'loras', label: 'LoRA（loras）', hint: 'LoRA 文件所在目录' },
    ];

    const paths = st.paths || {};
    const found = scan.found || {};
    const counts = scan.files || {};
    const partials = scan.partial || {};
    const partialOf = (k) => (partials[k] ? `（另有 ${partials[k]} 个正在下载）` : '');
    // 已手工配置的优先；没配过就用自动识别到的填进去
    const valOf = (k) => paths[k] || found[k] || '';
    // 自动挂载进配置的路径也标成「自动识别」：只要它和扫描结果一致
    const isAuto = (k) => !!found[k] && (!paths[k] || paths[k] === found[k]);
    const autoKeys = PATH_FIELDS.map(f => f.key).filter(isAuto);
    const setKeys = PATH_FIELDS.map(f => f.key).filter(k => paths[k] && paths[k] !== found[k]);
    const rootsTxt = (scan.roots || []).map(r => r.label).join(' · ');

    const field = (f) => `
      <div class="field">
        <label>${esc(f.label)}${isAuto(f.key) ? '<em class="auto-tag">自动识别</em>' : ''}</label>
        <input type="text" data-path="${f.key}" placeholder="绝对路径，如 /Users/xxx/models/checkpoints"
               value="${esc(valOf(f.key))}">
        <span class="hint">${isAuto(f.key)
        ? `已找到 ${counts[f.key] || 0} 个模型${partialOf(f.key)} · ${esc(f.hint)}`
        : esc(f.hint)}</span>
      </div>`;

    V.openModal({
      title: '高级选项 · 模型路径',
      sub: '把本地模型 / LoRA 目录指过来，Loom 写进引擎的 extra_model_paths.yaml，无需复制文件',
      wide: true,
      body: `
        <div class="pk-sec">
          ${autoKeys.length
        ? `<div class="adv-auto">✓ 已自动识别 ${autoKeys.length} 类模型目录${rootsTxt ? `（扫描：${esc(rootsTxt)}）` : ''}，直接点「保存路径」即可生效</div>`
        : setKeys.length
          ? `<div class="adv-auto">已配置 ${setKeys.length} 类模型目录，引擎启动时会自动挂载。想重新识别：把对应输入框清空再保存。</div>`
          : `<div class="adv-auto none">没自动找到模型目录。把模型放到 <code>${esc(((scan.comfy_dir || 'ComfyUI').replace(/\/ComfyUI$/, '')) + '/models')}</code> 下（checkpoints / loras / vae / text_encoders），再打开这里就会自动认出来。</div>`}
          <div class="form-grid">${PATH_FIELDS.map(field).join('')}</div>
          ${(!autoKeys.length && dirs.length) ? `<div class="hint" style="margin-top:10px">家目录下的文件夹：${dirs.map(d => `<code>${esc(d)}</code>`).join(' ')}</div>` : ''}
        </div>
        <div class="pk-sec">
          <h3>引擎状态</h3>
          <p class="sub" id="adv-stat">
            ${st.running
        ? `<span style="color:var(--ok)">✓ 引擎运行中</span>（端口 ${esc(String(st.port || 8188))}）`
        : `<span style="color:var(--text-3)">引擎未运行</span> —— 点「生成」时会自动拉起`}
          </p>
          ${st.log_tail ? `<details><summary>最近启动日志</summary><pre style="white-space:pre-wrap;font-size:11px;color:var(--text-3)">${esc(st.log_tail)}</pre></details>` : ''}
        </div>`,
      footer: `<button class="btn" data-close>取消</button>
               <button class="btn primary" id="adv-save">保存路径</button>`,
      onMount: (box, close) => {
        box.querySelector('#adv-save').onclick = async () => {
          const mapping = {};
          box.querySelectorAll('[data-path]').forEach(inp => {
            const v = inp.value.trim();
            if (v) mapping[inp.dataset.path] = v;
          });
          try {
            await Comfy.setEnginePaths(mapping);
            close();
            if (st.running) {
              V.toast('已保存，正在重启引擎让路径生效…', 'ok');
              Comfy.restartEngine()
                .then(() => V.toast('引擎已重启，模型路径生效', 'ok'))
                .catch((e) => V.toast('引擎重启失败：' + e.message, 'err'));
            } else {
              V.toast('路径已保存，下次启动引擎时生效', 'ok');
            }
          } catch (e) {
            V.toast('保存失败：' + e.message, 'err');
          }
        };
      }
    });
  }

  /* ============================================================
     简易节点包
     ============================================================ */
  async function packRead() {
    const s = await DB.getSettings().catch(() => ({}));
    return Array.isArray(s.simplePack) ? s.simplePack : [];
  }
  async function packWrite(arr) {
    await DB.setSetting('simplePack', arr.slice(0, 60)).catch(() => { });
  }
  async function packAdd(wfId, name) {
    const arr = (await packRead()).filter(x => x.wfId !== wfId);
    arr.unshift({ wfId, name, at: Date.now() });
    await packWrite(arr);
  }
  async function packRemove(wfId) {
    await packWrite((await packRead()).filter(x => x.wfId !== wfId));
  }

  async function simplePackModal() {
    const pack = await packRead();

    V.openModal({
      title: '简易节点包',
      sub: '导入过的工作流都会自动收在这里，点一下就能放上画布生图',
      wide: true,
      body: `
        <div class="pk-sec">
          <div class="entity-list">
            ${pack.map(p => {
              const wf = (V.state.workflows || []).find(w => w.id === p.wfId);
              const note = wf?.note || '';
              // 把 note 里的 URL 转成可点击链接
              const noteHtml = esc(note).replace(/(https?:\/\/[^\s，。；]+)/g,
                '<a href="$1" target="_blank" rel="noopener">$1</a>');
              return `<div class="entity-row">
                <div class="entity-mark">${V.icon('layers', 15)}</div>
                <div class="entity-main">
                  <b>${esc(p.name || p.wfId)}</b>
                  ${note ? `<span class="entity-sub">${noteHtml}</span>` : ''}
                </div>
                <button class="btn sm primary" data-packadd="${esc(p.wfId)}">放上画布</button>
                <button class="btn sm" data-packdel="${esc(p.wfId)}" title="移出这个包">${V.icon('close', 14)}</button>
              </div>`;
            }).join('') || `<div class="empty">
                ${V.icon('layers', 34)}<b>还没收录工作流</b>
                <span>点顶部「导入工作流」选一个 ComfyUI 工作流，会自动打包成简易节点并收在这里</span>
              </div>`}
          </div>
        </div>`,
      footer: '<button class="btn" data-close>关闭</button>',
      onMount: (box, close) => {
        box.querySelectorAll('[data-packadd]').forEach(b => b.onclick = async () => {
          const id = b.dataset.packadd;
          const wf = (V.state.workflows || []).find(w => w.id === id);
          if (!wf) return V.toast('这套工作流已经不在库里了', 'err');
          addSimpleNode(id);
          await packAdd(id, wf.name);
          close();
          V.toast('已放上画布：' + wf.name, 'ok');
        });

        box.querySelectorAll('[data-packdel]').forEach(b => b.onclick = async () => {
          await packRemove(b.dataset.packdel);
          b.closest('.entity-row')?.remove();
          V.toast('已移出节点包（工作流本身没删）', 'ok');
        });
      }
    });
  }

  /* ============================================================
     全局动作
     ============================================================ */
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-cv]');
    if (!t) return;
    const a = t.dataset.cv;
    if (a === 'fit') fitView();
    if (a === 'reset') {
      cv.view = { x: 80, y: 60, k: 1 };
      applyTransform();
    }
    if (a === 'exit') V.go('gallery');
    if (a === 'zoom100') {
      cv.view.k = 1;
      applyTransform();
      queueSave();
    }
    if (a === 'undo') undo();
    if (a === 'redo') redo();
    if (a === 'import-wf') importWorkflow();
    if (a === 'list') canvasListModal();
    if (a === 'pack') simplePackModal();
    if (a === 'adv') advancedModal();
    if (a === 'outputs') outputsModal();
  });

  return {
    get current() { return cv; },
    newCanvas, importWorkflow, buildFromWorkflow, fitView,
    undo, redo, sendImage,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0
  };
})();
