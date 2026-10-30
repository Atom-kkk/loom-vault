/* ============================================================
   db.js — 本地数据层（IndexedDB）
   8 张表：images / blobs / models / loras / workflows /
           categories / settings / meta
   ============================================================ */

window.U = (function () {
  const pad = (n, w = 4) => String(n).padStart(w, '0');

  function uid(prefix) {
    return (prefix ? prefix + '_' : '') +
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = Number(bytes);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
    return fmtDate(ts).slice(0, 10);
  }

  function debounce(fn, ms) {
    let t;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms);
    };
  }

  function bytesToHex(buf) {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function sha256(blobOrBuf) {
    const buf = blobOrBuf instanceof Blob ? await blobOrBuf.arrayBuffer() : blobOrBuf;
    if (!crypto?.subtle) return '';
    return bytesToHex(await crypto.subtle.digest('SHA-256', buf));
  }

  function download(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  return { pad, uid, esc, fmtSize, fmtDate, relTime, debounce, sha256, download, copy };
})();


window.DB = (function () {
  const NAME = 'aivault';
  const VERSION = 2;
  const STORES = ['images', 'blobs', 'models', 'loras', 'workflows', 'categories', 'settings', 'meta', 'canvases'];

  let _db = null;
  let _mem = null;              // file:// 降级模式下的只读空库
  let mode = 'idb';

  /* ---------------- 打开数据库 ---------------- */
  function open() {
    if (_db) return Promise.resolve(_db);
    if (_mem) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(NAME, VERSION);
      } catch (e) {
        mode = 'blocked';
        _mem = true;
        reject(e);
        return;
      }

      req.onupgradeneeded = ev => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('images')) {
          const s = db.createObjectStore('images', { keyPath: 'id' });
          s.createIndex('categoryId', 'categoryId');
          s.createIndex('modelId', 'modelId');
          s.createIndex('favorite', 'favorite');
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('models')) {
          const s = db.createObjectStore('models', { keyPath: 'id' });
          s.createIndex('type', 'type');
        }
        if (!db.objectStoreNames.contains('loras')) db.createObjectStore('loras', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('workflows')) db.createObjectStore('workflows', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('categories')) db.createObjectStore('categories', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases', { keyPath: 'id' });
      };

      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => {
        mode = location.protocol === 'file:' ? 'file' : 'blocked';
        _mem = true;
        reject(req.error);
      };
      req.onblocked = () => { mode = 'blocked'; };
    });
  }

  /* ---------------- 基础操作 ---------------- */
  function tx(store, mode2, fn) {
    return new Promise((resolve, reject) => {
      if (!_db) return reject(new Error('数据库未就绪'));
      const t = _db.transaction(store, mode2);
      const s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (e) { return reject(e); }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('事务中断'));
    });
  }

  const getAll = store => tx(store, 'readonly', s => s.getAll());
  const get = (store, key) => tx(store, 'readonly', s => s.get(key));
  const put = (store, obj) => tx(store, 'readwrite', s => s.put(obj));
  const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
  const clear = store => tx(store, 'readwrite', s => s.clear());

  async function bulkPut(store, arr) {
    if (!arr.length) return;
    await tx(store, 'readwrite', s => arr.forEach(o => s.put(o)));
  }

  /* ---------------- 序号 ---------------- */
  async function nextSeq(scopeKey) {
    const key = 'seq:' + scopeKey;
    const cur = await get('meta', key);
    const n = (cur?.value || 0) + 1;
    await put('meta', { key, value: n });
    return n;
  }

  async function peekSeq(scopeKey) {
    const cur = await get('meta', 'seq:' + scopeKey);
    return cur?.value || 0;
  }

  /* ---------------- 设置 ---------------- */
  async function getSettings() {
    const rows = await getAll('settings');
    return rows.reduce((a, r) => (a[r.key] = r.value, a), {});
  }
  async function setSetting(key, value) { return put('settings', { key, value }); }
  async function setSettings(obj) {
    const rows = Object.entries(obj).map(([key, value]) => ({ key, value }));
    return bulkPut('settings', rows);
  }

  /* ---------------- Blob ---------------- */
  async function putBlob(id, blob, meta) {
    return put('blobs', { id, blob, type: blob.type, size: blob.size, ...(meta || {}) });
  }
  async function getBlob(id) {
    const r = await get('blobs', id);
    return r?.blob || null;
  }
  async function delBlob(id) { return del('blobs', id); }

  /* ---------------- 图片 ---------------- */
  async function listImages() {
    const arr = await getAll('images');
    return arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async function saveImage(img) {
    img.updatedAt = Date.now();
    return put('images', img);
  }

  async function deleteImage(id) {
    const img = await get('images', id);
    if (img) {
      if (img.blobId) await delBlob(img.blobId);
      if (img.thumbId) await delBlob(img.thumbId);
    }
    return del('images', id);
  }

  /* ---------------- 体量统计 ---------------- */
  async function usage() {
    try {
      const est = await navigator.storage?.estimate?.();
      if (est && est.usage != null) return { used: est.usage, quota: est.quota };
    } catch { }
    return { used: 0, quota: 0 };
  }

  /* ---------------- 导入 / 导出 ---------------- */
  async function exportMeta() {
    const [images, models, loras, workflows, categories, settings] = await Promise.all([
      getAll('images'), getAll('models'), getAll('loras'),
      getAll('workflows'), getAll('categories'), getAll('settings')
    ]);
    return {
      app: 'ai-image-vault', version: 1,
      exportedAt: new Date().toISOString(),
      counts: { images: images.length, models: models.length, loras: loras.length, workflows: workflows.length },
      data: { images, models, loras, workflows, categories, settings }
    };
  }

  async function importMeta(payload, { replace = false } = {}) {
    const d = payload?.data;
    if (!d) throw new Error('文件格式不正确：缺少 data 字段');
    if (replace) {
      await Promise.all(['images', 'models', 'loras', 'workflows', 'categories'].map(clear));
    }
    const report = { images: 0, models: 0, loras: 0, workflows: 0, categories: 0 };
    if (Array.isArray(d.categories) && d.categories.length) {
      await bulkPut('categories', d.categories); report.categories = d.categories.length;
    }
    if (Array.isArray(d.models) && d.models.length) {
      await bulkPut('models', d.models); report.models = d.models.length;
    }
    if (Array.isArray(d.loras) && d.loras.length) {
      await bulkPut('loras', d.loras); report.loras = d.loras.length;
    }
    if (Array.isArray(d.workflows) && d.workflows.length) {
      await bulkPut('workflows', d.workflows); report.workflows = d.workflows.length;
    }
    if (Array.isArray(d.images) && d.images.length) {
      await bulkPut('images', d.images); report.images = d.images.length;
    }
    if (d.settings) {
      const rows = Object.entries(d.settings).map(([key, value]) => ({ key, value }));
      await bulkPut('settings', rows);
    }
    return report;
  }

  /* ---------------- 初始化默认数据 ---------------- */
  const DEFAULT_CATEGORIES = [
    { name: '未分类', prefix: 'GEN', color: '#a39b91' },
    { name: '人像', prefix: 'POR', color: '#c08a7d' },
    { name: '服装', prefix: 'CLO', color: '#b99455' },
    { name: '场景', prefix: 'SCN', color: '#8a9464' },
    { name: '产品', prefix: 'PRD', color: '#b9775e' },
    { name: '参考图', prefix: 'REF', color: '#8b9aa6' }
  ];

  // 旧版调色板 → 新版（跟随 AI-Clothing-Resource-Library 的冷蓝调）
  const LEGACY_COLORS = {
    // 第一版（紫/青）
    '#7c5cff': '#c08a7d', '#ff7ab6': '#c08a7d', '#22d3ee': '#8b9aa6',
    '#3ddc97': '#8a9464', '#ffb44d': '#b99455', '#9aa6b5': '#a39b91',
    // 第二版（冷蓝）
    '#8fb4ff': '#c08a7d', '#c3d5ff': '#a39b91', '#e3a8c8': '#c08a7d',
    '#7fd4d0': '#8b9aa6', '#8fd6a8': '#8a9464', '#e8c07a': '#b99455',
    '#9aa3b2': '#a39b91', '#b8a3e8': '#9c8aa5'
  };

  async function migrateColors() {
    const cats = await getAll('categories');
    const stale = cats.filter(c => LEGACY_COLORS[c.color]);
    for (const c of stale) {
      c.color = LEGACY_COLORS[c.color];
      await put('categories', c);
    }
    return stale.length;
  }

  async function ensureSeed() {
    await migrateColors();
    const cats = await getAll('categories');
    if (!cats.length) {
      const now = Date.now();
      await bulkPut('categories', DEFAULT_CATEGORIES.map((c, i) => ({
        id: U.uid('cat'), ...c, seq: 0, order: i, createdAt: now
      })));
    }
    const m = await getAll('models');
    if (!m.length) {
      await bulkPut('models', [
        {
          id: U.uid('mdl'), name: 'GPT Image 2.5', type: 'cloud',
          platform: 'OpenAI', base: '', version: '2.5', vendor: 'OpenAI',
          desc: 'OpenAI 图像模型，擅长指令遵循与文字渲染。',
          access: '网页 / API', files: [], loraIds: [], workflowIds: [],
          createdAt: Date.now()
        },
        {
          id: U.uid('mdl'), name: 'krea2', type: 'local',
          platform: 'ComfyUI', base: 'krea2', version: 'v1',
          endpoint: 'http://127.0.0.1:8188',
          installPath: 'ComfyUI/models/checkpoints',
          desc: '本地 ComfyUI 部署的 krea2 基座，配合 LoRA 出图。',
          files: [], loraIds: [], workflowIds: [],
          createdAt: Date.now()
        }
      ]);
    }
  }

  return {
    get mode() { return mode; },
    get ready() { return !!_db; },
    open, ensureSeed, migrateColors,
    getAll, get, put, del, clear, bulkPut,
    nextSeq, peekSeq,
    getSettings, setSetting, setSettings,
    putBlob, getBlob, delBlob,
    listImages, saveImage, deleteImage,
    usage, exportMeta, importMeta,
    DEFAULT_CATEGORIES
  };
})();
