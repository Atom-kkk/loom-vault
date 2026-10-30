/* ============================================================
   app.js — 应用外壳、图库、灯箱、上传、提示词版本链
   ============================================================ */

window.Vault = (function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const state = {
    view: 'gallery',
    images: [],
    categories: [],
    models: [],
    loras: [],
    workflows: [],
    settings: {},
    filter: { q: '', categoryId: '', modelId: '', fav: false, sort: 'new' },
    lb: { list: [], index: 0 },
    aiCfg: null,
    busy: false
  };

  const views = {};
  const actions = {};
  const urlCache = new Map();
  let io = null;

  /* ============================================================
     基础工具
     ============================================================ */
  function toast(msg, type = '') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, type === 'err' ? 4200 : 2400);
  }

  function icon(name, size = 16) {
    const p = {
      upload: '<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
      close: '<path d="M6 6l12 12M18 6L6 18"/>',
      star: '<path d="M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 17l-5.3 2.8 1.1-5.9L3.5 9.8l5.9-.8z"/>',
      down: '<path d="M12 4v12m0 0l-4.5-4.5M12 16l4.5-4.5"/><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>',
      trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
      edit: '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/>',
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
      spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
      left: '<path d="M15 5l-7 7 7 7"/>',
      right: '<path d="M9 5l7 7-7 7"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      img: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.6"/><path d="M21 15l-5-5L5 21"/>',
      layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
      cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
      flow: '<rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M6.5 10v4a2 2 0 0 0 2 2H14"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      check: '<path d="M5 13l4.5 4.5L19 7"/>',
      link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
      back: '<path d="M11 5l-7 7 7 7"/><path d="M4 12h16"/>',
      user: '<circle cx="12" cy="8.2" r="3.7"/><path d="M4.6 20.2a7.4 7.4 0 0 1 14.8 0"/>',
      shirt: '<path d="M9 3l3 2 3-2 5 2.6-1.8 4.2-2.2-.9V21H8V8.9l-2.2.9L4 5.6z"/>',
      undo: '<path d="M4 9h9.5a4.5 4.5 0 0 1 0 9H9"/><path d="M7.5 5.5L4 9l3.5 3.5"/>',
      redo: '<path d="M20 9h-9.5a4.5 4.5 0 0 0 0 9H15"/><path d="M16.5 5.5L20 9l-3.5 3.5"/>'
    };
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p[name] || ''}</svg>`;
  }

  function on(act, fn) { actions[act] = fn; }

  /* ============================================================
     弹窗
     ============================================================ */
  let modalCloser = null;

  function openModal({ title, sub = '', body = '', footer = '', wide = false, narrow = false, onMount = null, dismissible = true }) {
    const root = $('#modal');
    root.classList.remove('hidden');
    root.innerHTML = `
      <div class="modal-box ${wide ? 'wide' : ''} ${narrow ? 'narrow' : ''}" role="dialog">
        <div class="modal-head">
          <div><h2>${U.esc(title)}</h2>${sub ? `<p class="sub">${U.esc(sub)}</p>` : ''}</div>
          <div class="spacer"></div>
          <button class="icon-btn" data-close title="关闭">${icon('close', 15)}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;

    const close = () => {
      root.classList.add('hidden');
      root.innerHTML = '';
      modalCloser = null;
      document.dispatchEvent(new CustomEvent('modal:closed'));
    };
    modalCloser = close;

    root.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
    if (dismissible) {
      root.onclick = e => { if (e.target === root) close(); };
    } else {
      root.onclick = null;
    }
    if (onMount) onMount(root.querySelector('.modal-box'), close);
    return close;
  }

  function confirmDialog({ title, message, danger = false, okText = '确定', cancelText = '取消' }) {
    return new Promise(resolve => {
      let done = false;
      const close = openModal({
        title, narrow: true,
        body: `<p style="margin:0;font-size:13px;line-height:1.7;color:var(--text-2)">${U.esc(message)}</p>`,
        footer: `<button class="btn" data-cancel>${U.esc(cancelText)}</button>
                 <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${U.esc(okText)}</button>`,
        onMount: (box, closeFn) => {
          box.querySelector('[data-cancel]').onclick = () => { done = true; closeFn(); resolve(false); };
          box.querySelector('[data-ok]').onclick = () => { done = true; closeFn(); resolve(true); };
        }
      });
      document.addEventListener('modal:closed', function onClosed() {
        document.removeEventListener('modal:closed', onClosed);
        if (!done) resolve(false);
      }, { once: true });
    });
  }

  /* ============================================================
     图片 URL
     ============================================================ */
  async function blobURL(blobId) {
    if (!blobId) return '';
    if (urlCache.has(blobId)) return urlCache.get(blobId);
    const b = await DB.getBlob(blobId);
    if (!b) return '';
    const u = URL.createObjectURL(b);
    urlCache.set(blobId, u);
    return u;
  }

  function dropURL(blobId) {
    if (urlCache.has(blobId)) {
      URL.revokeObjectURL(urlCache.get(blobId));
      urlCache.delete(blobId);
    }
  }

  function observeThumbs(root) {
    if (!io) {
      io = new IntersectionObserver(entries => {
        entries.forEach(async ent => {
          if (!ent.isIntersecting) return;
          const img = ent.target;
          io.unobserve(img);
          const u = await blobURL(img.dataset.blob);
          if (u) { img.src = u; img.classList.remove('loading'); }
        });
      }, { root: $('#view'), rootMargin: '600px' });
    }
    $$('img[data-blob]', root).forEach(img => io.observe(img));
  }

  /* ============================================================
     数据加载
     ============================================================ */
  async function reload() {
    const [images, categories, models, loras, workflows, settings] = await Promise.all([
      DB.listImages(), DB.getAll('categories'), DB.getAll('models'),
      DB.getAll('loras'), DB.getAll('workflows'), DB.getSettings()
    ]);
    state.images = images;
    state.categories = categories.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    state.models = models.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    state.loras = loras;
    state.workflows = workflows;
    state.settings = settings;
  }

  /* ============================================================
     导航
     ============================================================ */
  function navHTML() {
    const n = state.images.length;
    const fav = state.images.filter(i => i.favorite).length;
    const item = (v, label, ic, count, act) => `
      <button class="nav-item ${state.view === v ? 'active' : ''}" ${act ? `data-act="${act}"` : `data-view="${v}"`}>
        ${icon(ic)}<span class="lbl">${label}</span>${count ? `<span class="count">${count}</span>` : ''}
      </button>`;
    return `
      <div class="nav-label">图库</div>
      ${item('gallery', '全部图片', 'img', n)}
      ${item('favorites', '收藏', 'star', fav || '')}
      <div class="nav-label">创作</div>
      ${item('canvas', '无限画布', 'flow', null)}
      <div class="nav-label">参考图库</div>
      ${item('outfits', '服饰参考', 'shirt', (window.REF && REF.counts().outfits) || '')}
      ${item('faces', '人脸参考', 'user', (window.REF && REF.counts().faces) || '')}
      ${item('composer', '提示词组合', 'spark', (window.REF && REF.stageCount()) || '')}
      <div class="nav-label">本地资产</div>
      ${item('models', '模型库', 'cpu', state.models.length || '')}
      ${item('loras', 'LoRA', 'layers', state.loras.length || '')}
      ${item('workflows', '工作流', 'flow', state.workflows.length || '')}
      <div class="nav-label">管理</div>
      ${item('categories', '分类', 'folder', state.categories.length || '')}
      ${item('settings', '设置', 'edit', null)}
    `;
  }

  function renderNav() {
    $('#nav').innerHTML = navHTML();
  }

  function go(view, params) {
    if (window.REF && REF.isOpen()) REF.close();
    if (!$('#lightbox').classList.contains('hidden')) closeLightbox();
    state.view = view;
    const el = $('#view');
    if (el) el.scrollTop = 0;
    renderNav();
    render();
  }

  function registerView(name, def) { views[name] = def; }

  /* ============================================================
     渲染主视图
     ============================================================ */
  async function render() {
    const def = views[state.view];
    if (!def) return;
    $('#view-title').textContent = def.title;
    $('#view-sub').textContent = typeof def.sub === 'function' ? def.sub() : (def.sub || '');
    const acts = typeof def.actions === 'function' ? def.actions() : (def.actions || '');
    const uploadBtn = def.upload
      ? `<button class="btn primary" data-act="upload">${icon('upload', 15)} 上传图片</button>`
      : '';
    $('#topbar-actions').innerHTML = uploadBtn + acts;
    const container = $('#view');
    container.className = '';
    container.innerHTML = '';
    await def.render(container);
  }

  /* ============================================================
     图库视图
     ============================================================ */
  function filteredImages() {
    const f = state.filter;
    let arr = state.images.slice();
    if (state.view === 'favorites' || f.fav) arr = arr.filter(i => i.favorite);
    if (f.categoryId) arr = arr.filter(i => i.categoryId === f.categoryId);
    if (f.modelId) arr = arr.filter(i => i.modelId === f.modelId);
    if (f.q) {
      const q = f.q.toLowerCase();
      arr = arr.filter(i => {
        const p = activePrompt(i);
        return [i.id, i.filename, i.note, i.modelName, (i.tags || []).join(' '), p.text, p.negative]
          .filter(Boolean).join(' ').toLowerCase().includes(q);
      });
    }
    if (f.sort === 'old') arr.sort((a, b) => a.createdAt - b.createdAt);
    else if (f.sort === 'name') arr.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    else if (f.sort === 'random') arr.sort(() => Math.random() - 0.5);
    return arr;
  }

  function catOf(id) { return state.categories.find(c => c.id === id); }
  function modelOf(id) { return state.models.find(m => m.id === id); }

  function activePrompt(img) {
    if (!img.prompts || !img.prompts.length) return { text: '', negative: '', source: '' };
    return img.prompts.find(p => p.id === img.activePromptId) || img.prompts[img.prompts.length - 1];
  }

  function ratioClass(img) {
    if (!img.width || !img.height) return '';
    const r = img.width / img.height;
    if (r < 0.72) return 'ratio-916';
    if (r < 0.92) return 'ratio-34';
    if (r > 1.2) return 'ratio-43';
    return '';
  }

  function cardHTML(img) {
    const cat = catOf(img.categoryId);
    const m = modelOf(img.modelId);
    const p = activePrompt(img);
    const badges = [];
    if (m) badges.push(`<span class="badge">${U.esc(m.name)}</span>`);
    else if (img.modelName) badges.push(`<span class="badge">${U.esc(img.modelName)}</span>`);
    if (p.text) badges.push(`<span class="badge ai">AI</span>`);
    return `
      <div class="card" data-open="${U.esc(img.id)}">
        <img class="card-img loading" data-blob="${U.esc(img.thumbId)}" alt="">
        <div class="card-top-badges">${badges.join('')}</div>
        <button class="card-fav ${img.favorite ? 'on' : ''}" data-act="fav" data-id="${U.esc(img.id)}" title="收藏">${icon('star', 14)}</button>
        <div class="card-overlay">
          <div class="t">${U.esc(p.text || img.note || img.filename || '无提示词')}</div>
          <div class="m"><span>${U.esc(img.id)}</span><span>${U.esc(cat?.name || '')}</span></div>
        </div>
      </div>`;
  }

  function galleryToolbar() {
    const f = state.filter;
    const cats = state.categories.map(c => {
      const n = state.images.filter(i => i.categoryId === c.id).length;
      return `<button class="chip ${f.categoryId === c.id ? 'active' : ''}" data-act="filter-cat" data-id="${c.id}">
        <span class="dot" style="color:${c.color || 'var(--accent)'}"></span>${U.esc(c.name)}<span class="n">${n}</span>
      </button>`;
    }).join('');
    return `
      <div class="gallery-toolbar">
        <div class="search-box">${icon('search', 15)}<input id="g-search" type="text" placeholder="搜索提示词 / 编号 / 标签" value="${U.esc(f.q)}"></div>
        <button class="chip ${!f.categoryId ? 'active' : ''}" data-act="filter-cat" data-id="">全部 <span class="n">${state.images.length}</span></button>
        ${cats}
        <div class="spacer"></div>
        <select id="g-model" style="width:auto;max-width:190px;height:32px;padding:0 28px 0 10px;font-size:12.5px">
          <option value="">全部模型</option>
          ${state.models.map(m => `<option value="${m.id}" ${f.modelId === m.id ? 'selected' : ''}>${U.esc(m.name)}</option>`).join('')}
        </select>
        <select id="g-sort" style="width:auto;height:32px;padding:0 28px 0 10px;font-size:12.5px">
          <option value="new" ${f.sort === 'new' ? 'selected' : ''}>最新优先</option>
          <option value="old" ${f.sort === 'old' ? 'selected' : ''}>最早优先</option>
          <option value="name" ${f.sort === 'name' ? 'selected' : ''}>按编号</option>
          <option value="random" ${f.sort === 'random' ? 'selected' : ''}>随机</option>
        </select>
      </div>`;
  }

  function bindGallery(container) {
    const s = $('#g-search', container);
    if (s) {
      s.oninput = U.debounce(() => { state.filter.q = s.value.trim(); refreshGridOnly(container); }, 200);
      s.onkeydown = e => { if (e.key === 'Escape') { s.value = ''; state.filter.q = ''; refreshGridOnly(container); } };
    }
    const so = $('#g-sort', container);
    if (so) so.onchange = () => { state.filter.sort = so.value; refreshGridOnly(container); };
    const mo = $('#g-model', container);
    if (mo) mo.onchange = () => { state.filter.modelId = mo.value; refreshGridOnly(container); };
  }

  function refreshGridOnly(container) {
    const g = $('#g-grid', container);
    if (!g) return render();
    const list = filteredImages();
    g.innerHTML = list.length ? list.map(cardHTML).join('') : '';
    if (!list.length) g.outerHTML = emptyHTML();
    observeThumbs(container);
    $('#view-sub').textContent = subForGallery();
  }

  function subForGallery() {
    const total = filteredImages().length;
    const size = state.images.reduce((a, i) => a + (i.size || 0), 0);
    return `${total} 张 · ${U.fmtSize(size)} · 数据只存在这台机器的浏览器里`;
  }

  function emptyHTML() {
    return `<div class="empty">
      ${icon('img', 40)}
      <b>这里还是空的</b>
      <p>把生成的图直接拖进窗口，或点右上角「上传图片」。<br>PNG 里的生成参数（A1111 / ComfyUI）会被自动读出来。</p>
      <button class="btn primary" data-act="upload">${icon('upload', 15)} 上传第一批图</button>
    </div>`;
  }

  registerView('gallery', {
    title: '图库',
    upload: true,
    sub: () => subForGallery(),
    render: async (c) => {
      const list = filteredImages();
      c.innerHTML = galleryToolbar() + (list.length
        ? `<div class="grid" id="g-grid">${list.map(cardHTML).join('')}</div>`
        : emptyHTML());
      bindGallery(c);
      observeThumbs(c);
    }
  });

  registerView('favorites', {
    title: '收藏',
    upload: true,
    sub: () => `${state.images.filter(i => i.favorite).length} 张已收藏`,
    render: async (c) => {
      const list = filteredImages();
      c.innerHTML = list.length
        ? `<div class="grid" id="g-grid">${list.map(cardHTML).join('')}</div>`
        : `<div class="empty">${icon('star', 40)}<b>还没有收藏</b><p>在任意图片右上角点★，它就会出现在这里。</p></div>`;
      observeThumbs(c);
    }
  });

  /* ============================================================
     灯箱
     ============================================================ */
  async function openLightbox(id) {
    const list = filteredImages();
    const index = Math.max(0, list.findIndex(i => i.id === id));
    state.lb = { list, index };
    await renderLightbox();
    $('#lightbox').classList.remove('hidden');
  }

  function closeLightbox() {
    $('#lightbox').classList.add('hidden');
    $('#lightbox').innerHTML = '';
    state.lb = { list: [], index: 0 };
  }

  async function stepLightbox(dir) {
    const { list, index } = state.lb;
    if (list.length < 2) return;
    state.lb.index = (index + dir + list.length) % list.length;
    await renderLightbox();
  }

  async function renderLightbox() {
    const { list, index } = state.lb;
    const img = list[index];
    if (!img) return closeLightbox();

    const cat = catOf(img.categoryId);
    const model = modelOf(img.modelId);
    const p = activePrompt(img);
    const bigURL = await blobURL(img.blobId);

    const lb = $('#lightbox');
    lb.innerHTML = `
      <div class="lb-stage">
        <div class="lb-topbar">
          <span class="lb-id">${U.esc(img.id)}</span>
          <span class="badge ${model?.type === 'local' ? 'local' : 'cloud'}">${U.esc(model?.name || img.modelName || '未指定模型')}</span>
          <span class="badge">${U.esc(cat?.name || '未分类')}</span>
          <div class="spacer"></div>
          <button class="icon-btn ${img.favorite ? 'on' : ''}" data-act="fav" data-id="${U.esc(img.id)}" title="收藏">${icon('star', 15)}</button>
          <button class="icon-btn" data-act="lb-canvas" data-id="${U.esc(img.id)}" title="送去画布">${icon('flow', 15)}</button>
          <button class="icon-btn" data-act="lb-download" data-id="${U.esc(img.id)}" title="下载原图">${icon('down', 15)}</button>
          <button class="icon-btn" data-act="lb-edit" data-id="${U.esc(img.id)}" title="编辑信息">${icon('edit', 15)}</button>
          <button class="icon-btn" data-act="lb-delete" data-id="${U.esc(img.id)}" title="删除">${icon('trash', 15)}</button>
          <button class="icon-btn" data-act="lb-close" title="关闭 (Esc)">${icon('close', 15)}</button>
        </div>
        <div class="lb-canvas">
          ${list.length > 1 ? `<button class="lb-nav prev" data-act="lb-prev">${icon('left', 18)}</button>` : ''}
          <img src="${bigURL}" alt="">
          ${list.length > 1 ? `<button class="lb-nav next" data-act="lb-next">${icon('right', 18)}</button>` : ''}
        </div>
        <div class="lb-foot">
          <span>${img.width || '?'}×${img.height || '?'}</span>
          <span>${U.fmtSize(img.size)}</span>
          <span>${U.fmtDate(img.createdAt)}</span>
          <span>${index + 1} / ${list.length}</span>
        </div>
      </div>
      <aside class="lb-panel">
        <div class="lb-panel-head">
          <h3>提示词</h3>
          <span class="badge mono">${img.prompts?.length || 0} 版</span>
          <div class="spacer"></div>
          <button class="btn sm" data-act="prompt-new" data-id="${U.esc(img.id)}">${icon('plus', 13)} 新版本</button>
          <button class="btn sm primary" data-act="prompt-ai" data-id="${U.esc(img.id)}">${icon('spark', 13)} AI 再生成</button>
        </div>
        <div class="lb-panel-body">
          <div class="prompt-current ${p.text ? '' : 'empty-text'}" id="lb-prompt">${U.esc(p.text || '（这张图还没有提示词）')}</div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button class="btn sm ghost" data-act="prompt-copy" data-id="${U.esc(img.id)}">${icon('copy', 13)} 复制</button>
            <button class="btn sm ghost" data-act="prompt-edit" data-id="${U.esc(img.id)}">${icon('edit', 13)} 编辑为新版本</button>
            <div style="flex:1"></div>
            <span style="font-size:11px;color:var(--text-3);align-self:center">${p.text ? countWords(p.text) + ' words' : ''}</span>
          </div>

          ${p.negative ? `
          <div class="section">
            <div class="section-title">负面提示词</div>
            <div class="prompt-current" style="max-height:120px">${U.esc(p.negative)}</div>
          </div>` : ''}

          <div class="section">
            <div class="section-title">版本历史<span></span></div>
            <div class="ver-list">${versionListHTML(img)}</div>
          </div>

          <div class="section">
            <div class="section-title">生成参数</div>
            <dl class="kv">
              ${kv('模型', model ? `${model.name}${model.version ? ' · ' + model.version : ''}` : (img.modelName || '—'))}
              ${img.workflowName ? kv('工作流', img.workflowName) : ''}
              ${img.refIds?.length ? kv('参考图', img.refIds.join('、')) : ''}
              ${img.canvasName ? kv('画布', img.canvasName) : ''}
              ${kv('采样器', [img.sampler, img.scheduler].filter(Boolean).join(' / ') || '—')}
              ${kv('步数 / CFG', [img.steps ?? '—', img.cfg ?? '—'].join(' / '))}
              ${kv('种子', img.seed || '—')}
              ${kv('尺寸', img.width ? `${img.width}×${img.height}` : '—')}
              ${img.denoise != null ? kv('降噪', img.denoise) : ''}
              ${kv('来源', sourceLabel(img.source))}
              ${img.loraNames?.length ? kv('LoRA', img.loraNames.join(', ')) : ''}
              ${kv('文件', img.filename || '—')}
            </dl>
            <div style="display:flex;gap:6px;margin-top:9px">
              <button class="btn sm ghost" data-act="params-copy" data-id="${U.esc(img.id)}">${icon('copy', 13)} 复制参数</button>
              <button class="btn sm ghost" data-act="lb-edit" data-id="${U.esc(img.id)}">${icon('edit', 13)} 修改</button>
            </div>
          </div>

          ${img.tags?.length ? `
          <div class="section">
            <div class="section-title">标签</div>
            <div class="chips">${img.tags.map(t => `<span class="chip" style="height:26px;font-size:11.5px">${U.esc(t)}</span>`).join('')}</div>
          </div>` : ''}

          ${img.note ? `
          <div class="section">
            <div class="section-title">备注</div>
            <div style="font-size:12.5px;color:var(--text-2);line-height:1.65;white-space:pre-wrap">${U.esc(img.note)}</div>
          </div>` : ''}
        </div>
      </aside>`;
  }

  function kv(k, v) { return `<dt>${U.esc(k)}</dt><dd>${U.esc(v)}</dd>`; }
  function countWords(t) { return String(t).trim().split(/\s+/).filter(Boolean).length; }
  function sourceLabel(s) {
    return {
      a1111: 'A1111 / Forge', comfyui: 'ComfyUI', canvas: '画布生成',
      novelai: 'NovelAI', import: '导入', manual: '手动', ai: 'AI 生成', edit: '编辑'
    }[s] || (s || '手动');
  }

  function versionListHTML(img) {
    const arr = (img.prompts || []).slice().reverse();
    if (!arr.length) return `<div style="font-size:12px;color:var(--text-3)">还没有任何版本</div>`;
    return arr.map((p, i) => {
      const no = img.prompts.indexOf(p) + 1;
      const active = p.id === img.activePromptId;
      return `<div class="ver ${active ? 'active' : ''}">
        <div class="ver-head">
          <span class="vno">v${no}</span>
          <span class="badge ${p.source === 'ai' ? 'ai' : ''}">${U.esc(sourceLabel(p.source))}</span>
          ${active ? '<span class="badge ok">当前</span>' : ''}
          <span class="time">${U.relTime(p.createdAt)}</span>
        </div>
        <div class="ver-body">${U.esc(p.text || '（空）')}</div>
        <div class="ver-actions">
          ${active ? '' : `<button class="btn sm ghost" data-act="ver-use" data-img="${img.id}" data-ver="${p.id}">${icon('check', 12)} 设为当前</button>`}
          <button class="btn sm ghost" data-act="ver-copy" data-img="${img.id}" data-ver="${p.id}">${icon('copy', 12)} 复制</button>
          ${img.prompts.length > 1 ? `<button class="btn sm ghost" data-act="ver-del" data-img="${img.id}" data-ver="${p.id}">${icon('trash', 12)}</button>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  /* ============================================================
     提示词：新增版本 / AI 再生成
     ============================================================ */
  function newVersion(text, negative, source, note) {
    return {
      id: U.uid('pv'), text: text || '', negative: negative || '',
      source: source || 'manual', note: note || '', createdAt: Date.now()
    };
  }

  async function addVersion(imgId, { text, negative, source, note, silent }) {
    const img = state.images.find(i => i.id === imgId);
    if (!img) return;
    img.prompts = img.prompts || [];
    const v = newVersion(text, negative, source, note);
    img.prompts.push(v);
    img.activePromptId = v.id;
    await DB.saveImage(img);
    if (!silent) toast('已保存为新版本 v' + img.prompts.length, 'ok');
    await refreshAfterMutation(imgId);
  }

  async function refreshAfterMutation(imgId) {
    await reload();
    renderNav();
    if (!$('#lightbox').classList.contains('hidden')) {
      // 保持当前灯箱位置
      const cur = state.lb.list[state.lb.index];
      const fresh = filteredImages();
      const idx = fresh.findIndex(i => i.id === (cur?.id || imgId));
      state.lb = { list: fresh, index: Math.max(0, idx) };
      await renderLightbox();
    }
    if (state.view === 'gallery' || state.view === 'favorites') render();
  }

  function promptEditorModal(imgId, existing) {
    const img = state.images.find(i => i.id === imgId);
    const p = existing || activePrompt(img);
    const isNew = !existing;

    openModal({
      title: isNew ? '编辑为新版本' : '编辑提示词',
      sub: '保存后会追加成一个新版本，旧版本不会被覆盖',
      wide: true,
      body: `
        <div class="field" style="margin-bottom:14px">
          <label>正向提示词</label>
          <textarea id="pe-text" style="min-height:170px;font-family:var(--mono);font-size:12.5px">${U.esc(p.text || '')}</textarea>
        </div>
        <div class="field">
          <label>负面提示词</label>
          <textarea id="pe-neg" style="min-height:70px;font-family:var(--mono);font-size:12.5px">${U.esc(p.negative || '')}</textarea>
        </div>`,
      footer: `<button class="btn" data-close>取消</button>
               <button class="btn primary" id="pe-save">保存为新版本</button>`,
      onMount: (box, close) => {
        box.querySelector('#pe-save').onclick = async () => {
          const text = box.querySelector('#pe-text').value.trim();
          const neg = box.querySelector('#pe-neg').value.trim();
          if (!text && !neg) return toast('内容是空的', 'err');
          close();
          await addVersion(imgId, { text, negative: neg, source: 'edit', note: '手动编辑' });
        };
      }
    });
  }

  function aiPanel(imgId) {
    const img = state.images.find(i => i.id === imgId);
    const cur = activePrompt(img);
    let agentId = AI.lastAgentId();
    let parts = [];
    let idx = 0;
    let lastOut = null;

    const modeOpts = Object.entries(AI.MODES)
      .map(([k, v]) => `<option value="${k}" ${k === 'refine' ? 'selected' : ''}>${v.label}${v.vision ? '（需视觉模型）' : ''} — ${v.tip}</option>`).join('');

    const chipHTML = a => {
      const p = AI.providerById(a.providerId);
      return `<button type="button" class="agent-chip ${a.id === agentId ? 'active' : ''}" data-agent="${a.id}" title="${U.esc(a.brief || '')}">
        <b>${U.esc(a.name)}</b>
        <span>${U.esc(p?.name || '未指定')}</span>
      </button>`;
    };

    openModal({
      title: 'AI 再生成提示词',
      sub: '选一个智能体来写；结果作为新版本追加，原提示词完整保留',
      wide: true,
      body: `
        <div class="agent-picker">
          <div class="agent-picker-head">
            <span>智能体</span>
            <button type="button" class="btn sm ghost" id="ai-agent-manage">管理 / 新建</button>
          </div>
          <div class="agent-chips" id="ai-agents">${AI.agents().map(chipHTML).join('')}</div>
          <div class="agent-meta" id="ai-agent-meta"></div>
        </div>
        <div class="form-grid">
          <div class="field full">
            <label>生成方式</label>
            <select id="ai-mode">${modeOpts}</select>
          </div>
          <div class="field full" id="style-wrap" style="display:none">
            <label>目标风格</label>
            <input type="text" id="ai-style" placeholder="例如：电影感写实摄影 / 日系胶片 / 3D 渲染 / 水彩插画">
          </div>
          <div class="field full">
            <label>参考提示词（可改）</label>
            <textarea id="ai-src" style="min-height:110px;font-family:var(--mono);font-size:12px">${U.esc(cur.text || '')}</textarea>
          </div>
          <div class="field full">
            <label>补充要求（可选）</label>
            <input type="text" id="ai-extra" placeholder="例如：保留原图的紫色光晕，换成竖构图">
          </div>
          <div class="field full">
            <label>生成结果</label>
            <div id="ai-result" style="min-height:110px;padding:11px 12px;border:1px solid var(--line-strong);border-radius:9px;background:var(--panel-2);font-family:var(--mono);font-size:12px;line-height:1.65;white-space:pre-wrap;color:var(--text-2)">点右下角「生成」开始</div>
          </div>
        </div>`,
      footer: `<span id="ai-model-note" style="font-size:11px;color:var(--text-3);align-self:center"></span>
               <div class="spacer"></div>
               <button class="btn" data-close>取消</button>
               <button class="btn" id="ai-gen">生成</button>
               <button class="btn primary" id="ai-save" disabled>存为新版本</button>`,
      onMount: (box, close) => {
        const res = box.querySelector('#ai-result');
        const saveBtn = box.querySelector('#ai-save');
        const meta = box.querySelector('#ai-agent-meta');
        const note = box.querySelector('#ai-model-note');

        function paintAgent() {
          const a = AI.agentById(agentId);
          const p = a ? AI.providerById(a.providerId) : null;
          const model = a?.model || (p?.models || [])[0] || '未指定模型';
          const needKey = p && AI.presetOf(p.key).needKey && !p.apiKey;
          meta.innerHTML = a
            ? `${U.esc(a.brief || '')}<br>
               <span class="mono" style="font-size:11px;color:var(--text-3)">${U.esc(p?.name || '')} · ${U.esc(model)} · 温度 ${U.esc(String(a.temperature ?? 0.9))}</span>
               ${needKey ? `<span style="color:var(--danger);margin-left:8px">· 该服务商还没填 API Key</span>` : ''}`
            : '还没有智能体，去设置里新建一个';
          note.textContent = a ? `${a.name} · ${model}` : '';
        }

        box.querySelectorAll('.agent-chip').forEach(chip => {
          chip.onclick = async () => {
            agentId = chip.dataset.agent;
            box.querySelectorAll('.agent-chip').forEach(c => c.classList.toggle('active', c === chip));
            paintAgent();
            await AI.setLastAgent(agentId);
          };
        });

        box.querySelector('#ai-agent-manage').onclick = () => {
          close();
          go('settings');
          setTimeout(() => {
            const el = document.querySelector('#sec-agents');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 120);
        };

        box.querySelector('#ai-mode').onchange = e => {
          box.querySelector('#style-wrap').style.display = e.target.value === 'style' ? '' : 'none';
        };

        function paint() {
          res.innerHTML = parts.map((t, i) => `
            <div style="padding:8px 10px;border-radius:7px;margin-bottom:6px;cursor:pointer;border:1px solid ${i === idx ? 'var(--rose)' : 'transparent'};background:${i === idx ? 'var(--rose-soft)' : 'transparent'}"
                 data-pick="${i}">
              <div style="font-size:10px;color:var(--text-3);margin-bottom:3px">${parts.length > 1 ? '变体 ' + (i + 1) : '结果'}</div>
              ${U.esc(t)}
            </div>`).join('');
          res.querySelectorAll('[data-pick]').forEach(el => {
            el.onclick = () => { idx = Number(el.dataset.pick); paint(); };
          });
        }

        box.querySelector('#ai-gen').onclick = async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> 生成中';
          res.textContent = '正在请求模型…';
          try {
            const mode = box.querySelector('#ai-mode').value;
            const extra = box.querySelector('#ai-extra').value;
            let out;

            if (mode === 'describe') {
              const blob = await DB.getBlob(img.blobId);
              if (!blob) throw new Error('原图不在本地了');
              const b64 = await new Promise((res, rej) => {
                const fr = new FileReader();
                fr.onload = () => res(String(fr.result).split(',')[1]);
                fr.onerror = rej;
                fr.readAsDataURL(blob);
              });
              const r = await AI.describeImage({ agentId, base64: b64, mime: blob.type || 'image/png', extra });
              out = { ...r, parts: [r.text], mode, agentName: AI.agentById(agentId)?.name || '', providerName: AI.providerById(AI.agentById(agentId)?.providerId)?.name || '', model: r.model };
            } else {
              out = await AI.generate({
                agentId, mode,
                prompt: box.querySelector('#ai-src').value,
                style: box.querySelector('#ai-style').value,
                extra
              });
            }
            lastOut = out;
            parts = out.parts?.length ? out.parts : [out.text];
            idx = 0;
            paint();
            saveBtn.disabled = false;
            note.textContent = `${out.agentName} · ${out.providerName} · ${out.model}`;
          } catch (e) {
            res.textContent = '✕ ' + e.message;
            toast(e.message, 'err');
          } finally {
            btn.disabled = false;
            btn.textContent = '重新生成';
          }
        };

        saveBtn.onclick = async () => {
          const text = parts[idx];
          if (!text) return;
          const a = AI.agentById(agentId);
          close();
          await addVersion(imgId, {
            text,
            negative: cur.negative,
            source: 'ai',
            note: `${a?.name || 'AI'} · ${box.querySelector('#ai-mode').value}`
          });
        };

        paintAgent();
      }
    });
  }


  /* ============================================================
     元数据编辑
     ============================================================ */
  function editImageModal(imgId) {
    const img = state.images.find(i => i.id === imgId);
    if (!img) return;
    const catOpts = state.categories.map(c => `<option value="${c.id}" ${img.categoryId === c.id ? 'selected' : ''}>${U.esc(c.name)}</option>`).join('');
    const mdlOpts = `<option value="">— 不指定 —</option>` + state.models.map(m => `<option value="${m.id}" ${img.modelId === m.id ? 'selected' : ''}>${U.esc(m.name)}</option>`).join('');

    openModal({
      title: '编辑图片信息',
      sub: img.id,
      wide: true,
      body: `
        <div class="form-grid">
          <div class="field"><label>分类</label><select id="ed-cat">${catOpts}</select></div>
          <div class="field"><label>模型</label><select id="ed-model">${mdlOpts}</select></div>
          <div class="field full"><label>标签（空格或逗号分隔）</label>
            <input type="text" id="ed-tags" value="${U.esc((img.tags || []).join(', '))}" placeholder="portrait, night, neon"></div>
          <div class="field full"><label>备注</label>
            <textarea id="ed-note" style="min-height:70px">${U.esc(img.note || '')}</textarea></div>
          <div class="field"><label>模型名（手填，未入库时用）</label>
            <input type="text" id="ed-modelname" value="${U.esc(img.modelName || '')}"></div>
          <div class="field"><label>种子</label>
            <input type="text" id="ed-seed" value="${U.esc(img.seed || '')}"></div>
        </div>`,
      footer: `<button class="btn danger" id="ed-del">${icon('trash', 14)} 删除这张</button>
               <div class="spacer"></div>
               <button class="btn" data-close>取消</button>
               <button class="btn primary" id="ed-save">保存</button>`,
      onMount: (box, close) => {
        box.querySelector('#ed-save').onclick = async () => {
          img.categoryId = box.querySelector('#ed-cat').value;
          img.modelId = box.querySelector('#ed-model').value;
          img.tags = box.querySelector('#ed-tags').value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
          img.note = box.querySelector('#ed-note').value.trim();
          img.modelName = box.querySelector('#ed-modelname').value.trim();
          img.seed = box.querySelector('#ed-seed').value.trim();
          await DB.saveImage(img);
          close();
          toast('已保存', 'ok');
          await refreshAfterMutation(img.id);
        };
        box.querySelector('#ed-del').onclick = async () => {
          close();
          await deleteImageFlow(img.id);
        };
      }
    });
  }

  async function deleteImageFlow(id) {
    const ok = await confirmDialog({
      title: '删除这张图？',
      message: '图片文件、缩略图和全部提示词版本都会被删除，无法恢复。',
      danger: true, okText: '删除'
    });
    if (!ok) return;
    const img = state.images.find(i => i.id === id);
    if (img) { dropURL(img.blobId); dropURL(img.thumbId); }
    await DB.deleteImage(id);
    closeLightbox();
    await reload();
    renderNav();
    render();
    toast('已删除', 'ok');
  }

  /* ============================================================
     上传
     ============================================================ */
  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(f =>
      /^image\//.test(f.type) || /\.(png|jpe?g|webp|avif|gif|bmp)$/i.test(f.name));
    if (!files.length) return toast('没有可用的图片文件', 'err');

    toast(`正在解析 ${files.length} 张图…`);
    const items = [];
    const defCat = state.categories[0]?.id || '';

    for (let i = 0; i < files.length; i += 4) {
      const batch = files.slice(i, i + 4);
      const done = await Promise.all(batch.map(async f => {
        const meta = await Parse.readMeta(f).catch(() => ({ width: null, height: null, info: null }));
        const thumb = await Parse.makeThumb(f).catch(() => f);
        const info = meta.info || {};
        const matched = matchModelId(info.model, f.name);
        const loraIds = (info.loras || []).map(l => matchLoraId(l.name)).filter(Boolean);
        return { file: f, meta, thumb, thumbURL: URL.createObjectURL(thumb), categoryId: defCat, modelId: matched, loraIds };
      }));
      items.push(...done);
    }

    if (!state.categories.length) {
      toast('还没有分类，先创建一个', 'err');
      return;
    }
    $('#toasts').innerHTML = '';
    openUploadModal(items);
  }

  function matchModelId(name, filename) {
    if (!name && !filename) return '';
    const n = String(name || '').toLowerCase().trim();
    const fn = String(filename || '').toLowerCase();
    let hit = state.models.find(m => m.name.toLowerCase() === n);
    if (hit) return hit.id;
    hit = state.models.find(m => n && (n.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(n)));
    if (hit) return hit.id;
    hit = state.models.find(m => m.base && n && n.includes(String(m.base).toLowerCase()));
    if (hit) return hit.id;
    hit = state.models.find(m => fn.includes(m.name.toLowerCase().replace(/\s+/g, '_')) || fn.includes(m.name.toLowerCase()));
    return hit ? hit.id : '';
  }

  function matchLoraId(name) {
    if (!name) return '';
    const n = String(name).toLowerCase().replace(/\.(safetensors|pt|ckpt)$/, '');
    const hit = state.loras.find(l => {
      const ln = l.name.toLowerCase();
      return ln === n || n.includes(ln) || ln.includes(n);
    });
    return hit ? hit.id : '';
  }

  function openUploadModal(items) {
    const catOpts = state.categories.map(c => `<option value="${c.id}">${U.esc(c.name)}</option>`).join('');
    const mdlOpts = `<option value="">— 不指定 —</option>` + state.models.map(m => `<option value="${m.id}">${U.esc(m.name)}</option>`).join('');

    const listHTML = items.map((it, i) => {
      const info = it.meta.info;
      const got = [];
      if (info?.positive) got.push('提示词');
      if (info?.model) got.push('模型 ' + info.model);
      if (info?.seed) got.push('seed ' + String(info.seed).slice(0, 14));
      if (info?.steps) got.push(info.steps + ' steps');
      if (info?.width) got.push(info.width + '×' + info.height);
      if (info?.loras?.length) got.push(info.loras.length + ' LoRA');
      return `<div class="up-item" data-idx="${i}">
        <img class="thumb" src="${it.thumbURL}" alt="">
        <div class="info">
          <div class="fname">${U.esc(it.file.name)}</div>
          <div class="parsed">
            ${info ? `<span class="got">✓ 读到 ${U.esc(got.join(' · '))}</span>` : '<span style="color:var(--text-2)">无内嵌参数</span>'}
            ${info?.positive ? `<div style="margin-top:4px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:11px">${U.esc(info.positive.slice(0, 120))}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <select class="mini-input up-cat" data-idx="${i}" style="flex:1">${catOpts}</select>
            <select class="mini-input up-model" data-idx="${i}" style="flex:1">${mdlOpts}</select>
          </div>
        </div>
      </div>`;
    }).join('');

    openModal({
      title: `导入 ${items.length} 张图`,
      sub: '参数已自动读取，入库前可以统一改分类和模型',
      wide: true,
      body: `
        <div class="bulk-bar">
          <span>统一设置：</span>
          <select id="bulk-cat">${catOpts}</select>
          <button class="btn sm" id="bulk-apply-cat">应用分类</button>
          <select id="bulk-model">${mdlOpts}</select>
          <button class="btn sm" id="bulk-apply-model">应用模型</button>
          <div class="spacer" style="flex:1"></div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-2)">
            <input type="checkbox" id="bulk-skip-dup" checked style="accent-color:var(--accent)"> 跳过重复文件
          </label>
        </div>
        <div class="up-list">${listHTML}</div>`,
      footer: `<span style="font-size:11.5px;color:var(--text-3);align-self:center" id="up-count">共 ${items.length} 张</span>
               <div class="spacer"></div>
               <button class="btn" data-close>取消</button>
               <button class="btn primary" id="up-do">全部入库</button>`,
      onMount: (box, close) => {
        // 初始化每项的 select
        items.forEach((it, i) => {
          const cs = box.querySelector(`.up-cat[data-idx="${i}"]`);
          const ms = box.querySelector(`.up-model[data-idx="${i}"]`);
          if (cs) cs.value = it.categoryId;
          if (ms) ms.value = it.modelId || '';
          cs.onchange = () => it.categoryId = cs.value;
          ms.onchange = () => it.modelId = ms.value;
        });

        box.querySelector('#bulk-apply-cat').onclick = () => {
          const v = box.querySelector('#bulk-cat').value;
          items.forEach((it, i) => {
            it.categoryId = v;
            const cs = box.querySelector(`.up-cat[data-idx="${i}"]`);
            if (cs) cs.value = v;
          });
          toast('已应用到全部', 'ok');
        };
        box.querySelector('#bulk-apply-model').onclick = () => {
          const v = box.querySelector('#bulk-model').value;
          items.forEach((it, i) => {
            it.modelId = v;
            const ms = box.querySelector(`.up-model[data-idx="${i}"]`);
            if (ms) ms.value = v;
          });
          toast('已应用到全部', 'ok');
        };

        box.querySelector('#up-do').onclick = async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> 入库中';
          try {
            const skipDup = box.querySelector('#bulk-skip-dup').checked;
            const n = await commitUpload(items, skipDup);
            close();
            await reload();
            renderNav();
            render();
            toast(`已入库 ${n} 张`, 'ok');
          } catch (e) {
            toast('入库失败：' + e.message, 'err');
            btn.disabled = false;
            btn.textContent = '全部入库';
          }
        };
      }
    });
  }

  async function commitUpload(items, skipDup) {
    const existing = new Set(state.images.map(i => (i.filename || '') + '|' + (i.size || 0)));
    let n = 0;
    for (const it of items) {
      const key = it.file.name + '|' + it.file.size;
      if (skipDup && existing.has(key)) continue;
      existing.add(key);

      const cat = state.categories.find(c => c.id === it.categoryId) || state.categories[0];
      const seq = await DB.nextSeq(cat.id);
      const id = `${cat.prefix || 'GEN'}-${U.pad(seq, 4)}`;

      const blobId = U.uid('bl');
      const thumbId = U.uid('th');
      await DB.putBlob(blobId, it.file, { kind: 'original' });
      await DB.putBlob(thumbId, it.thumb, { kind: 'thumb' });

      const info = it.meta.info || {};
      const now = Date.now();
      const pv = newVersion(info.positive || '', info.negative || '', info.source || 'import', '导入时读取');

      const img = {
        id, categoryId: cat.id, modelId: it.modelId || '',
        blobId, thumbId,
        filename: it.file.name,
        size: it.file.size,
        mime: it.file.type,
        width: it.meta.width, height: it.meta.height,
        favorite: false,
        tags: [],
        note: '',
        source: info.source || 'manual',
        modelName: info.model || '',
        sampler: info.sampler || '',
        scheduler: info.scheduler || '',
        steps: info.steps ?? null,
        cfg: info.cfg ?? null,
        seed: info.seed || '',
        denoise: info.denoise ?? null,
        loraNames: (info.loras || []).map(l => l.name || l).filter(Boolean),
        loraIds: it.loraIds || [],
        prompts: [pv],
        activePromptId: pv.id,
        createdAt: now, updatedAt: now
      };
      await DB.put('images', img);
      n++;
    }
    return n;
  }

  /* ============================================================
     动作注册
     ============================================================ */
  on('upload', () => {
    const inp = $('#file-input');
    inp.accept = 'image/*';
    inp.onchange = () => { handleFiles(inp.files); inp.value = ''; };
    inp.click();
  });

  on('fav', async (el) => {
    const img = state.images.find(i => i.id === el.dataset.id);
    if (!img) return;
    img.favorite = !img.favorite;
    await DB.saveImage(img);
    el.classList.toggle('on', img.favorite);
    if (state.view === 'favorites') {
      await reload(); renderNav(); render();
    } else {
      renderNav();
    }
  });

  on('lb-close', closeLightbox);
  on('lb-prev', () => stepLightbox(-1));
  on('lb-next', () => stepLightbox(1));

  on('lb-canvas', (el) => {
    const img = state.images.find(i => i.id === el.dataset.id);
    if (!img) return;

    const opt = (mode, ic, title, desc) => `
      <div class="entity" data-mode="${mode}" style="cursor:pointer">
        <div class="entity-mark">${icon(ic, 16)}</div>
        <div class="entity-main">
          <b>${title}</b>
          <em>${desc}</em>
        </div>
        <button class="btn sm">选择</button>
      </div>`;

    openModal({
      title: '送去画布',
      sub: `${img.id} · 送到当前画布`,
      wide: true,
      body: `<div class="entity-list">
        ${opt('ref', 'img', '作为参考图',
          '放进参考图节点，连到生成节点就是图生图；一张脸或一套衣服都能这么用')}
        ${opt('image', 'layers', '作为图片节点',
          '只放到画布上做对比、拼图，不参与生成')}
        ${opt('rerun', 'spark', '用这套参数复现',
          '自动搭好提示词（含负面）、参考图、工作流和生成节点，一键再跑一次')}
      </div>
      <p class="hint" style="margin:14px 0 0;line-height:1.85">
        「复现」会把这张图当时的提示词版本、参考图编号、工作流一起铺到画布上；
        如果原图没有关联工作流，生成节点需要你手动绑定一个。
      </p>`,
      footer: `<button class="btn" data-close>取消</button>`,
      onMount: (box, close) => {
        box.querySelectorAll('[data-mode]').forEach(row => {
          row.onclick = async () => {
            const mode = row.dataset.mode;
            close();
            try {
              await Canvas.sendImage(img, mode);
            } catch (e) {
              toast('送入画布失败：' + e.message, 'err');
            }
          };
        });
      }
    });
  });

  on('lb-download', async (el) => {
    const img = state.images.find(i => i.id === el.dataset.id);
    if (!img) return;
    const b = await DB.getBlob(img.blobId);
    if (!b) return toast('原图丢失', 'err');
    const ext = (img.filename || '').split('.').pop() || 'png';
    U.download(img.id + '.' + ext, b);
  });

  on('lb-edit', (el) => editImageModal(el.dataset.id));
  on('lb-delete', (el) => deleteImageFlow(el.dataset.id));

  on('prompt-copy', async (el) => {
    const img = state.images.find(i => i.id === el.dataset.id);
    const p = activePrompt(img);
    if (!p.text) return toast('没有可复制的内容', 'err');
    await U.copy(p.text);
    toast('提示词已复制', 'ok');
  });

  on('prompt-edit', (el) => promptEditorModal(el.dataset.id));
  on('prompt-new', (el) => promptEditorModal(el.dataset.id, null));
  on('prompt-ai', (el) => aiPanel(el.dataset.id));

  on('params-copy', async (el) => {
    const img = state.images.find(i => i.id === el.dataset.id);
    const m = modelOf(img.modelId);
    await U.copy(Parse.paramsSnapshot({ ...img, modelName: m?.name || img.modelName }));
    toast('参数已复制', 'ok');
  });

  on('ver-use', async (el) => {
    const img = state.images.find(i => i.id === el.dataset.img);
    img.activePromptId = el.dataset.ver;
    await DB.saveImage(img);
    toast('已切换当前版本', 'ok');
    await refreshAfterMutation(img.id);
  });

  on('ver-copy', async (el) => {
    const img = state.images.find(i => i.id === el.dataset.img);
    const v = img.prompts.find(p => p.id === el.dataset.ver);
    if (v) { await U.copy(v.text); toast('已复制', 'ok'); }
  });

  on('ver-del', async (el) => {
    const img = state.images.find(i => i.id === el.dataset.img);
    if (!img || img.prompts.length <= 1) return;
    const ok = await confirmDialog({ title: '删除这个版本？', message: '只会删掉这一个版本，其他版本保留。', danger: true, okText: '删除' });
    if (!ok) return;
    img.prompts = img.prompts.filter(p => p.id !== el.dataset.ver);
    if (!img.prompts.find(p => p.id === img.activePromptId)) {
      img.activePromptId = img.prompts[img.prompts.length - 1].id;
    }
    await DB.saveImage(img);
    toast('已删除该版本', 'ok');
    await refreshAfterMutation(img.id);
  });

  on('filter-cat', (el) => {
    state.filter.categoryId = el.dataset.id;
    render();
  });

  /* ============================================================
     全局事件
     ============================================================ */
  function bindGlobal() {
    // 导航
    $('#nav').addEventListener('click', e => {
      const b = e.target.closest('[data-view]');
      if (b) go(b.dataset.view);
    });

    // 动作委托
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-act]');
      if (t) {
        const fn = actions[t.dataset.act];
        if (fn) { e.preventDefault(); fn(t, e); return; }
      }
      const open = e.target.closest('[data-open]');
      if (open) openLightbox(open.dataset.open);
    });

    // 键盘
    document.addEventListener('keydown', e => {
      const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
      if (e.key === 'Escape') {
        if (!$('#modal').classList.contains('hidden')) { modalCloser?.(); return; }
        if (window.REF && REF.isOpen()) { REF.close(); return; }
        if (!$('#lightbox').classList.contains('hidden')) { closeLightbox(); return; }
      }
      if (inField) return;
      if (!$('#lightbox').classList.contains('hidden')) {
        if (window.REF && REF.isOpen()) {
          if (e.key === 'ArrowLeft') REF.step(-1);
          if (e.key === 'ArrowRight') REF.step(1);
        } else {
          if (e.key === 'ArrowLeft') stepLightbox(-1);
          if (e.key === 'ArrowRight') stepLightbox(1);
        }
      }
      if (!inField && (e.key === 'u' || e.key === 'U')) { actions.upload?.(); }
    });

    // 主题
    $('#btn-theme').onclick = () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('vault.theme', next);
    };

    $('#btn-settings').onclick = () => go('settings');

    // 拖拽
    let dragDepth = 0;
    window.addEventListener('dragenter', e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      dragDepth++;
      $('#dropzone-hint').classList.remove('hidden');
    });
    window.addEventListener('dragover', e => { e.preventDefault(); });
    window.addEventListener('dragleave', e => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('#dropzone-hint').classList.add('hidden');
    });
    window.addEventListener('drop', e => {
      e.preventDefault();
      dragDepth = 0;
      $('#dropzone-hint').classList.add('hidden');
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    });
  }

  /* ============================================================
     启动
     ============================================================ */
  async function boot() {
    // 主题
    const saved = localStorage.getItem('vault.theme');
    if (saved) document.documentElement.dataset.theme = saved;

    try {
      await DB.open();
    } catch (e) {
      console.error(e);
      $('#view').innerHTML = `<div class="empty" style="min-height:70vh">
        ${icon('img', 40)}
        <b>数据库打不开</b>
        <p>当前是 <code>${location.protocol}//</code> 方式打开，浏览器禁止本地文件使用 IndexedDB。<br>
        请用项目里的 <code>start.command</code>（Mac）或 <code>start.bat</code>（Windows）启动本地服务后再访问。</p>
      </div>`;
      return;
    }

    await DB.ensureSeed();
    await reload();
    await AI.load();
    bindGlobal();
    renderNav();
    await render();
    updateStorage();
    setInterval(updateStorage, 20000);
  }

  async function updateStorage() {
    const { used, quota } = await DB.usage();
    const el = $('#storage-line');
    if (!el) return;
    if (!used) { el.textContent = `${state.images.length} 张图 · 本地存储`; return; }
    el.textContent = `${U.fmtSize(used)}${quota ? ' / ' + U.fmtSize(quota) : ''} · 本地`;
    if (quota && used / quota > 0.85) el.style.color = 'var(--danger)';
  }

  /* ---------------- 对外 ---------------- */
  return {
    state, toast, icon, openModal, confirmDialog, go, render, reload, renderNav,
    registerView, on, blobURL, dropURL, activePrompt, catOf, modelOf,
    addVersion, newVersion, sourceLabel, boot,
    get $() { return $; }, get $$() { return $$; },
    matchModelId, matchLoraId, editImageModal, handleFiles, openLightbox,
  };
})();
