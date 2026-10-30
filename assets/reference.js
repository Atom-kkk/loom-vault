/* ============================================================
   reference.js — 内置参考图库：服饰 / 人脸 + 提示词组合台
   数据与缩略图来自作者的另外两个开源库，已本地化到 reference/
   · AI-Clothing-Resource-Library（1407 张服装参考图）
   · AI-Face-Resource-Library（1499 张人脸 / 造型参考图）
   只读：可搜索、筛选、看大图、复制提示词、存入自己的图库
   ============================================================ */

window.REF = (function () {
  'use strict';

  const V = window.Vault;
  const PAGE = 120;
  const HAIR_EN = ['short hair', 'medium-short hair', 'medium-long hair', 'long hair'];

  const state = {
    outfits: { meta: null, items: [], shown: 0, q: '', cat: '', loading: null },
    faces: { meta: null, items: [], shown: 0, q: '', sec: '', len: '', loading: null },
    lb: { kind: '', index: 0, open: false },
    stage: { face: null, outfit: null }
  };

  const esc = U.esc;
  const isFile = () => location.protocol === 'file:';

  /* ---------------- 组合历史 ---------------- */
  const HIST_KEY = 'vault.compHistory';
  const HIST_MAX = 40;
  let histCache = null;
  let restoreText = null;

  function loadHist() {
    if (histCache) return histCache;
    try {
      histCache = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    } catch { histCache = []; }
    if (!Array.isArray(histCache)) histCache = [];
    return histCache;
  }

  function saveHist() {
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(histCache.slice(0, HIST_MAX)));
    } catch { }
  }

  function pushHist(text, note) {
    const { face, outfit } = state.stage;
    if (!face && !outfit) return;
    if (!text || !text.trim()) return;
    const list = loadHist();
    const sig = `${face?.id || '-'}|${outfit?.id || '-'}|${text.trim()}`;
    // 同签名只更新时间，不重复堆积
    const old = list.findIndex(h => h.sig === sig);
    if (old >= 0) list.splice(old, 1);
    list.unshift({
      id: U.uid('h'),
      sig,
      face: face ? { id: face.id, thumb: face.thumb, len: face.len, style: face.style || '' } : null,
      outfit: outfit ? { id: outfit.id, thumb: outfit.thumb, cat: outfit.cat, kw: outfit.kw || '' } : null,
      text: text.trim(),
      note: note || '',
      createdAt: Date.now()
    });
    histCache = list.slice(0, HIST_MAX);
    saveHist();
  }

  function histBlockHTML() {
    const list = loadHist();
    if (!list.length) return '';
    return `<div class="section" style="margin-top:22px">
      <div class="section-title">最近组合 <span style="margin-left:2px">${list.length}</span><span></span></div>
      <div class="comp-hist">
        ${list.map(h => `<div class="hist-item" data-hist="${h.id}" title="点击恢复这次组合">
          <div class="hist-imgs">
            ${h.face ? `<img src="${esc(h.face.thumb)}" alt="">` : '<div class="hist-ph">无脸</div>'}
            ${h.outfit ? `<img src="${esc(h.outfit.thumb)}" alt="">` : '<div class="hist-ph">无衣</div>'}
          </div>
          <div class="hist-main">
            <div class="hist-text">${esc(h.text.slice(0, 90))}${h.text.length > 90 ? '…' : ''}</div>
            <div class="hist-meta">${esc(h.note || '')} ${U.relTime(h.createdAt)}</div>
          </div>
          <button class="hist-del" data-histdel="${h.id}" title="删除">${V.icon('close', 13)}</button>
        </div>`).join('')}
      </div>
    </div>`;
  }

  /* ============================================================
     数据加载
     ============================================================ */
  async function load(kind) {
    const st = state[kind];
    if (st.items.length) return st;
    if (st.loading) return st.loading;
    st.loading = (async () => {
      // 优先用内联数据：file:// 双击打开时 fetch 本地 JSON 会被拦
      if (window.REF_DATA && window.REF_DATA[kind]) {
        st.meta = window.REF_DATA[kind];
        st.items = st.meta.items || [];
        return st;
      }
      const res = await fetch(`reference/${kind}.json`);
      if (!res.ok) throw new Error(`读取 reference/${kind}.json 失败`);
      const json = await res.json();
      st.meta = json;
      st.items = json.items || [];
      return st;
    })();
    return st.loading;
  }

  async function preload() {
    try {
      await Promise.all([load('outfits'), load('faces')]);
    } catch (e) {
      console.warn('参考库加载失败', e);
    }
    V.renderNav();
  }

  function counts() {
    return { outfits: state.outfits.items.length, faces: state.faces.items.length };
  }
  function stageCount() {
    return (state.stage.face ? 1 : 0) + (state.stage.outfit ? 1 : 0);
  }

  /* ============================================================
     筛选
     ============================================================ */
  const OUTFIT_CATS = ['春', '夏', '秋', '冬', '内衣', '派对', '泳装', '性感'];

  function filtered(kind) {
    const st = state[kind];
    let arr = st.items;

    if (kind === 'outfits') {
      if (st.cat) arr = arr.filter(i => i.cat === st.cat);
      if (st.q) {
        const q = st.q.toLowerCase();
        arr = arr.filter(i =>
          i.id.toLowerCase().includes(q) ||
          (i.kw || '').toLowerCase().includes(q) ||
          (i.cat || '').toLowerCase().includes(q));
      }
    } else {
      if (st.sec !== '') arr = arr.filter(i => String(i.sec) === String(st.sec));
      if (st.len !== '') arr = arr.filter(i => String(i.len) === String(st.len));
      if (st.q) {
        const q = st.q.toLowerCase();
        arr = arr.filter(i =>
          i.id.toLowerCase().includes(q) ||
          (i.style || '').toLowerCase().includes(q) ||
          (st.meta?.lengths?.[i.len] || '').includes(st.q));
      }
    }
    return arr;
  }

  function catCounts(kind) {
    const st = state[kind];
    const m = {};
    st.items.forEach(i => {
      const k = kind === 'outfits' ? i.cat : String(i.sec);
      m[k] = (m[k] || 0) + 1;
    });
    return m;
  }

  /* ============================================================
     渲染
     ============================================================ */
  function cardHTML(kind, item, index) {
    if (kind === 'outfits') {
      return `<div class="ref-card" data-ref="outfits" data-index="${index}">
        <img src="${esc(item.thumb)}" loading="lazy" decoding="async" alt="${esc(item.id)}">
        <div class="ref-hover">
          <div class="ref-id">${esc(item.id)} · ${esc(item.cat)}</div>
          <div class="ref-kw">${esc(item.kw || '')}</div>
        </div>
      </div>`;
    }
    return `<div class="ref-card" data-ref="faces" data-index="${index}">
      <img src="${esc(item.thumb)}" loading="lazy" decoding="async" alt="${esc(item.id)}">
      <div class="ref-hover">
        <div class="ref-id">${esc(item.id.slice(0, 8))} · ${esc(state.faces.meta?.sections?.[item.sec]?.name || '')}</div>
        <div class="ref-kw">${esc(state.faces.meta?.lengths?.[item.len] || '')}${item.style ? ' · ' + esc(item.style) : ''}</div>
      </div>
    </div>`;
  }

  function toolbarHTML(kind) {
    const st = state[kind];
    const list = filtered(kind);
    if (kind === 'outfits') {
      const cc = catCounts('outfits');
      return `<div class="gallery-toolbar">
        <div class="search-box">${V.icon('search', 15)}<input id="ref-q" type="text" placeholder="搜索编号 / 关键词（中英）" value="${esc(st.q)}"></div>
        <button class="chip ${!st.cat ? 'active' : ''}" data-refcat="">全部 <span class="n">${st.items.length}</span></button>
        ${OUTFIT_CATS.map(c => `<button class="chip ${st.cat === c ? 'active' : ''}" data-refcat="${esc(c)}">${esc(c)} <span class="n">${cc[c] || 0}</span></button>`).join('')}
        <div class="spacer"></div>
        <span class="ref-total">${list.length} 张</span>
      </div>`;
    }
    const sc = catCounts('faces');
    const lengths = st.meta?.lengths || [];
    return `<div class="gallery-toolbar">
      <div class="search-box">${V.icon('search', 15)}<input id="ref-q" type="text" placeholder="搜索编号 / 风格 / 发长" value="${esc(st.q)}"></div>
      <button class="chip ${st.sec === '' ? 'active' : ''}" data-refsec="">全部 <span class="n">${st.items.length}</span></button>
      <button class="chip ${st.sec === '0' ? 'active' : ''}" data-refsec="0">正面人脸 <span class="n">${sc['0'] || 0}</span></button>
      <button class="chip ${st.sec === '1' ? 'active' : ''}" data-refsec="1">造型 <span class="n">${sc['1'] || 0}</span></button>
      <span style="width:1px;height:22px;background:var(--line-strong);margin:0 4px"></span>
      <button class="chip ${st.len === '' ? 'active' : ''}" data-reflen="">不限发长</button>
      ${lengths.map((l, i) => `<button class="chip ${st.len === String(i) ? 'active' : ''}" data-reflen="${i}">${esc(l)}</button>`).join('')}
      <div class="spacer"></div>
      <span class="ref-total">${list.length} 张</span>
    </div>`;
  }

  function gridHTML(kind) {
    const st = state[kind];
    const list = filtered(kind);
    if (!list.length) {
      return `<div class="empty">${V.icon('search', 40)}<b>没有匹配的图</b><p>换个关键词，或者清掉筛选条件。</p></div>`;
    }
    const slice = list.slice(0, st.shown || PAGE);
    return `<div class="ref-grid ${kind === 'faces' ? 'tall' : ''}" id="ref-grid">${slice.map((it, i) => cardHTML(kind, it, i)).join('')}</div>
      <div id="ref-sentinel" style="height:1px"></div>
      <div class="ref-more" id="ref-more">${slice.length < list.length ? `已显示 ${slice.length} / ${list.length}` : `共 ${list.length} 张`}</div>`;
  }

  function bindToolbar(container, kind) {
    const st = state[kind];
    const q = container.querySelector('#ref-q');
    if (q) {
      q.oninput = U.debounce(() => {
        st.q = q.value.trim();
        st.shown = PAGE;
        repaint(container, kind, true);
      }, 220);
    }
    container.querySelectorAll('[data-refcat]').forEach(b => {
      b.onclick = () => { st.cat = b.dataset.refcat; st.shown = PAGE; repaint(container, kind, true); };
    });
    container.querySelectorAll('[data-refsec]').forEach(b => {
      b.onclick = () => { st.sec = b.dataset.refsec; st.shown = PAGE; repaint(container, kind, true); };
    });
    container.querySelectorAll('[data-reflen]').forEach(b => {
      b.onclick = () => { st.len = b.dataset.reflen; st.shown = PAGE; repaint(container, kind, true); };
    });
  }

  function repaint(container, kind, full) {
    const st = state[kind];
    if (full) {
      container.innerHTML = toolbarHTML(kind) + gridHTML(kind) + footerHTML(kind);
      bindToolbar(container, kind);
      observeSentinel(container, kind);
    } else {
      const g = container.querySelector('#ref-grid');
      const list = filtered(kind);
      if (g) {
        const from = g.children.length;
        const next = list.slice(from, st.shown);
        if (next.length) {
          g.insertAdjacentHTML('beforeend', next.map((it, i) => cardHTML(kind, it, from + i)).join(''));
        }
      }
      const more = container.querySelector('#ref-more');
      const shown = Math.min(st.shown, list.length);
      if (more) more.textContent = shown < list.length ? `已显示 ${shown} / ${list.length}` : `共 ${list.length} 张`;
      observeSentinel(container, kind);
    }
  }

  let io = null;
  function observeSentinel(container, kind) {
    const st = state[kind];
    const el = container.querySelector('#ref-sentinel');
    if (!el) return;
    if (!io) {
      io = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          const k = e.target.dataset.kind;
          const s = state[k];
          const total = filtered(k).length;
          if (s.shown >= total) return;
          s.shown = Math.min(total, (s.shown || PAGE) + PAGE);
          const c = document.querySelector('#view');
          if (c) repaint(c, k, false);
        });
      }, { root: document.querySelector('#view'), rootMargin: '800px' });
    }
    el.dataset.kind = kind;
    io.observe(el);
  }

  function register(kind, title, subFn) {
    V.registerView(kind, {
      title,
      sub: subFn,
      upload: false,
      actions: () => `<button class="btn" data-act="ref-to-composer">${V.icon('spark', 14)} 去组合提示词</button>
                      <button class="btn" data-act="ref-open-source" data-kind="${kind}">${V.icon('link', 14)} 源站</button>`,
      render: async (c) => {
        try {
          await load(kind);
        } catch (e) {
          c.innerHTML = `<div class="empty">${V.icon('img', 40)}<b>参考库数据没加载出来</b>
            <p>${esc(e.message)}<br>确认 <code>reference/data.js</code> 或 <code>reference/${kind}.json</code> 存在。</p></div>`;
          return;
        }
        state[kind].shown = PAGE;
        c.innerHTML = toolbarHTML(kind) + gridHTML(kind) + footerHTML(kind);
        bindToolbar(c, kind);
        observeSentinel(c, kind);
      }
    });
  }

  function footerHTML(kind) {
    const meta = state[kind].meta;
    const n = meta?.count || 0;
    const src = kind === 'outfits'
      ? '图片与原始数据著作权归 ギア（@giaaibusi）所有，来源「衣装集 COSTUME-DB-01」，可在其许可范围内用于创作，禁止再分发图片数据本身。'
      : '图片署名 ギア / あぎ（@agi_aibusi），原始图库 AIモデル顔データベース，CC0。';
    return `<p class="ref-note">
      共 ${n} 张参考缩略图，已全部本地化到 <code>reference/${kind}/</code>，断网可用。<br>
      ${esc(src)}<br>
      本页仅作个人素材参考，图片版权不随本项目的代码许可转让。
    </p>`;
  }

  /* ============================================================
     灯箱
     ============================================================ */
  function openLightbox(kind, index) {
    state.lb = { kind, index, open: true };
    renderLightbox();
    document.querySelector('#lightbox').classList.remove('hidden');
  }

  function close() {
    state.lb.open = false;
    document.querySelector('#lightbox').classList.add('hidden');
    document.querySelector('#lightbox').innerHTML = '';
  }

  function step(dir) {
    const list = filtered(state.lb.kind);
    if (list.length < 2) return;
    state.lb.index = (state.lb.index + dir + list.length) % list.length;
    renderLightbox();
  }

  function renderLightbox() {
    const { kind, index } = state.lb;
    const list = filtered(kind);
    const item = list[index];
    if (!item) return close();

    const lb = document.querySelector('#lightbox');
    const isOutfit = kind === 'outfits';
    const sections = state.faces.meta?.sections || [];
    const lengths = state.faces.meta?.lengths || [];
    const staged = isOutfit ? state.stage.outfit?.id === item.id : state.stage.face?.id === item.id;

    lb.innerHTML = `
      <div class="lb-stage">
        <div class="lb-topbar">
          <span class="lb-id">${esc(item.id)}</span>
          <span class="badge">${esc(isOutfit ? item.cat : (sections[item.sec]?.name || '参考图'))}</span>
          ${!isOutfit && lengths[item.len] ? `<span class="badge">${esc(lengths[item.len])}</span>` : ''}
          <div class="spacer"></div>
          <button class="icon-btn ${staged ? 'on' : ''}" data-refact="ref-stage" title="${isOutfit ? '用作服装' : '用作脸'}">${V.icon(isOutfit ? 'shirt' : 'user', 15)}</button>
          <button class="icon-btn" data-refact="ref-save" title="存入我的图库">${V.icon('plus', 15)}</button>
          <button class="icon-btn" data-refact="ref-download" title="下载">${V.icon('down', 15)}</button>
          <button class="icon-btn" data-refact="ref-close" title="关闭 (Esc)">${V.icon('close', 15)}</button>
        </div>
        <div class="lb-canvas">
          ${list.length > 1 ? `<button class="lb-nav prev" data-refact="ref-prev">${V.icon('left', 18)}</button>` : ''}
          <img src="${esc(item.thumb)}" alt="${esc(item.id)}">
          ${list.length > 1 ? `<button class="lb-nav next" data-refact="ref-next">${V.icon('right', 18)}</button>` : ''}
        </div>
        <div class="lb-foot">
          <span>${isOutfit ? '360×540 缩略图' : `${item.w || '?'}×${item.h || '?'} 原图`}</span>
          <span>${index + 1} / ${list.length}</span>
        </div>
      </div>
      <aside class="lb-panel">
        <div class="lb-panel-head">
          <h3>${isOutfit ? '关键词' : '档案'}</h3>
          <div class="spacer"></div>
          <button class="btn sm" data-refact="ref-copy-kw">${V.icon('copy', 13)} 复制</button>
          <button class="btn sm primary" data-refact="ref-write">${V.icon('spark', 13)} AI 写成提示词</button>
        </div>
        <div class="lb-panel-body">
          ${isOutfit ? `
            <div class="prompt-current" id="ref-kw">${esc(item.kw || '（无关键词）')}</div>
            <div style="display:flex;gap:6px;margin-top:8px">
              <button class="btn sm ghost" data-refact="ref-copy-prompt">${V.icon('copy', 13)} 复制成品提示词</button>
            </div>
            <div class="section">
              <div class="section-title">说明<span></span></div>
              <p class="ref-desc">纯服装参考，不含人物。关键词为英文短语，可直接拼进提示词，也可以让智能体扩写成完整描述。</p>
            </div>
          ` : `
            <dl class="kv">
              <dt>编号</dt><dd>${esc(item.id)}</dd>
              <dt>分区</dt><dd>${esc(sections[item.sec]?.name || '—')}</dd>
              <dt>发长</dt><dd>${esc(lengths[item.len] || '—')}</dd>
              <dt>风格</dt><dd>${esc(item.style || '—')}</dd>
              <dt>原图</dt><dd>${item.w || '?'}×${item.h || '?'}</dd>
            </dl>
            <div class="section">
              <div class="section-title">说明<span></span></div>
              <p class="ref-desc">${esc(sections[item.sec]?.note || '')}用于在不同画面里保持同一张脸，可用作角色一致性参考。</p>
            </div>
            <div style="display:flex;gap:6px;margin-top:12px">
              <button class="btn sm ghost" data-refact="ref-copy-kw">${V.icon('copy', 13)} 复制关键词</button>
            </div>
          `}
          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn" style="flex:1;justify-content:center" data-refact="ref-stage">
              ${V.icon(isOutfit ? 'shirt' : 'user', 14)} ${staged ? '已加入组合台' : (isOutfit ? '用作服装' : '用作脸')}
            </button>
            <button class="btn" style="flex:1;justify-content:center" data-refact="ref-save">
              ${V.icon('plus', 14)} 存入图库
            </button>
          </div>
          <div class="section">
            <div class="section-title">来源<span></span></div>
            <p class="ref-desc">
              ${isOutfit
                ? 'AI-Clothing-Resource-Library · 衣装集 COSTUME-DB-01 · 图 ギア（@giaaibusi）'
                : 'AI-Face-Resource-Library · AIモデル顔データベース · 图 ギア / あぎ（@agi_aibusi）· CC0'}
            </p>
          </div>
        </div>
      </aside>`;
  }

  /* ============================================================
     操作
     ============================================================ */
  function currentItem() {
    const { kind, index } = state.lb;
    return filtered(kind)[index];
  }

  function outfitPrompt(item) {
    return [
      'flat lay of clothing only, no person, ' + item.kw,
      'pure white seamless background, soft even lighting, front view, 2:3 vertical, product photography, high detail'
    ].join(', ');
  }

  async function saveToVault(item, kind) {
    if (isFile()) {
      return V.toast('file:// 下写不了图片数据，双击 start.command 用本地服务打开后再存', 'err');
    }
    const cat = V.state.categories.find(c => c.name === '参考图') || V.state.categories[0];
    if (!cat) return V.toast('还没有分类', 'err');

    const existed = V.state.images.find(i => (i.note || '').includes(item.id) || (i.tags || []).includes(item.id));
    if (existed) return V.toast('这张已经在你的图库里了', 'err');

    try {
      const res = await fetch(item.thumb);
      const blob = await res.blob();
      const thumb = await Parse.makeThumb(blob, 640, 0.85);

      const seq = await DB.nextSeq(cat.id);
      const id = `${cat.prefix || 'REF'}-${U.pad(seq, 4)}`;
      const blobId = U.uid('bl');
      const thumbId = U.uid('th');
      await DB.putBlob(blobId, blob, { kind: 'original' });
      await DB.putBlob(thumbId, thumb, { kind: 'thumb' });

      const now = Date.now();
      const pv = V.newVersion(
        kind === 'outfits' ? outfitPrompt(item) : (item.style || ''),
        '', 'import', `参考库 ${item.id}`
      );
      const dims = await new Promise(r => {
        const img = new Image();
        img.onload = () => r({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => r({ w: null, h: null });
        img.src = URL.createObjectURL(blob);
      });

      await DB.put('images', {
        id, categoryId: cat.id, modelId: '',
        blobId, thumbId,
        filename: `${item.id}.webp`,
        size: blob.size, mime: blob.type,
        width: dims.w, height: dims.h,
        favorite: false,
        tags: [item.id, kind === 'outfits' ? (item.cat || '') : 'face'].filter(Boolean),
        note: `来自参考库 ${item.id}`,
        source: 'import',
        modelName: '', sampler: '', scheduler: '', steps: null, cfg: null,
        seed: '', denoise: null, loraNames: [], loraIds: [],
        prompts: [pv], activePromptId: pv.id,
        createdAt: now, updatedAt: now
      });

      await V.reload();
      V.renderNav();
      V.toast(`已存入图库：${id}`, 'ok');
    } catch (e) {
      V.toast('存入失败：' + e.message, 'err');
    }
  }

  function aiWrite(item, kind) {
    const agent = AI.agentById(AI.lastAgentId());
    const base = kind === 'outfits'
      ? `这组服装关键词：${item.kw}`
      : `一张人脸参考图（${state.faces.meta?.lengths?.[item.len] || ''}${item.style ? '，' + item.style : ''}），分区：${state.faces.meta?.sections?.[item.sec]?.name || ''}`;

    V.openModal({
      title: '让智能体写成提示词',
      sub: `${agent?.name || '智能体'} · 结果可以复制`,
      wide: true,
      body: `
        <div class="field full" style="margin-bottom:12px">
          <label>素材描述</label>
          <div class="prompt-current" style="max-height:130px">${esc(base)}</div>
        </div>
        <div class="field full">
          <label>生成结果</label>
          <div id="ref-ai-out" style="min-height:120px;padding:11px 12px;border:1px solid var(--line-strong);border-radius:9px;background:var(--panel-2);font-family:var(--mono);font-size:12px;line-height:1.65;white-space:pre-wrap;color:var(--text-2)">点右下角「生成」开始</div>
        </div>`,
      footer: `<button class="btn" data-close>取消</button>
               <button class="btn" id="ref-ai-copy" disabled>${V.icon('copy', 13)} 复制</button>
               <button class="btn primary" id="ref-ai-gen">生成</button>`,
      onMount: (el) => {
        const out = el.querySelector('#ref-ai-out');
        const copyBtn = el.querySelector('#ref-ai-copy');
        let text = '';
        el.querySelector('#ref-ai-gen').onclick = async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> 生成中';
          out.textContent = '正在请求模型…';
          try {
            const r = await AI.generate({
              agentId: AI.lastAgentId(),
              mode: kind === 'outfits' ? 'expand' : 'refine',
              prompt: kind === 'outfits' ? item.kw : base
            });
            text = r.text;
            out.textContent = text;
            copyBtn.disabled = false;
          } catch (e) {
            out.textContent = '✕ ' + e.message;
          } finally {
            btn.disabled = false;
            btn.textContent = '重新生成';
          }
        };
        copyBtn.onclick = async () => {
          await U.copy(text);
          V.toast('已复制', 'ok');
        };
      }
    });
  }

  /* ============================================================
     组合台：脸 + 服装 → 一条完整提示词
     ============================================================ */
  function composeText() {
    const { face, outfit } = state.stage;
    const bits = [];

    if (face) {
      bits.push('portrait of a young woman');
      const hair = HAIR_EN[face.len];
      if (hair) bits.push(hair);
      if (face.sec === 1) bits.push('styled look');
    } else {
      bits.push('a young woman');
    }

    if (outfit) bits.push('wearing ' + outfit.kw);

    bits.push('standing, natural pose');
    bits.push('soft window light, 85mm lens, shallow depth of field');
    bits.push('photorealistic, fine skin detail, subtle film grain');
    return bits.join(', ');
  }

  function stageOf(kind) {
    return kind === 'outfits' ? 'outfit' : 'face';
  }

  function setStage(kind, item) {
    if (item) state.stage[stageOf(kind)] = item;
    V.renderNav();
  }

  function slotHTML(role) {
    const item = state.stage[role];
    const isFace = role === 'face';
    const label = isFace ? '脸' : '服装';
    const kind = isFace ? 'faces' : 'outfits';
    if (!item) {
      return `<div class="comp-slot empty-slot">
        <div class="slot-label">${label}</div>
        <div class="slot-empty">
          ${V.icon(isFace ? 'user' : 'shirt', 26)}
          <span>还没有选${label}</span>
        </div>
        <button class="btn sm" data-compick="${kind}">选择${label}</button>
      </div>`;
    }
    const meta = isFace
      ? (state.faces.meta?.lengths?.[item.len] || '') + (item.style ? ' · ' + item.style : '')
      : (item.cat || '');
    return `<div class="comp-slot">
      <div class="slot-label">${label}</div>
      <img class="slot-img ${isFace ? 'face' : 'fit'}" src="${esc(item.thumb)}" alt="">
      <div class="slot-meta">${esc(meta || '—')}</div>
      <div class="slot-ops">
        <button class="btn sm" data-compick="${kind}">换一张</button>
        <button class="btn sm ghost" data-clear="${role}">清除</button>
      </div>
    </div>`;
  }

  V.registerView('composer', {
    title: '提示词组合',
    sub: () => {
      const n = stageCount();
      return n
        ? `已选 ${n} 项 · 一条完整提示词由「人物 + 服装 + 场景 + 画质」四段拼成`
        : '从参考库挑一张脸、一套衣服，直接拼成出图提示词';
    },
    actions: () => `<button class="btn" data-act="comp-clear">清空</button>`,
    render: async (c) => {
      try { await Promise.all([load('faces'), load('outfits')]); } catch { }

      const text = restoreText != null ? restoreText : composeText();
      restoreText = null;
      c.innerHTML = `
        <div class="composer">
          <div class="comp-left">
            ${slotHTML('face')}
            <div class="comp-plus">+</div>
            ${slotHTML('outfit')}
          </div>
          <div class="comp-right">
            <div class="section-title" style="margin-top:0">拼接结果<span></span></div>
            <textarea id="comp-text" class="comp-text" spellcheck="false">${esc(text)}</textarea>
            <div class="comp-actions">
              <button class="btn" data-act="comp-remix">${V.icon('spark', 14)} AI 润色成片</button>
              <button class="btn" data-act="comp-copy">${V.icon('copy', 14)} 复制</button>
              <div style="flex:1"></div>
              <span class="comp-agent">智能体：${esc(AI.agentById(AI.lastAgentId())?.name || '—')}</span>
            </div>
            <div class="comp-note">
              <b>怎么用：</b>这条提示词描述的是「长相大致特征 + 服装款式」。想真正固定同一张脸，把选中的脸图作为参考图 / 图生图输入，比纯文字更准。<br>
              人物来源 <code>${esc(state.stage.face?.id?.slice(0, 10) || '未选')}</code>，服装来源 <code>${esc(state.stage.outfit?.id || '未选')}</code>。
            </div>
          </div>
        </div>
        ${histBlockHTML()}`;
    }
  });

  V.on('comp-clear', () => {
    state.stage = { face: null, outfit: null };
    V.renderNav();
    V.render();
  });

  V.on('comp-copy', async () => {
    const t = document.querySelector('#comp-text')?.value || '';
    if (!t.trim()) return V.toast('还没有内容', 'err');
    await U.copy(t);
    pushHist(t, '复制');
    V.toast('提示词已复制，已存入历史', 'ok');
    V.render();
  });

  V.on('comp-remix', async () => {
    const { face, outfit } = state.stage;
    if (!face && !outfit) return V.toast('先从参考库挑一张脸或一套衣服', 'err');
    const agent = AI.agentById(AI.lastAgentId());
    const brief = [
      face ? `人物：一位女性，${state.faces.meta?.lengths?.[face.len] || ''}，正面人像` : '人物：一位女性',
      outfit ? `服装：${outfit.kw}` : '',
      '请写一条完整的文生图提示词，把人物与服装自然地融合在一张照片里'
    ].filter(Boolean).join('\n');

    const ta = document.querySelector('#comp-text');
    const btn = document.querySelector('[data-act="comp-remix"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 生成中'; }
    try {
      const r = await AI.generate({ agentId: AI.lastAgentId(), mode: 'expand', prompt: brief });
      if (ta) ta.value = r.text;
      pushHist(r.text, agent?.name || 'AI');
      V.toast(`${agent?.name || 'AI'} 已重写`, 'ok');
      V.render();
    } catch (e) {
      V.toast(e.message, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = V.icon('spark', 14) + ' AI 润色成片'; }
    }
  });

  /* ---------------- 选择器 ---------------- */
  function picker(kind) {
    const isFace = kind === 'faces';
    const title = isFace ? '选一张脸' : '选一套服装';
    let q = '';
    let shown = PAGE;

    const listOf = () => {
      let arr = state[kind].items;
      if (q) {
        const s = q.toLowerCase();
        arr = arr.filter(i => !isFace
          ? (i.id.toLowerCase().includes(s) || (i.kw || '').toLowerCase().includes(s) || (i.cat || '').includes(q))
          : (i.id.toLowerCase().includes(s) || (state.faces.meta?.lengths?.[i.len] || '').includes(q)));
      }
      return arr;
    };

    const gridOf = () => {
      const arr = listOf().slice(0, shown);
      if (!arr.length) return `<div class="empty" style="padding:40px 0">${V.icon('search', 32)}<b>没有匹配</b></div>`;
      return `<div class="ref-grid ${isFace ? 'tall' : ''}" id="pk-grid">
        ${arr.map((it, i) => `<div class="ref-card ${state.stage[stageOf(kind)]?.id === it.id ? 'picked' : ''}" data-pk="${i}">
          <img src="${esc(it.thumb)}" loading="lazy" alt="">
          <div class="ref-hover"><div class="ref-kw">${esc(isFace ? (state.faces.meta?.lengths?.[it.len] || '') : (it.kw || ''))}</div></div>
        </div>`).join('')}
      </div>
      <div class="ref-more">${arr.length < listOf().length ? `已显示 ${arr.length} / ${listOf().length}，往下滚加载更多` : `共 ${arr.length} 张`}</div>`;
    };

    V.openModal({
      title,
      sub: isFace ? '选一张脸做人物参考' : '选一套服装',
      wide: true,
      body: `<div class="gallery-toolbar" style="margin-bottom:12px">
          <div class="search-box">${V.icon('search', 15)}<input id="pk-q" type="text" placeholder="搜索关键词"></div>
          <div style="flex:1"></div>
          <span class="ref-total" id="pk-count"></span>
        </div>
        <div id="pk-body">${gridOf()}</div>`,
      footer: `<button class="btn" data-close>取消</button>`,
      onMount: (box, closeFn) => {
        const body = box.querySelector('#pk-body');
        const count = box.querySelector('#pk-count');
        const paint = () => {
          body.innerHTML = gridOf();
          count.textContent = `${listOf().length} 张`;
          bindPicks();
        };
        const bindPicks = () => {
          body.querySelectorAll('[data-pk]').forEach(el => {
            el.onclick = () => {
              const item = listOf()[Number(el.dataset.pk)];
              if (!item) return;
              setStage(kind, item);
              closeFn();
              V.render();
              V.toast(`已选${isFace ? '脸' : '服装'}：${isFace ? item.id.slice(0, 8) : item.id}`, 'ok');
            };
          });
        };
        box.querySelector('#pk-q').oninput = U.debounce(e => { q = e.target.value.trim(); shown = PAGE; paint(); }, 200);
        const scrollHost = box.querySelector('.modal-body') || box;
        scrollHost.addEventListener('scroll', () => {
          if (scrollHost.scrollTop + scrollHost.clientHeight > scrollHost.scrollHeight - 300) {
            const total = listOf().length;
            if (shown < total) { shown = Math.min(total, shown + PAGE); paint(); }
          }
        });
        paint();
      }
    });
  }

  /* ============================================================
     事件
     ============================================================ */
  function restoreHist(id) {
    const h = loadHist().find(x => x.id === id);
    if (!h) return;
    state.stage.face = h.face ? (state.faces.items.find(i => i.id === h.face.id) || h.face) : null;
    state.stage.outfit = h.outfit ? (state.outfits.items.find(i => i.id === h.outfit.id) || h.outfit) : null;
    restoreText = h.text;
    V.renderNav();
    V.render();
    V.toast('已恢复这次组合', 'ok');
  }

  function removeHist(id) {
    histCache = loadHist().filter(h => h.id !== id);
    saveHist();
    V.render();
  }

  document.addEventListener('click', async (e) => {
    const hd = e.target.closest('[data-histdel]');
    if (hd) { e.stopPropagation(); return removeHist(hd.dataset.histdel); }
    const hi = e.target.closest('[data-hist]');
    if (hi) return restoreHist(hi.dataset.hist);

    const card = e.target.closest('[data-ref]');
    if (card) {
      openLightbox(card.dataset.ref, Number(card.dataset.index));
      return;
    }

    const pick = e.target.closest('[data-compick]');
    if (pick) {
      picker(pick.dataset.compick);
      return;
    }
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      state.stage[clear.dataset.clear] = null;
      V.renderNav();
      V.render();
      return;
    }

    const act = e.target.closest('[data-refact]');
    if (!act) return;
    const a = act.dataset.refact;
    const item = currentItem();
    if (!item) return;
    const isOutfit = state.lb.kind === 'outfits';

    if (a === 'ref-close') return close();
    if (a === 'ref-prev') return step(-1);
    if (a === 'ref-next') return step(1);
    if (a === 'ref-copy-kw') {
      const t = isOutfit ? item.kw : (item.style || item.id);
      await U.copy(t || '');
      return V.toast('已复制', 'ok');
    }
    if (a === 'ref-copy-prompt') {
      await U.copy(outfitPrompt(item));
      return V.toast('成品提示词已复制', 'ok');
    }
    if (a === 'ref-save') return saveToVault(item, state.lb.kind);
    if (a === 'ref-download') {
      if (isFile()) return V.toast('file:// 下不能下载，右键图片「图片另存为」即可', 'err');
      const res = await fetch(item.thumb).catch(() => null);
      if (!res) return V.toast('下载失败', 'err');
      const b = await res.blob();
      U.download(item.id + '.webp', b);
      return;
    }
    if (a === 'ref-write') return aiWrite(item, state.lb.kind);
    if (a === 'ref-stage') {
      const role = stageOf(state.lb.kind);
      const already = state.stage[role]?.id === item.id;
      if (already) {
        state.stage[role] = null;
        V.toast('已从组合台移除');
      } else {
        state.stage[role] = item;
        V.toast(`已加入组合台：${isOutfit ? '服装' : '脸'}`, 'ok');
      }
      V.renderNav();
      renderLightbox();
      return;
    }
  });

  V.on('ref-open-source', (el) => {
    window.open(el.dataset.kind === 'outfits'
      ? 'https://github.com/Atom-kkk/AI-Clothing-Resource-Library'
      : 'https://github.com/Atom-kkk/AI-Face-Resource-Library', '_blank');
  });

  V.on('ref-to-composer', () => V.go('composer'));

  /* ============================================================
     视图注册
     ============================================================ */
  register('outfits', '服饰参考库', () => {
    const n = state.outfits.items.length;
    return `${n || 1407} 张服装参考图 · 8 个分类 · 纯服装不含人物，可直接拿关键词拼提示词`;
  });

  register('faces', '人脸参考库', () => {
    const n = state.faces.items.length;
    return `${n || 1499} 张人脸 / 造型参考图 · 用于统一角色长相`;
  });

  return {
    preload, counts, stageCount, isOpen: () => state.lb.open, step, close,
    composeText, stage: state.stage
  };
})();
