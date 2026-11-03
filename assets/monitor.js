/* ============================================================
   monitor.js — 资源监控
   · 顶栏常驻徽章：运行中 / 排队 / 显存占用
   · 展开面板：队列、显卡负载与显存、内存与 CPU、版本、进程占用
   · 卸载模型并释放显存
   数据来源分三路：
     /engine/sys      → CPU、引擎进程内存/运行时长、NVIDIA 利用率（serve.py 补的）
     /system_stats    → 显存、RAM、ComfyUI / PyTorch 版本（ComfyUI 自己最准）
     /queue           → 运行中 / 排队中任务数
   面板关闭时降频到 8 秒，页面切到后台直接停 —— 别让监控本身占资源。
   ============================================================ */

window.SYS = (function () {
  'use strict';

  const POLL_OPEN = 1500;
  const POLL_IDLE = 8000;

  let badge = null;
  let panel = null;
  let open = false;
  let timer = 0;
  let inflight = false;
  let last = null;
  let taskTrack = { id: '', t0: 0 };   // 面板里「本次任务」的观察起点

  /* ---------------- 小工具 ---------------- */
  const pct = (used, total) => {
    const t = Number(total) || 0;
    if (!t) return null;
    return Math.max(0, Math.min(100, Math.round((Number(used) || 0) / t * 100)));
  };

  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

  /* ---------------- 取数 ---------------- */
  async function collect() {
    const C = window.Comfy;
    if (!C) return null;

    const [sysR, statsR, qR] = await Promise.allSettled([
      C.engineSys(), C.ping(), C.queueInfo()
    ]);

    const sys = (sysR.status === 'fulfilled' && sysR.value && !sysR.value.error) ? sysR.value : null;
    const stats = statsR.status === 'fulfilled' ? statsR.value : null;
    const q = qR.status === 'fulfilled' ? qR.value : null;

    const out = {
      at: Date.now(),
      sys: sys,
      stats: stats,
      online: !!(stats && stats.system),
      running: 0, pending: 0, runningId: '',
      gpu: null, ram: null, cpu: null, proc: null,
      version: { comfy: '', torch: '' },
      taskSec: null, refSec: null
    };

    /* --- 队列 --- */
    if (q) {
      const run = Array.isArray(q.queue_running) ? q.queue_running : [];
      const pend = Array.isArray(q.queue_pending) ? q.queue_pending : [];
      out.running = run.length;
      out.pending = pend.length;
      if (run[0] && Array.isArray(run[0])) out.runningId = String(run[0][1] || '');
    }

    /* --- 显卡 / 显存 --- */
    if (stats && Array.isArray(stats.devices) && stats.devices.length) {
      const d = stats.devices[0] || {};
      // Apple MPS 的 vram_* 常年为 0，torch_vram_* 才是真的；再不行就退回统一内存
      let total = num(d.vram_total) || 0;
      let used = total ? total - (num(d.vram_free) || 0) : 0;
      if (!total) {
        const tt = num(d.torch_vram_total) || 0;
        if (tt) { total = tt; used = tt - (num(d.torch_vram_free) || 0); }
      }
      out.gpu = {
        name: String(d.name || d.type || '显卡'),
        type: String(d.type || ''),
        total: total, used: used,
        util: sys && sys.gpu ? num(sys.gpu.util) : null
      };
    }

    /* --- 内存 --- */
    if (stats && stats.system) {
      const total = num(stats.system.ram_total) || 0;
      const free = num(stats.system.ram_free) || 0;
      if (total) out.ram = { total: total, used: Math.max(0, total - free) };
      out.version.comfy = String(stats.system.comfyui_version || '');
      out.version.torch = String(stats.system.pytorch_version || '');
    }

    /* --- CPU / 进程 --- */
    if (sys) {
      if (sys.cpu) out.cpu = { pct: num(sys.cpu.pct), cores: num(sys.cpu.cores) || 0 };
      if (sys.proc) out.proc = { rss: num(sys.proc.rss), uptime: num(sys.proc.uptime) };
    }

    /* --- 本任务的「已用时间」 --- */
    if (out.runningId) {
      if (taskTrack.id !== out.runningId) taskTrack = { id: out.runningId, t0: Date.now() };
      out.taskSec = (Date.now() - taskTrack.t0) / 1000;
    } else {
      taskTrack = { id: '', t0: 0 };
    }
    // 历史耗时只能当参考：面板不知道这个任务属于哪套工作流
    out.refSec = window.Comfy && Comfy.durLast ? Comfy.durLast() : null;

    return out;
  }

  /* ---------------- 徽章 ---------------- */
  function badgeText(d) {
    if (!d) return '引擎 —';
    if (!d.online && !(d.sys && d.sys.running)) return '引擎未启动';
    if (!d.online) return '引擎启动中…';

    // 显存比内存更能反映「现在跑得动不动」，优先显示它
    const mem = d.gpu ? pct(d.gpu.used, d.gpu.total) : null;
    const memTxt = mem != null
      ? `显存 ${mem}%`
      : (d.ram ? `内存 ${pct(d.ram.used, d.ram.total)}%` : '');

    if (!d.running && !d.pending) return ['空闲', memTxt].filter(Boolean).join(' · ');
    const queueTxt = d.pending ? `运行中 ${d.running}（排队 ${d.pending}）` : `运行中 ${d.running}`;
    return [queueTxt, memTxt].filter(Boolean).join(' · ');
  }

  function renderBadge(d) {
    if (!badge) return;
    const span = badge.querySelector('.sys-badge-text');
    const txt = badgeText(d);
    if (span && span.textContent !== txt) span.textContent = txt;
    badge.classList.toggle('on', !!(d && d.online));
    badge.classList.toggle('busy', !!(d && d.running));
    badge.title = d && d.online ? '点开看资源占用' : '本地引擎没在跑，点开可启动';
  }

  /* ---------------- 面板 ---------------- */
  function buildPanel() {
    const el = document.createElement('div');
    el.className = 'sys-panel';
    el.id = 'sys-panel';
    el.hidden = true;
    el.innerHTML = `
      <div class="sys-head">
        <span class="sys-dot" data-sys-dot></span>
        <b>系统内置 ComfyUI</b>
        <span class="sys-state" data-sys="state">未连接</span>
        <button class="sys-ico" data-sys="refresh" title="立即刷新">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>
        </button>
      </div>

      <div class="sys-card">
        <div class="sys-card-title">
          <span>任务队列</span>
          <span class="sys-tag" data-sys="qtag">空闲</span>
        </div>
        <div class="sys-grid2">
          <div class="sys-kv"><span>运行中任务</span><b data-sys="qrun">0</b></div>
          <div class="sys-kv"><span>排队中任务</span><b data-sys="qpend">0</b></div>
        </div>
        <div class="sys-sub" data-sys="task">当前没有任务在跑</div>
      </div>

      <div class="sys-card">
        <div class="sys-card-title sys-card-title-gpu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h4M14 14h4"/></svg>
          <span data-sys="gpuname">显卡</span>
          <span class="sys-side" data-sys="gpuutil">负载 —</span>
        </div>
        <div class="sys-row"><span>显存占用</span><b data-sys="gpupct">—</b></div>
        <div class="sys-bar" data-sys="gpubarwrap"><i data-sys="gpubar"></i></div>
        <div class="sys-sub" data-sys="gpumem">—</div>
      </div>

      <div class="sys-card">
        <div class="sys-card-title">
          <span>系统内存 (RAM)</span>
          <span class="sys-side" data-sys="cpu">CPU —</span>
        </div>
        <div class="sys-row"><span>内存占用</span><b data-sys="rampct">—</b></div>
        <div class="sys-bar" data-sys="rambarwrap"><i data-sys="rambar"></i></div>
        <div class="sys-sub" data-sys="rammem">—</div>
      </div>

      <div class="sys-card flat">
        <div class="sys-kv"><span>ComfyUI 版本</span><b data-sys="vercomfy">—</b></div>
        <div class="sys-kv"><span>PyTorch 版本</span><b data-sys="vertorch">—</b></div>
        <div class="sys-kv"><span>进程占用 / 运行</span><b data-sys="proc">—</b></div>
      </div>

      <button class="sys-free" data-sys="free">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v10"/><path d="M8 7l4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
        <span>卸载模型并释放显存</span>
      </button>`;
    document.body.appendChild(el);
    return el;
  }

  function q(sel) { return panel ? panel.querySelector(sel) : null; }

  function setKv(sel, text) {
    const el = q(sel);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function renderPanel(d) {
    if (!panel) return;

    /* 头部 */
    const dot = q('[data-sys-dot]');
    if (dot) {
      dot.classList.toggle('on', !!(d && d.online));
      dot.classList.toggle('warn', !!(d && d.sys && d.sys.running && !d.online));
    }
    setKv('[data-sys="state"]', !d ? '读不到状态'
      : d.online ? '在线'
        : (d.sys && d.sys.running) ? '启动中' : '未连接');

    /* 队列 */
    setKv('[data-sys="qrun"]', String(d ? d.running : 0));
    setKv('[data-sys="qpend"]', String(d ? d.pending : 0));
    const tag = q('[data-sys="qtag"]');
    if (tag) {
      const busy = d && d.running;
      tag.textContent = busy ? '运行中' : (d && d.pending ? '排队中' : '空闲');
      tag.classList.toggle('on', !!busy);
    }
    const task = q('[data-sys="task"]');
    if (task) {
      let s;
      if (!d || !d.online) s = '引擎没在跑，去「设置 → ComfyUI」启动';
      else if (d.runningId) {
        s = '已用 ' + Comfy.fmtClock(d.taskSec || 0);
        if (d.refSec) s += ' · 同类历史约 ' + Comfy.fmtLoose(d.refSec);
        else if (d.pending) s += ' · 还有 ' + d.pending + ' 个在排队';
      } else if (d.pending) s = d.pending + ' 个任务在排队，等引擎取';
      else s = '空闲中';
      if (task.textContent !== s) task.textContent = s;
    }

    /* 显卡 */
    setKv('[data-sys="gpuname"]', d && d.gpu ? d.gpu.name : '显卡');
    const util = d && d.gpu && d.gpu.util != null ? d.gpu.util : null;
    setKv('[data-sys="gpuutil"]', util != null ? '负载 ' + Math.round(util) + '%' : '负载 —');

    const gp = d && d.gpu ? pct(d.gpu.used, d.gpu.total) : null;
    setKv('[data-sys="gpupct"]', gp != null ? gp + '%' : '—');
    setBarEl('[data-sys="gpubarwrap"]', '[data-sys="gpubar"]', gp);
    setKv('[data-sys="gpumem"]', d && d.gpu && d.gpu.total
      ? Comfy.fmtBytes(d.gpu.used) + ' / ' + Comfy.fmtBytes(d.gpu.total)
      : (d && d.online ? '这块显卡不报显存（统一内存架构）' : '—'));

    /* 内存 / CPU */
    const rp = d && d.ram ? pct(d.ram.used, d.ram.total) : null;
    setKv('[data-sys="rampct"]', rp != null ? rp + '%' : '—');
    setBarEl('[data-sys="rambarwrap"]', '[data-sys="rambar"]', rp);
    setKv('[data-sys="rammem"]', d && d.ram
      ? Comfy.fmtBytes(d.ram.used) + ' / ' + Comfy.fmtBytes(d.ram.total) : '—');

    const cpuPct = d && d.cpu ? d.cpu.pct : null;
    const cores = d && d.cpu ? d.cpu.cores : 0;
    setKv('[data-sys="cpu"]', cpuPct != null
      ? `CPU ${cpuPct}%${cores ? '（' + cores + ' 核）' : ''}`
      : `CPU —${cores ? '（' + cores + ' 核）' : ''}`);

    /* 版本 / 进程 */
    setKv('[data-sys="vercomfy"]', (d && d.version.comfy) || '—');
    setKv('[data-sys="vertorch"]', (d && d.version.torch) || '—');
    let proc = '—';
    if (d && d.proc && (d.proc.rss || d.proc.uptime)) {
      const bits = [];
      if (d.proc.rss) bits.push(Comfy.fmtBytes(d.proc.rss));
      if (d.proc.uptime) bits.push(Comfy.fmtLoose(d.proc.uptime));
      proc = bits.join(' · ');
    }
    setKv('[data-sys="proc"]', proc);

    const freeBtn = q('[data-sys="free"]');
    if (freeBtn) freeBtn.disabled = !(d && d.online);
  }

  function setBarEl(wrapSel, barSel, p) {
    const wrap = q(wrapSel), bar = q(barSel);
    if (bar) bar.style.width = (p == null ? 0 : Math.max(2, Math.min(100, p))) + '%';
    if (wrap) {
      const v = p == null ? 0 : p;
      wrap.classList.toggle('hot', v >= 80 && v < 92);
      wrap.classList.toggle('crit', v >= 92);
    }
  }

  /* ---------------- 轮询 ---------------- */
  async function tick(force = false) {
    if (inflight) return;
    if (document.hidden && !force) { schedule(); return; }
    inflight = true;
    try {
      const d = await collect();
      if (d) { last = d; renderBadge(d); if (open) renderPanel(d); }
    } catch {
      /* 引擎没起来是常态，别刷屏报错 */
    } finally {
      inflight = false;
      schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => tick(), open ? POLL_OPEN : POLL_IDLE);
  }

  /* ---------------- 开关 ---------------- */
  /** 贴着顶栏下沿、右对齐顶栏按钮：顶栏高度随视图标题换行会变，写死 top 会压住它 */
  function place() {
    if (!panel) return;
    if (innerWidth <= 640) { panel.style.top = ''; panel.style.right = ''; return; }
    const bar = document.querySelector('#topbar');
    const acts = document.querySelector('#topbar-actions');
    const b = bar ? bar.getBoundingClientRect() : null;
    panel.style.top = Math.round((b ? b.bottom : 64) + 8) + 'px';
    if (acts) {
      const a = acts.getBoundingClientRect();
      panel.style.right = Math.max(10, Math.round(innerWidth - a.right)) + 'px';
    } else {
      panel.style.right = '';
    }
  }

  function toggle(force) {
    const want = force == null ? !open : !!force;
    if (want === open) return;
    open = want;
    if (!panel) panel = buildPanel();
    panel.hidden = !open;
    badge && badge.classList.toggle('active', open);
    if (open) {
      place();
      if (last) renderPanel(last);
      tick(true);
      schedule();
    } else {
      schedule();
    }
  }

  /* ---------------- 事件 ---------------- */
  function bindPanel() {
    if (!panel || panel.dataset.bound) return;
    panel.dataset.bound = '1';
    panel.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-sys]');
      if (!btn) return;
      const act = btn.dataset.sys;

      if (act === 'refresh') {
        tick(true);
        return;
      }

      if (act === 'free') {
        if (btn.disabled) return;
        const label = btn.querySelector('span') || btn;
        const old = label.textContent;
        btn.disabled = true;
        label.textContent = '正在释放…';
        try {
          await Comfy.freeMemory(true);
          label.textContent = '已释放';
          setTimeout(() => { label.textContent = old; btn.disabled = false; }, 1400);
          setTimeout(() => tick(true), 800);
        } catch (err) {
          label.textContent = '释放失败';
          window.Vault && Vault.toast && Vault.toast('释放显存失败：' + (err.message || err), 'err');
          setTimeout(() => { label.textContent = old; btn.disabled = false; }, 1800);
        }
      }
    });
  }

  function bindOutside() {
    document.addEventListener('pointerdown', (e) => {
      if (!open) return;
      if (panel && panel.contains(e.target)) return;
      if (badge && badge.contains(e.target)) return;
      toggle(false);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && open) toggle(false);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tick(true);
    });
    addEventListener('resize', () => { if (open) place(); });
  }

  /* ---------------- 对外 ---------------- */
  function mountBadge() {
    const host = document.querySelector('#topbar-actions');
    if (!host) return;
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.id = 'sys-badge';
      badge.className = 'sys-badge';
      badge.innerHTML = '<i class="dot"></i><span class="sys-badge-text">引擎 —</span>';
      badge.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
      bindOutside();
    }
    if (badge.parentNode !== host) host.appendChild(badge);
    renderBadge(last);
    return badge;
  }

  function init() {
    if (!panel) { panel = buildPanel(); bindPanel(); }
    mountBadge();
    tick(true);          // 别等第一个 8 秒周期：徽章一进来就该是对的
  }

  return { init, mountBadge, toggle, refresh: () => tick(true), state: () => last };
})();
