/* ============================================================
   library.js — 姊妹素材库：动画服装 / 角色组装 / 姿势深度
   ------------------------------------------------------------
   三个库原本是独立静态站，这里接进 Loom 的参考图库体系：
     · 动画服装  AI-Costume-Anime-Resource-Library（1320 套，8 类）
     · 角色组装  Character-Assembly-Database（1027 张，发型/服装/姿势）
     · 姿势深度  AI-Pose-Depth-Resource-Library（1439 张，288 组 / 5 视角）

   数据走 reference/*.json；file:// 双击时走 reference/data-extra.js。
   缩略图已本地化；原图按需从 jsDelivr / 原站拉取并缓存进 IndexedDB。
   ============================================================ */

window.LIB = (function () {
  'use strict';

  const V = window.Vault;
  const PAGE = 120;
  const HI_MAX = 40;
  const HI_TIMEOUT = 15000;
  const THUMB_VER = '1';

  const KINDS = {
    costume: {
      title: '动画服装',
      json: 'costume.json',
      dir: 'costume',
      source: 'https://github.com/Atom-kkk/AI-Costume-Anime-Resource-Library',
      note: 'COSTUME-ANIME-DB · 衣装集 アニメ版 · 图 ギア（@giaaibusi）· 可免费用创作，禁止再分发/转售图片数据本身。'
    },
    assembly: {
      title: '角色组装',
      json: 'assembly.json',
      dir: 'assembly',
      source: 'https://github.com/Atom-kkk/Character-Assembly-Database',
      note: 'Character-Assembly-Database · 原始日文角色组装素材库 · 图片仅作参考 / ControlNet 底图，禁止再分发/转售。'
    },
    poseDepth: {
      title: '姿势深度',
      json: 'pose-depth.json',
      dir: 'pose-depth',
      source: 'https://github.com/Atom-kkk/AI-Pose-Depth-Resource-Library',
      note: 'POSE Atlas depth 分册 · 图 ギア（@giaaibusi）· 可免费用创作，禁止再分发/转售图片数据本身；代码 MIT。'
    }
  };

  const state = {
    costume: { meta: null, items: [], shown: 0, q: '', cat: '', loading: null },
    assembly: { meta: null, items: [], shown: 0, q: '', set: '', cat: '', hideVar: false, loading: null },
    poseDepth: { meta: null, items: [], shown: 0, q: '', cat: '', cls: '', angle: '', loading: null },
    lb: { kind: '', index: 0, open: false, line: false }
  };

  const esc = U.esc;
  const isFile = () => location.protocol === 'file:';
  const setLabels = { hair: '发型', outfit: '服装', pose: '姿势' };
  const POSE_VIEW_ORDER = ['正面', '侧面', '斜侧', '俯视', '仰视'];
  const hiMem = new Map();

  /* ============================================================
     数据
     ============================================================ */
  function thumbUrl(u) {
    if (!u) return u;
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'v=' + THUMB_VER;
  }

  function inlineData(kind) {
    if (window.REF_DATA_EXTRA && window.REF_DATA_EXTRA[kind]) return window.REF_DATA_EXTRA[kind];
    if (window.REF_DATA && window.REF_DATA[kind]) return window.REF_DATA[kind];
    return null;
  }

  async function load(kind) {
    const st = state[kind];
    if (st.items.length) return st;
    if (st.loading) return st.loading;
    st.loading = (async () => {
      let json = inlineData(kind);
      if (!json) {
        const res = await fetch('reference/' + KINDS[kind].json);
        if (!res.ok) throw new Error(`读取 reference/${KINDS[kind].json} 失败`);
        json = await res.json();
      }
      st.meta = json;
      st.items = (json.items || []).map(it => Object.assign({}, it, { thumb: thumbUrl(it.thumb) }));
      return st;
    })();
    return st.loading;
  }

  async function preload() {
    try {
      await Promise.all(['costume', 'assembly', 'poseDepth'].map(load));
    } catch (e) {
      console.warn('姊妹素材库加载失败', e);
    }
    V.renderNav();
  }

  function counts() {
    return {
      costume: state.costume.items.length,
      assembly: state.assembly.items.length,
      poseDepth: state.poseDepth.items.length
    };
  }

  /* ============================================================
     筛选
     ============================================================ */
  function filtered(kind) {
    const st = state[kind];
    let arr = st.items;
    const q = (st.q || '').toLowerCase();

    if (kind === 'costume') {
      if (st.cat) arr = arr.filter(i => i.cat === st.cat);
      if (q) arr = arr.filter(i => [i.id, i.cat, i.kwZh, i.kw].join(' ').toLowerCase().includes(q));
    } else if (kind === 'assembly') {
      if (st.set) arr = arr.filter(i => i.set === st.set);
      if (st.cat) arr = arr.filter(i => i.cat === st.cat);
      if (st.set === 'hair' && st.hideVar) arr = arr.filter(i => i.sub !== 'style_color');
      if (q) arr = arr.filter(i => [i.id, i.zh, i.jp, i.cat, i.cj, i.tags].join(' ').toLowerCase().includes(q));
    } else {
      if (st.cat) arr = arr.filter(i => i.cat === st.cat);
      if (st.cls) arr = arr.filter(i => i.cls === st.cls);
      if (st.angle) arr = arr.filter(i => i.angle === st.angle);
      if (q) arr = arr.filter(i => [i.id, i.code, i.name, i.cls, i.cat, i.angle].join(' ').toLowerCase().includes(q));
    }
    return arr;
  }

  function countBy(arr, key) {
    const m = {};
    arr.forEach(i => { m[i[key]] = (m[i[key]] || 0) + 1; });
    return m;
  }

  function poseGroups() {
    const list = filtered('poseDepth');
    const idxOf = new Map(list.map((it, i) => [it.id, i]));
    const map = new Map();
    list.forEach(it => {
      const key = it.code + '|' + it.cat;
      if (!map.has(key)) map.set(key, { code: it.code, name: it.name, cls: it.cls, cat: it.cat, views: [] });
      map.get(key).views.push(it);
    });
    const groups = [...map.values()];
    groups.forEach(g => {
      g.views.sort((a, b) => {
        const ia = POSE_VIEW_ORDER.indexOf(a.angle);
        const ib = POSE_VIEW_ORDER.indexOf(b.angle);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      g.idx = idxOf.get(g.views[0].id) ?? 0;
    });
    groups.sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }));
    return groups;
  }

  /* ============================================================
     工具栏
     ============================================================ */
  function toolbarHTML(kind) {
    const st = state[kind];
    const list = filtered(kind);
    const total = list.length;

    if (kind === 'costume') {
      const cc = countBy(st.items, 'cat');
      const cats = st.meta?.categories || [];
      return `<div class="gallery-toolbar">
        <div class="search-box">${V.icon('search', 15)}<input id="lib-q" type="text" placeholder="搜索编号 / 中文 / 英文关键词" value="${esc(st.q)}"></div>
        <button class="chip ${!st.cat ? 'active' : ''}" data-libcat="">全部 <span class="n">${st.items.length}</span></button>
        ${cats.map(c => `<button class="chip ${st.cat === c ? 'active' : ''}" data-libcat="${esc(c)}">${esc(c)} <span class="n">${cc[c] || 0}</span></button>`).join('')}
        <div class="spacer"></div>
        <span class="ref-total">${total} 套</span>
      </div>`;
    }

    if (kind === 'assembly') {
      const sc = countBy(st.items, 'set');
      const setChips = ['hair', 'outfit', 'pose'].map(s =>
        `<button class="chip ${st.set === s ? 'active' : ''}" data-libset="${s}">${setLabels[s]} <span class="n">${sc[s] || 0}</span></button>`
      ).join('');
      const cats = st.set ? (st.meta?.categories?.[st.set] || []) : [];
      const cc = st.set ? countBy(st.items.filter(i => i.set === st.set), 'cat') : {};
      const catRow = st.set ? `<div class="gallery-toolbar" style="margin-top:6px">
        <button class="chip ${!st.cat ? 'active' : ''}" data-libcat="">全部${setLabels[st.set]} <span class="n">${sc[st.set] || 0}</span></button>
        ${cats.map(c => `<button class="chip ${st.cat === c ? 'active' : ''}" data-libcat="${esc(c)}">${esc(c)} <span class="n">${cc[c] || 0}</span></button>`).join('')}
        ${st.set === 'hair' ? `<span style="width:1px;height:22px;background:var(--line-strong);margin:0 4px"></span>
          <button class="chip ${st.hideVar ? 'active' : ''}" data-libvar="1">只看主发型</button>` : ''}
        <div class="spacer"></div>
        <span class="ref-total">${total} 张</span>
      </div>` : '';
      return `<div class="gallery-toolbar">
        <div class="search-box">${V.icon('search', 15)}<input id="lib-q" type="text" placeholder="搜索中文 / 日文 / Danbooru 标签" value="${esc(st.q)}"></div>
        <button class="chip ${!st.set ? 'active' : ''}" data-libset="">全部 <span class="n">${st.items.length}</span></button>
        ${setChips}
        ${st.set ? '' : `<div class="spacer"></div><span class="ref-total">${total} 张</span>`}
      </div>${catRow}`;
    }

    const pc = countBy(st.items, 'cat');
    const systems = st.meta?.systems || [];
    const classes = st.meta?.classes || [];
    const angles = st.meta?.angles || POSE_VIEW_ORDER;
    return `<div class="gallery-toolbar">
      <div class="search-box">${V.icon('search', 15)}<input id="lib-q" type="text" placeholder="搜索姿势名 / 编号 / 分类" value="${esc(st.q)}"></div>
      <button class="chip ${!st.cat ? 'active' : ''}" data-libcat="">全部体系 <span class="n">${st.items.length}</span></button>
      ${systems.map(c => `<button class="chip ${st.cat === c ? 'active' : ''}" data-libcat="${esc(c)}">${esc(c)} <span class="n">${pc[c] || 0}</span></button>`).join('')}
    </div>
    <div class="gallery-toolbar" style="margin-top:6px">
      <button class="chip ${!st.cls ? 'active' : ''}" data-libcls="">全部动作</button>
      ${classes.map(c => `<button class="chip ${st.cls === c ? 'active' : ''}" data-libcls="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <div class="gallery-toolbar" style="margin-top:6px">
      <button class="chip ${!st.angle ? 'active' : ''}" data-libangle="">全部视角</button>
      ${angles.map(a => `<button class="chip ${st.angle === a ? 'active' : ''}" data-libangle="${esc(a)}">${esc(a)}</button>`).join('')}
      <div class="spacer"></div>
      <span class="ref-total">${poseGroups().length} 组 / ${total} 张</span>
    </div>`;
  }

  /* ============================================================
     网格
     ============================================================ */
  function cardHTML(kind, item, index) {
    if (kind === 'costume') {
      return `<div class="ref-card" data-libcard="costume" data-li="${index}">
        <img src="${esc(item.thumb)}" loading="lazy" decoding="async" alt="${esc(item.id)}">
        <div class="ref-hover">
          <div class="ref-id">${esc(item.id)} · ${esc(item.cat)}</div>
          <div class="ref-kw">${esc(item.kw || item.kwZh || '')}</div>
        </div>
      </div>`;
    }
    if (kind === 'assembly') {
      return `<div class="ref-card" data-libcard="assembly" data-li="${index}">
        <img src="${esc(item.thumb)}" loading="lazy" decoding="async" alt="${esc(item.id)}">
        ${item.line ? '<span class="lib-badge">线稿</span>' : ''}
        <div class="ref-hover">
          <div class="ref-id">${esc(item.id)} · ${esc(item.cat)}</div>
          <div class="ref-kw">${esc(item.zh || '')}${item.tags ? ' · ' + esc(item.tags) : ''}</div>
        </div>
      </div>`;
    }
    return '';
  }

  function poseCardHTML(group) {
    const main = group.views[0];
    const dots = group.views.map(v => {
      const ch = v.angle === '正面' ? '正' : v.angle === '侧面' ? '侧' : v.angle === '斜侧' ? '斜' : v.angle === '俯视' ? '俯' : '仰';
      return `<span class="pose-view-dot ${v === main ? 'on' : ''}" title="${esc(v.angle)}">${ch}</span>`;
    }).join('');
    return `<div class="ref-card pose-group" data-libcard="poseDepth" data-li="${group.idx}">
      <img class="pose-main" src="${esc(main.thumb)}" loading="lazy" decoding="async" alt="${esc(main.id)}">
      <div class="pose-views">${dots}</div>
      <div class="ref-hover">
        <div class="ref-id">${esc(group.code)} · ${esc(group.cls || '')}</div>
        <div class="ref-kw">${esc(group.name || '')} · ${group.views.length} 视角</div>
      </div>
    </div>`;
  }

  function gridHTML(kind) {
    const st = state[kind];
    const list = filtered(kind);
    if (!list.length) {
      return `<div class="empty">${V.icon('search', 40)}<b>没有匹配的图</b><p>换个关键词，或者清掉筛选条件。</p></div>`;
    }
    if (kind === 'poseDepth') {
      const groups = poseGroups();
      const slice = groups.slice(0, st.shown || PAGE);
      return `<div class="ref-grid tall" id="lib-grid">${slice.map(poseCardHTML).join('')}</div>
        <div id="lib-sentinel" style="height:1px"></div>
        <div class="ref-more" id="lib-more">${slice.length < groups.length ? `已显示 ${slice.length} / ${groups.length} 组` : `共 ${groups.length} 组 · ${list.length} 张视角图`}</div>`;
    }
    const slice = list.slice(0, st.shown || PAGE);
    return `<div class="ref-grid" id="lib-grid">${slice.map((it, i) => cardHTML(kind, it, i)).join('')}</div>
      <div id="lib-sentinel" style="height:1px"></div>
      <div class="ref-more" id="lib-more">${slice.length < list.length ? `已显示 ${slice.length} / ${list.length}` : `共 ${list.length} 张`}</div>`;
  }

  function appendGrid(container, kind) {
    const st = state[kind];
    const g = container.querySelector('#lib-grid');
    if (!g) return;
    const from = g.children.length;
    if (kind === 'poseDepth') {
      const groups = poseGroups();
      const next = groups.slice(from, st.shown);
      if (next.length) g.insertAdjacentHTML('beforeend', next.map(poseCardHTML).join(''));
    } else {
      const list = filtered(kind);
      const next = list.slice(from, st.shown);
      if (next.length) g.insertAdjacentHTML('beforeend', next.map((it, i) => cardHTML(kind, it, from + i)).join(''));
    }
    const more = container.querySelector('#lib-more');
    if (more) {
      const total = kind === 'poseDepth' ? poseGroups().length : filtered(kind).length;
      const shown = Math.min(st.shown, total);
      more.textContent = shown < total
        ? (kind === 'poseDepth' ? `已显示 ${shown} / ${total} 组` : `已显示 ${shown} / ${total}`)
        : (kind === 'poseDepth' ? `共 ${total} 组 · ${filtered(kind).length} 张视角图` : `共 ${total} 张`);
    }
    observe(container, kind);
  }

  let io = null;
  function observe(container, kind) {
    const el = container.querySelector('#lib-sentinel');
    if (!el) return;
    if (!io) {
      io = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          const k = e.target.dataset.kind;
          const st = state[k];
          const total = k === 'poseDepth' ? poseGroups().length : filtered(k).length;
          if (st.shown >= total) return;
          st.shown = Math.min(total, (st.shown || PAGE) + PAGE);
          const c = document.querySelector('#view');
          if (c) appendGrid(c, k);
        });
      }, { root: document.querySelector('#view'), rootMargin: '800px' });
    }
    el.dataset.kind = kind;
    io.observe(el);
  }

  function footerHTML(kind) {
    const meta = state[kind].meta;
    const n = meta?.count || 0;
    return `<p class="ref-note">
      共 ${n} 条记录，缩略图已本地化到 <code>reference/${KINDS[kind].dir}/</code>，断网可用。<br>
      ${esc(KINDS[kind].note)}<br>
      本页仅作个人素材参考，图片版权不随本项目的代码许可转让。
    </p>`;
  }

  /* ============================================================
     工具栏绑定 / 重绘
     ============================================================ */
  function bindToolbar(container, kind) {
    const st = state[kind];
    const q = container.querySelector('#lib-q');
    if (q) {
      q.oninput = U.debounce(() => {
        st.q = q.value.trim();
        st.shown = PAGE;
        repaint(container, kind);
      }, 220);
    }
    container.querySelectorAll('[data-libcat]').forEach(b => {
      b.onclick = () => { st.cat = b.dataset.libcat; st.shown = PAGE; repaint(container, kind); };
    });
    container.querySelectorAll('[data-libset]').forEach(b => {
      b.onclick = () => { st.set = b.dataset.libset; st.cat = ''; st.shown = PAGE; repaint(container, kind); };
    });
    container.querySelectorAll('[data-libcls]').forEach(b => {
      b.onclick = () => { st.cls = b.dataset.libcls; st.shown = PAGE; repaint(container, kind); };
    });
    container.querySelectorAll('[data-libangle]').forEach(b => {
      b.onclick = () => { st.angle = b.dataset.libangle; st.shown = PAGE; repaint(container, kind); };
    });
    container.querySelectorAll('[data-libvar]').forEach(b => {
      b.onclick = () => { st.hideVar = !st.hideVar; st.shown = PAGE; repaint(container, kind); };
    });
  }

  function repaint(container, kind) {
    const st = state[kind];
    st.shown = st.shown || PAGE;
    container.innerHTML = toolbarHTML(kind) + gridHTML(kind) + footerHTML(kind);
    bindToolbar(container, kind);
    observe(container, kind);
  }

  /* ============================================================
     高清原图
     ============================================================ */
  const CDN = {
    costume: 'https://cdn.jsdelivr.net/gh/Atom-kkk/AI-Costume-Anime-Resource-Library@main/',
    assembly: 'https://cdn.jsdelivr.net/gh/Atom-kkk/Character-Assembly-Database@main/',
    poseDepth: 'https://cdn.jsdelivr.net/gh/Atom-kkk/AI-Pose-Depth-Resource-Library@main/'
  };
  const PAGES = {
    costume: 'https://atom-kkk.github.io/AI-Costume-Anime-Resource-Library/',
    assembly: 'https://atom-kkk.github.io/Character-Assembly-Database/',
    poseDepth: 'https://atom-kkk.github.io/AI-Pose-Depth-Resource-Library/'
  };
  const RAW = {
    costume: 'https://raw.githubusercontent.com/Atom-kkk/AI-Costume-Anime-Resource-Library/main/',
    assembly: 'https://raw.githubusercontent.com/Atom-kkk/Character-Assembly-Database/main/',
    poseDepth: 'https://raw.githubusercontent.com/Atom-kkk/AI-Pose-Depth-Resource-Library/main/'
  };

  function hiUrls(kind, item, line) {
    const id = item.id;
    if (kind === 'costume') {
      return [
        PAGES.costume + 'img/' + id + '.webp',
        item.original,
        CDN.costume + 'img/' + id + '.webp',
        RAW.costume + 'img/' + id + '.webp'
      ].filter(Boolean);
    }
    if (kind === 'assembly') {
      if (line) {
        return [PAGES.assembly + 'line/' + id + '.png', CDN.assembly + 'line/' + id + '.png', RAW.assembly + 'line/' + id + '.png'];
      }
      return [PAGES.assembly + 'img/' + id + '.webp', CDN.assembly + 'img/' + id + '.webp', RAW.assembly + 'img/' + id + '.webp'];
    }
    return [
      PAGES.poseDepth + 'img/' + id + '.png',
      CDN.poseDepth + 'img/' + id + '.png',
      RAW.poseDepth + 'img/' + id + '.png'
    ];
  }

  function hiKey(kind, item, line) {
    return 'libfull_' + kind + '_' + (line ? 'line_' : '') + item.id;
  }

  async function cacheIndex() {
    const s = await DB.getSettings().catch(() => ({}));
    return Array.isArray(s.libCache) ? s.libCache : [];
  }

  async function touchCache(key) {
    const idx = (await cacheIndex()).filter(x => x.key !== key);
    idx.unshift({ key, at: Date.now() });
    while (idx.length > HI_MAX) {
      const drop = idx.pop();
      await DB.delBlob(drop.key).catch(() => { });
    }
    await DB.setSetting('libCache', idx).catch(() => { });
  }

  async function hiRes(kind, item, line) {
    const key = hiKey(kind, item, line);
    if (hiMem.has(key)) return hiMem.get(key);
    try {
      const blob = await DB.getBlob(key);
      if (blob) {
        const u = URL.createObjectURL(blob);
        hiMem.set(key, u);
        return u;
      }
    } catch { }
    if (isFile()) return '';

    for (const url of hiUrls(kind, item, line)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HI_TIMEOUT);
      try {
        const res = await fetch(url, { mode: 'cors', signal: ctrl.signal });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob.size) continue;
        await DB.putBlob(key, blob, { kind: 'refcache' }).catch(() => { });
        await touchCache(key);
        const u = URL.createObjectURL(blob);
        hiMem.set(key, u);
        return u;
      } catch {
        // 超时 / CORS / 断网，换下一个源
      } finally {
        clearTimeout(timer);
      }
    }
    return '';
  }

  async function clearHiCache() {
    const idx = await cacheIndex();
    for (const x of idx) await DB.delBlob(x.key).catch(() => { });
    await DB.setSetting('libCache', []).catch(() => { });
    hiMem.forEach(u => { try { URL.revokeObjectURL(u); } catch { } });
    hiMem.clear();
    return idx.length;
  }

  /* ============================================================
     组合台 / 提示词
     ============================================================ */
  function composerRole(kind, item) {
    if (kind === 'costume') return 'outfit';
    if (kind === 'poseDepth') return 'pose';
    if (kind === 'assembly') {
      if (item.set === 'outfit') return 'outfit';
      if (item.set === 'pose') return 'pose';
    }
    return '';
  }

  function stagedOf(kind, item) {
    const role = composerRole(kind, item);
    if (!role || !REF || !REF.stage) return false;
    const cur = REF.stage[role];
    return !!cur && cur.lib === kind && cur.id === item.id;
  }

  function addToComposer(kind, item) {
    const role = composerRole(kind, item);
    if (!role) return V.toast('发型条目暂不加入组合台，可复制标签使用', 'err');
    if (!REF || !REF.stage) return V.toast('组合台还没加载完', 'err');
    const staged = role === 'outfit'
      ? {
        id: item.id, thumb: item.thumb, lib: kind, role,
        cat: item.cat || '',
        kw: kind === 'costume' ? (item.kw || '') : (item.tags || item.zh || '')
      }
      : {
        id: item.id, thumb: item.thumb, lib: kind, role,
        name: item.name || item.zh || '',
        angle: item.angle || '正面',
        cat: item.cat || '',
        cls: item.cls || ''
      };
    REF.stage[role] = staged;
    V.renderNav();
    renderLightbox();
    V.toast(`已加入组合台：${role === 'outfit' ? '服装' : '姿势'}`, 'ok');
  }

  function promptText(kind, item) {
    if (kind === 'costume') {
      return `flat lay of clothing only, no person, ${item.kw}, pure white seamless background, soft even lighting, front view, 2:3 vertical, product photography, high detail`;
    }
    if (kind === 'assembly') return item.tags || item.zh || '';
    return `${item.name || ''}, ${item.angle || ''} view, depth map reference`;
  }

  function briefOf(kind, item) {
    if (kind === 'costume') return `这组服装关键词：${item.kw}`;
    if (kind === 'assembly') return `二次元角色素材：${item.zh}（${item.cat}），Danbooru 标签：${item.tags}`;
    return `一个姿势深度参考：${item.name}（${item.cat}，${item.cls}，${item.angle}视角），用于 ControlNet depth`;
  }

  function copyOf(kind, item) {
    if (kind === 'costume') return item.kw || item.kwZh || item.id;
    if (kind === 'assembly') return item.tags || item.zh || item.id;
    return item.name || item.id;
  }

  /* ============================================================
     灯箱
     ============================================================ */
  function currentItem() {
    return filtered(state.lb.kind)[state.lb.index];
  }

  function openLightbox(kind, index) {
    state.lb = { kind, index, open: true, line: false };
    renderLightbox();
    document.querySelector('#lightbox').classList.remove('hidden');
  }

  function close() {
    state.lb.open = false;
    state.lb.line = false;
    document.querySelector('#lightbox').classList.add('hidden');
    document.querySelector('#lightbox').innerHTML = '';
  }

  function step(dir) {
    if (!state.lb.open) return;
    const list = filtered(state.lb.kind);
    if (list.length < 2) return;
    state.lb.index = (state.lb.index + dir + list.length) % list.length;
    state.lb.line = false;
    renderLightbox();
  }

  function renderLightbox() {
    const { kind, index } = state.lb;
    const list = filtered(kind);
    const item = list[index];
    if (!item) return close();

    const lb = document.querySelector('#lightbox');
    const role = composerRole(kind, item);
    const staged = stagedOf(kind, item);
    const isCostume = kind === 'costume';
    const isAssembly = kind === 'assembly';
    const isPoseDepth = kind === 'poseDepth';

    let poseViews = null;
    if (isPoseDepth) {
      const grp = poseGroups().find(g => g.views.some(v => v.id === item.id));
      if (grp && grp.views.length > 1) poseViews = grp.views;
    }

    const badge = isCostume
      ? `${item.id} · ${item.cat}`
      : isAssembly
        ? `${item.id} · ${setLabels[item.set] || ''} · ${item.cat}`
        : `${item.code || item.id} · ${item.cat}`;
    const subBadge = isAssembly ? (item.line ? '线稿可用' : '') : isPoseDepth ? (item.angle || '') : '';

    lb.innerHTML = `
      <div class="lb-stage">
        <div class="lb-topbar">
          <span class="lb-id">${esc(item.id)}</span>
          <span class="badge">${esc(badge)}</span>
          ${subBadge ? `<span class="badge">${esc(subBadge)}</span>` : ''}
          <div class="spacer"></div>
          ${role ? `<button class="icon-btn ${staged ? 'on' : ''}" data-libact="lib-stage" title="${role === 'outfit' ? '用作服装' : '用作姿势'}">${V.icon(role === 'outfit' ? 'shirt' : 'user', 15)}</button>` : ''}
          <button class="icon-btn" data-libact="lib-save" title="存入我的图库">${V.icon('plus', 15)}</button>
          <button class="icon-btn" data-libact="lib-download" title="下载">${V.icon('down', 15)}</button>
          <button class="icon-btn" data-libact="lib-close" title="关闭 (Esc)">${V.icon('close', 15)}</button>
        </div>
        <div class="lb-canvas">
          ${list.length > 1 ? `<button class="lb-nav prev" data-libact="lib-prev">${V.icon('left', 18)}</button>` : ''}
          <img id="lib-big" src="${esc(item.thumb)}" alt="${esc(item.id)}" data-hi="${esc(item.id)}">
          ${list.length > 1 ? `<button class="lb-nav next" data-libact="lib-next">${V.icon('right', 18)}</button>` : ''}
        </div>
        ${isAssembly && item.line ? `<div class="lib-line-toggle">
          <button class="chip ${!state.lb.line ? 'active' : ''}" data-libact="lib-illu">插画</button>
          <button class="chip ${state.lb.line ? 'active' : ''}" data-libact="lib-line">线稿</button>
        </div>` : ''}
        ${poseViews ? `<div class="lb-pose-views">
          ${poseViews.map(v => `<button class="lb-pose-view ${v.id === item.id ? 'on' : ''}" data-libact="lib-poseview" data-view="${esc(v.id)}" title="${esc(v.angle)}">
            <img src="${esc(v.thumb)}" alt="${esc(v.angle)}" loading="lazy"><span>${esc(v.angle)}</span>
          </button>`).join('')}
        </div>` : ''}
        <div class="lb-foot">
          <span id="lib-size">${isCostume ? '2:3 缩略图' : isPoseDepth ? '900×1200 原图' : '1024×1536 原图'}</span>
          <span>${index + 1} / ${list.length}</span>
        </div>
      </div>
      <aside class="lb-panel">
        <div class="lb-panel-head">
          <h3>${isCostume ? '服装关键词' : isPoseDepth ? '姿势档案' : '角色素材'}</h3>
          <div class="spacer"></div>
          <button class="btn sm" data-libact="lib-copy">${V.icon('copy', 13)} 复制</button>
          <button class="btn sm primary" data-libact="lib-write">${V.icon('spark', 13)} AI 写成提示词</button>
        </div>
        <div class="lb-panel-body">
          ${isCostume ? `
            <div class="prompt-current" id="lib-kw">${esc(item.kw || '（无关键词）')}</div>
            ${item.kwZh ? `<div class="ref-desc" style="margin-top:8px">中文：${esc(item.kwZh)}</div>` : ''}
            <div style="display:flex;gap:6px;margin-top:8px">
              <button class="btn sm ghost" data-libact="lib-copy-prompt">${V.icon('copy', 13)} 复制成品提示词</button>
            </div>
            <div class="section">
              <div class="section-title">说明<span></span></div>
              <p class="ref-desc">纯服装参考，不含人物。关键词可直接拼进提示词，也可以让智能体扩写成完整描述。</p>
            </div>
          ` : isPoseDepth ? `
            <dl class="kv">
              <dt>姿势编号</dt><dd>${esc(item.code || '—')}</dd>
              <dt>体系</dt><dd>${esc(item.cat || '—')}</dd>
              <dt>分类</dt><dd>${esc(item.cls || '—')}</dd>
              <dt>视角</dt><dd>${esc(item.angle || '—')}</dd>
              <dt>姿势名</dt><dd>${esc(item.name || '—')}</dd>
            </dl>
            <div class="section">
              <div class="section-title">说明<span></span></div>
              <p class="ref-desc">depth 深度图参考，白色越靠前。用于 ControlNet depth 锁定空间姿态与前后关系，适合图生图与视频动作一致性。</p>
            </div>
          ` : `
            <dl class="kv">
              <dt>中文名</dt><dd>${esc(item.zh || '—')}</dd>
              <dt>日文名</dt><dd>${esc(item.jp || '—')}</dd>
              <dt>分类</dt><dd>${esc(item.cat || '—')}</dd>
              <dt>标签</dt><dd>${esc(item.tags || '—')}</dd>
              <dt>线稿</dt><dd>${item.line ? '有，可切换查看' : '无'}</dd>
            </dl>
            <div class="section">
              <div class="section-title">说明<span></span></div>
              <p class="ref-desc">Danbooru 标签素材。可直接复制标签拼提示词；姿势条目带线稿，可在插画 / 线稿之间切换，用于 ControlNet。</p>
            </div>
          `}
          <div style="display:flex;gap:8px;margin-top:16px">
            ${role ? `<button class="btn" style="flex:1;justify-content:center" data-libact="lib-stage">
              ${V.icon(role === 'outfit' ? 'shirt' : 'user', 14)} ${staged ? '已加入组合台' : (role === 'outfit' ? '用作服装' : '用作姿势')}
            </button>` : ''}
            <button class="btn" style="flex:1;justify-content:center" data-libact="lib-save">
              ${V.icon('plus', 14)} 存入图库
            </button>
          </div>
          <div class="section">
            <div class="section-title">来源<span></span></div>
            <p class="ref-desc">${esc(KINDS[kind].note)}</p>
          </div>
        </div>
      </aside>`;

    if (!isFile()) {
      const requestedId = item.id;
      const useLine = state.lb.line && isAssembly;
      const sizeEl = lb.querySelector('#lib-size');
      const initialLabel = sizeEl?.textContent || '';
      if (sizeEl) sizeEl.textContent = initialLabel + (useLine ? ' · 线稿载入中' : ' · 原图载入中');
      hiRes(kind, item, useLine).then(url => {
        if (!state.lb.open || state.lb.kind !== kind || currentItem()?.id !== requestedId) return;
        const img = lb.querySelector('#lib-big');
        if (!img || img.dataset.hi !== requestedId) return;
        if (url) {
          img.src = url;
          if (sizeEl) sizeEl.textContent = useLine ? '线稿 · 已缓存到本地' : '高清原图 · 已缓存到本地';
        } else if (sizeEl) {
          sizeEl.textContent = initialLabel;
        }
      }).catch(() => { if (sizeEl) sizeEl.textContent = initialLabel; });
    }
  }

  /* ============================================================
     存入图库 / 下载 / AI
     ============================================================ */
  async function saveToVault(kind, item) {
    if (isFile()) {
      return V.toast('file:// 下写不了图片数据，双击 start.command 用本地服务打开后再存', 'err');
    }
    const cat = V.state.categories.find(c => c.name === '参考图') || V.state.categories[0];
    if (!cat) return V.toast('还没有分类', 'err');

    const key = kind + ':' + item.id;
    const existed = V.state.images.find(i => (i.note || '').includes(key));
    if (existed) return V.toast('这张已经在你的图库里了', 'err');

    try {
      await hiRes(kind, item, false);
      const hiBlob = await DB.getBlob(hiKey(kind, item, false)).catch(() => null);
      const blob = hiBlob || await fetch(item.thumb).then(r => r.blob());
      const thumb = await Parse.makeThumb(blob, 640, 0.85);
      const dims = await new Promise(r => {
        const img = new Image();
        img.onload = () => r({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => r({ w: null, h: null });
        img.src = URL.createObjectURL(blob);
      });

      const seq = await DB.nextSeq(cat.id);
      const id = `${cat.prefix || 'REF'}-${U.pad(seq, 4)}`;
      const blobId = U.uid('bl');
      const thumbId = U.uid('th');
      await DB.putBlob(blobId, blob, { kind: 'original' });
      await DB.putBlob(thumbId, thumb, { kind: 'thumb' });

      const now = Date.now();
      const pv = V.newVersion(promptText(kind, item), '', 'import', `参考库 ${key}`);
      const ext = blob.type.includes('png') ? 'png' : blob.type.includes('jpeg') ? 'jpg' : 'webp';

      await DB.put('images', {
        id, categoryId: cat.id, modelId: '',
        blobId, thumbId,
        filename: `${kind}-${item.id}.${ext}`,
        size: blob.size, mime: blob.type,
        width: dims.w, height: dims.h,
        favorite: false,
        tags: [item.id, kind, item.cat, item.cls].filter(Boolean),
        note: `来自参考库 ${key}`,
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

  async function download(kind, item, line) {
    if (isFile()) return V.toast('file:// 下不能下载，右键图片「图片另存为」即可', 'err');
    try {
      await hiRes(kind, item, line);
      let blob = await DB.getBlob(hiKey(kind, item, line)).catch(() => null);
      if (!blob) blob = await fetch(item.thumb).then(r => r.blob());
      const ext = blob.type.includes('png') ? 'png' : blob.type.includes('jpeg') ? 'jpg' : 'webp';
      U.download(`${kind}-${item.id}${line ? '-line' : ''}.${ext}`, blob);
    } catch (e) {
      V.toast('下载失败：' + e.message, 'err');
    }
  }

  function aiWrite(kind, item) {
    const agent = AI.agentById(AI.lastAgentId());
    V.openModal({
      title: '让智能体写成提示词',
      sub: `${agent?.name || '智能体'} · 结果可以复制`,
      wide: true,
      body: `
        <div class="field full" style="margin-bottom:12px">
          <label>素材描述</label>
          <div class="prompt-current" style="max-height:130px">${esc(briefOf(kind, item))}</div>
        </div>
        <div class="field full">
          <label>生成结果</label>
          <div id="lib-ai-out" style="min-height:120px;padding:11px 12px;border:1px solid var(--line-strong);border-radius:9px;background:var(--panel-2);font-family:var(--mono);font-size:12px;line-height:1.65;white-space:pre-wrap;color:var(--text-2)">点右下角「生成」开始</div>
        </div>`,
      footer: `<button class="btn" data-close>取消</button>
               <button class="btn" id="lib-ai-copy" disabled>${V.icon('copy', 13)} 复制</button>
               <button class="btn primary" id="lib-ai-gen">生成</button>`,
      onMount: (el) => {
        const out = el.querySelector('#lib-ai-out');
        const copyBtn = el.querySelector('#lib-ai-copy');
        let text = '';
        el.querySelector('#lib-ai-gen').onclick = async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> 生成中';
          out.textContent = '正在请求模型…';
          try {
            const r = await AI.generate({
              agentId: AI.lastAgentId(),
              mode: kind === 'costume' ? 'expand' : 'refine',
              prompt: kind === 'costume' ? item.kw : briefOf(kind, item)
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
     事件
     ============================================================ */
  document.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-libcard]');
    if (card) {
      openLightbox(card.dataset.libcard, Number(card.dataset.li));
      return;
    }

    const act = e.target.closest('[data-libact]');
    if (!act) return;
    const a = act.dataset.libact;
    const kind = state.lb.kind;
    const item = currentItem();
    if (!item) return;

    if (a === 'lib-close') return close();
    if (a === 'lib-prev') return step(-1);
    if (a === 'lib-next') return step(1);
    if (a === 'lib-line') { state.lb.line = true; return renderLightbox(); }
    if (a === 'lib-illu') { state.lb.line = false; return renderLightbox(); }
    if (a === 'lib-poseview') {
      const li = filtered(kind);
      const gi = li.findIndex(x => x.id === act.dataset.view);
      if (gi >= 0) { state.lb.index = gi; state.lb.line = false; renderLightbox(); }
      return;
    }
    if (a === 'lib-copy') {
      await U.copy(copyOf(kind, item) || '');
      return V.toast('已复制', 'ok');
    }
    if (a === 'lib-copy-prompt') {
      await U.copy(promptText(kind, item) || '');
      return V.toast('成品提示词已复制', 'ok');
    }
    if (a === 'lib-save') return saveToVault(kind, item);
    if (a === 'lib-download') return download(kind, item, state.lb.line);
    if (a === 'lib-write') return aiWrite(kind, item);
    if (a === 'lib-stage') return addToComposer(kind, item);
  });

  /* ============================================================
     视图注册
     ============================================================ */
  function register(kind) {
    V.registerView(kind, {
      title: KINDS[kind].title,
      sub: () => {
        const n = state[kind].items.length;
        if (kind === 'costume') return `${n || 1320} 套动画服装 · 8 个分类 · 纯服装不含人物`;
        if (kind === 'assembly') return `${n || 1027} 张角色素材 · 发型 / 服装 / 姿势 · Danbooru 标签`;
        return `${n || 1439} 张 depth 深度图 · ${state[kind].meta?.groups || 288} 组 / 5 视角 · ControlNet 参考`;
      },
      upload: false,
      actions: () => `<button class="btn" data-act="lib-to-composer">${V.icon('spark', 14)} 去组合提示词</button>
                      <button class="btn" data-act="lib-open-source" data-kind="${kind}">${V.icon('link', 14)} 源站</button>`,
      render: async (c) => {
        try {
          await load(kind);
        } catch (e) {
          c.innerHTML = `<div class="empty">${V.icon('img', 40)}<b>素材库没加载出来</b>
            <p>${esc(e.message)}<br>确认 <code>reference/${KINDS[kind].json}</code> 或 <code>reference/data-extra.js</code> 存在。</p></div>`;
          return;
        }
        state[kind].shown = PAGE;
        repaint(c, kind);
      }
    });
  }

  ['costume', 'assembly', 'poseDepth'].forEach(register);

  V.on('lib-open-source', (el) => {
    const kind = el.dataset.kind;
    if (KINDS[kind]) window.open(KINDS[kind].source, '_blank');
  });
  V.on('lib-to-composer', () => V.go('composer'));

  return {
    preload, counts, items: kind => state[kind]?.items || [],
    isOpen: () => state.lb.open, step, close,
    clearHiCache, stage: state
  };
})();
