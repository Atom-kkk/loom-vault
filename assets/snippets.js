/* ============================================================
   snippets.js — 提示词片段库
   · 分组管理常用词句（光线 / 镜头 / 画质 / 负面词 …）
   · 支持导入 .md：标题当分组，列表项当片段
   · 组合台与画布可以随时插入
   ============================================================ */

window.SNIP = (function () {
  'use strict';

  const V = window.Vault;
  const esc = U.esc;

  let items = [];
  let ready = false;
  const state = { group: '', q: '' };

  /* ---------------- 内置示例 ---------------- */
  const SEED = [
    ['光线', 'soft window light, diffused, gentle shadows'],
    ['光线', 'golden hour backlight, warm rim light on hair'],
    ['光线', 'cinematic three-point lighting, subtle fill'],
    ['光线', 'neon glow from the side, cool and warm contrast'],
    ['镜头', '85mm lens, f/1.4, shallow depth of field'],
    ['镜头', '35mm lens, environmental portrait, slight wide distortion'],
    ['镜头', 'macro shot, extreme close-up, fine texture'],
    ['构图', 'three-quarter view, rule of thirds, negative space on the right'],
    ['构图', 'full body shot, centered, clean background'],
    ['画质', 'ultra detailed, fine skin texture, subtle film grain'],
    ['画质', 'photorealistic, natural color science, no over-sharpening'],
    ['氛围', 'quiet mood, morning mist, muted palette'],
    ['氛围', 'editorial fashion mood, confident gaze'],
    ['负面词', 'lowres, bad anatomy, extra fingers, watermark, text, jpeg artifacts, blurry']
  ];

  async function ensureSeed() {
    // 只播种一次：用户把示例删光了也不该再冒出来
    const st = await DB.getSettings().catch(() => ({}));
    if (st.snipSeeded) return;
    if (items.length) {
      // 老库已经有片段了，补一个标记就不用再播
      await DB.setSetting('snipSeeded', true).catch(() => { });
      return;
    }
    const now = Date.now();
    const rows = SEED.map(([group, text], i) => ({
      id: U.uid('sp'),
      group,
      text,
      note: '',
      source: 'seed',
      used: 0,
      createdAt: now + i
    }));
    for (const r of rows) await DB.put('snippets', r);
    await DB.setSetting('snipSeeded', true).catch(() => { });
    items = rows;
  }

  async function load() {
    items = (await DB.getAll('snippets')) || [];
    await ensureSeed();
    items.sort((a, b) => (a.group || '').localeCompare(b.group || '', 'zh') || (b.createdAt || 0) - (a.createdAt || 0));
    ready = true;
    return items;
  }

  async function preload() {
    if (ready) return items;
    try { return await load(); } catch { return []; }
  }

  function groups() {
    const m = new Map();
    items.forEach(i => {
      const g = i.group || '未分组';
      m.set(g, (m.get(g) || 0) + 1);
    });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function filtered() {
    const q = state.q.toLowerCase();
    return items.filter(i => {
      if (state.group && (i.group || '未分组') !== state.group) return false;
      if (!q) return true;
      return [i.text, i.group, i.note].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }

  /* ============================================================
     Markdown 解析
     ============================================================ */
  function parseMd(text, listsOnly = true) {
    const out = [];
    let group = '未分组';
    let inCode = false;

    const clean = raw => raw
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^\s*\[[ xX]\]\s*/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const push = (raw, isList) => {
      const t = clean(raw);
      if (!t || t.length > 400) return;
      if (listsOnly && !isList) return;
      out.push({ group, text: t });
    };

    String(text || '').split(/\r?\n/).forEach(line => {
      const l = line.trim();
      if (/^```/.test(l)) { inCode = !inCode; return; }
      if (inCode) return;
      if (!l) return;
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(l)) return;

      const h = l.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        group = clean(h[2]) || group;
        return;
      }
      const isList = /^[-*+]\s+/.test(l) || /^\d+[.)]\s+/.test(l);
      if (isList) return push(l, true);
      if (/^\|/.test(l)) return;                    // 表格跳过
      if (/^>/.test(l)) return;                     // 引用跳过
      push(l, false);
    });

    // 去重 + 去空组
    const seen = new Set();
    return out.filter(x => {
      const k = x.group + '\u0000' + x.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /* ============================================================
     视图
     ============================================================ */
  function rowHTML(s) {
    return `<div class="snip-row" data-snirow="${s.id}">
      <div class="snip-main">
        <div class="snip-text">${esc(s.text)}</div>
        <div class="snip-meta">
          <span class="badge">${esc(s.group || '未分组')}</span>
          ${s.source === 'md' ? '<span class="badge mono">md</span>' : ''}
          ${s.used ? `<span class="snip-used">用过 ${s.used} 次</span>` : ''}
        </div>
      </div>
      <div class="snip-ops">
        <button class="icon-btn" data-act="snip-copy" data-id="${s.id}" title="复制">${V.icon('copy', 14)}</button>
        <button class="icon-btn" data-act="snip-edit" data-id="${s.id}" title="编辑">${V.icon('edit', 14)}</button>
        <button class="icon-btn" data-act="snip-del" data-id="${s.id}" title="删除">${V.icon('trash', 14)}</button>
      </div>
    </div>`;
  }

  function bodyHTML() {
    const gs = groups();
    const list = filtered();
    return `
      <div class="snip-toolbar">
        <div class="search-box">${V.icon('search', 15)}
          <input id="sp-search" type="text" placeholder="搜索片段内容" value="${esc(state.q)}">
        </div>
        <button class="chip ${!state.group ? 'active' : ''}" data-act="snip-group" data-id="">全部 <span class="n">${items.length}</span></button>
        ${gs.map(([g, n]) => `<button class="chip ${state.group === g ? 'active' : ''}" data-act="snip-group" data-id="${esc(g)}">${esc(g)}<span class="n">${n}</span></button>`).join('')}
      </div>
      ${list.length
        ? `<div class="snip-list">${list.map(rowHTML).join('')}</div>`
        : `<div class="empty">${V.icon('spark', 40)}<b>没有匹配的片段</b><p>换个关键词，或者点右上角「导入 Markdown」把整理好的词表搬进来。</p></div>`}`;
  }

  V.registerView('snippets', {
    title: '提示词片段',
    sub: () => `${items.length} 条 · ${groups().length} 个分组 · 点一下即复制`,
    upload: false,
    actions: () => `
      <button class="btn" data-act="snip-import">${V.icon('upload', 14)} 导入 Markdown</button>
      <button class="btn primary" data-act="snip-new">${V.icon('plus', 14)} 新建片段</button>`,
    render: async (c) => {
      if (!ready) await load();
      c.innerHTML = `<div class="snip-wrap">${bodyHTML()}</div>`;
      const s = c.querySelector('#sp-search');
      if (s) {
        s.oninput = U.debounce(() => {
          state.q = s.value.trim();
          const w = c.querySelector('.snip-wrap');
          if (w) w.innerHTML = bodyHTML();
          const s2 = c.querySelector('#sp-search');
          if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); s2.oninput = s.oninput; }
        }, 200);
      }
    }
  });

  /* ============================================================
     增删改
     ============================================================ */
  async function save(s) {
    await DB.put('snippets', s);
    await load();
    V.renderNav();
    V.render();
  }

  function form(s) {
    const isNew = !s;
    s = s || { group: state.group || '', text: '', note: '' };
    const gs = groups().map(([g]) => g);

    V.openModal({
      title: isNew ? '新建片段' : '编辑片段',
      sub: '一段可以直接塞进提示词的话，通常是一组形容词或一个技术参数',
      wide: true,
      body: `
        <div class="form-grid">
          <div class="field"><label>分组</label>
            <input type="text" id="sf-group" value="${esc(s.group || '')}" list="sf-groups" placeholder="光线 / 镜头 / 画质…">
            <datalist id="sf-groups">${gs.map(g => `<option value="${esc(g)}"></option>`).join('')}</datalist>
          </div>
          <div class="field"><label>备注</label>
            <input type="text" id="sf-note" value="${esc(s.note || '')}" placeholder="什么场景用、配哪个模型">
          </div>
          <div class="field full"><label>片段内容 *</label>
            <textarea id="sf-text" style="min-height:120px;font-family:var(--mono);font-size:12.5px" placeholder="soft window light, diffused, gentle shadows">${esc(s.text || '')}</textarea>
            <span class="hint">逗号分隔即可，插入时会自动补逗号</span>
          </div>
        </div>`,
      footer: `<button class="btn" data-close>取消</button>
               <button class="btn primary" id="sf-save">保存</button>`,
      onMount: (box, close) => {
        box.querySelector('#sf-save').onclick = async () => {
          const text = box.querySelector('#sf-text').value.trim();
          if (!text) return V.toast('内容不能为空', 'err');
          await save({
            ...s,
            id: s.id || U.uid('sp'),
            group: box.querySelector('#sf-group').value.trim() || '未分组',
            note: box.querySelector('#sf-note').value.trim(),
            text,
            source: s.source || 'manual',
            used: s.used || 0,
            createdAt: s.createdAt || Date.now()
          });
          close();
          V.toast(isNew ? '片段已添加' : '已保存', 'ok');
        };
        box.querySelector('#sf-text').focus();
      }
    });
  }

  /* ============================================================
     导入 Markdown
     ============================================================ */
  function importMd() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.md,.markdown,.txt,text/markdown,text/plain';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      const raw = await f.text();
      previewMd(raw, f.name);
    };
    inp.click();
  }

  function previewMd(raw, filename) {
    let listsOnly = true;
    let parsed = parseMd(raw, listsOnly);
    if (!parsed.length) { listsOnly = false; parsed = parseMd(raw, false); }

    V.openModal({
      title: '导入 Markdown',
      sub: filename,
      wide: true,
      body: `
        <div class="snip-import-head">
          <label class="chk-inline"><input type="checkbox" id="im-lists" ${listsOnly ? 'checked' : ''}> 只收列表项（关掉会把普通行也收进来）</label>
          <span id="im-count" class="mono" style="font-size:11.5px;color:var(--text-3)"></span>
        </div>
        <div id="im-preview" class="snip-preview"></div>`,
      footer: `<button class="btn" data-close>取消</button>
               <button class="btn primary" id="im-do">导入</button>`,
      onMount: (box, close) => {
        const paint = () => {
          parsed = parseMd(raw, listsOnly);
          const gm = new Map();
          parsed.forEach(p => gm.set(p.group, (gm.get(p.group) || 0) + 1));
          box.querySelector('#im-count').textContent =
            `${parsed.length} 条 · ${gm.size} 个分组`;
          box.querySelector('#im-preview').innerHTML = parsed.length
            ? parsed.slice(0, 60).map(p => `<div class="snip-pv">
                <span class="badge">${esc(p.group)}</span>
                <span class="snip-pv-t">${esc(p.text)}</span>
              </div>`).join('') + (parsed.length > 60 ? `<div class="ref-more">仅预览前 60 条，导入时会全部写入</div>` : '')
            : `<div class="empty" style="padding:30px 0">${V.icon('spark', 32)}<b>没解析出内容</b><p>确认文件里有 <code>## 分组</code> 标题和 <code>- 片段</code> 列表项。</p></div>`;
        };
        box.querySelector('#im-lists').onchange = e => { listsOnly = e.target.checked; paint(); };
        paint();

        box.querySelector('#im-do').onclick = async () => {
          if (!parsed.length) return V.toast('没有可导入的内容', 'err');
          const exist = new Set(items.map(i => (i.group || '') + '\u0000' + i.text.toLowerCase()));
          let added = 0, skipped = 0;
          const now = Date.now();
          for (const p of parsed) {
            const k = p.group + '\u0000' + p.text.toLowerCase();
            if (exist.has(k)) { skipped++; continue; }
            exist.add(k);
            await DB.put('snippets', {
              id: U.uid('sp'), group: p.group, text: p.text, note: '',
              source: 'md', used: 0, createdAt: now + added
            });
            added++;
          }
          close();
          await load();
          V.renderNav();
          V.render();
          V.toast(`导入 ${added} 条${skipped ? `，跳过重复 ${skipped} 条` : ''}`, 'ok');
        };
      }
    });
  }

  /* ============================================================
     选片段（给组合台 / 画布用）
     ============================================================ */
  function openPicker(onPick, title) {
    let group = '';
    let q = '';

    V.openModal({
      title: title || '插入片段',
      sub: '点一条就插入到光标处',
      wide: true,
      body: `<div id="pk-wrap"></div>`,
      footer: `<button class="btn" data-close>关闭</button>`,
      onMount: (box, close) => {
        const wrap = box.querySelector('#pk-wrap');
        const paint = () => {
          const gs = groups();
          const list = items.filter(i => {
            if (group && (i.group || '未分组') !== group) return false;
            if (!q) return true;
            return [i.text, i.group].join(' ').toLowerCase().includes(q.toLowerCase());
          });
          wrap.innerHTML = `
            <div class="snip-toolbar">
              <div class="search-box">${V.icon('search', 15)}
                <input id="pk-q" type="text" placeholder="搜索片段" value="${esc(q)}">
              </div>
              <button class="chip ${!group ? 'active' : ''}" data-pkg="">全部</button>
              ${gs.map(([g, n]) => `<button class="chip ${group === g ? 'active' : ''}" data-pkg="${esc(g)}">${esc(g)}<span class="n">${n}</span></button>`).join('')}
            </div>
            <div class="snip-list" style="max-height:52vh;overflow:auto">
              ${list.length ? list.map(i => `<div class="snip-row pick" data-pick="${i.id}">
                  <div class="snip-main"><div class="snip-text">${esc(i.text)}</div></div>
                  <div class="snip-ops"><span class="badge">${esc(i.group || '')}</span></div>
                </div>`).join('') : `<div class="empty" style="padding:30px 0">${V.icon('search', 28)}<b>没有匹配</b></div>`}
            </div>`;
          wrap.querySelectorAll('[data-pkg]').forEach(b => b.onclick = () => { group = b.dataset.pkg; paint(); });
          const qi = wrap.querySelector('#pk-q');
          qi.oninput = () => { q = qi.value; paint(); };
          wrap.querySelectorAll('[data-pick]').forEach(r => r.onclick = () => {
            const s = items.find(x => x.id === r.dataset.pick);
            if (!s) return;
            onPick(s);
            close();
          });
        };
        paint();
      }
    });
  }

  /** 追加到某个 textarea / 输入框（带去重与逗号处理） */
  function appendTo(el, text) {
    if (!el) return;
    const cur = el.value || '';
    const sep = !cur.trim() ? '' : (/[,\u3001]\s*$/.test(cur) ? ' ' : ', ');
    const next = cur + sep + text;
    el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    el.setSelectionRange(next.length, next.length);
  }

  async function bumpUsed(id) {
    const s = items.find(x => x.id === id);
    if (!s) return;
    s.used = (s.used || 0) + 1;
    await DB.put('snippets', s);
  }

  /* ============================================================
     事件
     ============================================================ */
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-act]');
    if (t) {
      const a = t.dataset.act;
      const id = t.dataset.id;
      if (a === 'snip-new') return form(null);
      if (a === 'snip-import') return importMd();
      if (a === 'snip-group') {
        state.group = id || '';
        V.render();
        return;
      }
      if (a === 'snip-copy') {
        const s = items.find(x => x.id === id);
        if (!s) return;
        await U.copy(s.text);
        await bumpUsed(id);
        V.toast('已复制片段', 'ok');
        return;
      }
      if (a === 'snip-edit') return form(items.find(x => x.id === id));
      if (a === 'snip-del') {
        const s = items.find(x => x.id === id);
        if (!s) return;
        const ok = await V.confirmDialog({
          title: '删除这个片段？',
          message: s.text.slice(0, 60) + (s.text.length > 60 ? '…' : ''),
          danger: true, okText: '删除'
        });
        if (!ok) return;
        await DB.del('snippets', id);
        await load();
        V.renderNav();
        V.render();
        V.toast('已删除', 'ok');
        return;
      }
    }

    const row = e.target.closest('[data-snirow]');
    if (row && !e.target.closest('button')) {
      const s = items.find(x => x.id === row.dataset.snirow);
      if (!s) return;
      await U.copy(s.text);
      await bumpUsed(row.dataset.snirow);
      V.toast('已复制片段', 'ok');
      V.render();
    }
  });

  return {
    preload, load, groups,
    all: () => items,
    count: () => items.length,
    openPicker, appendTo, form, importMd, parseMd
  };
})();
