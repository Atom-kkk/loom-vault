/* ============================================================
   Loom 桌面版 · Electron 主进程
   ------------------------------------------------------------
   干的事很少，但每一件都必须稳：
     1. 找一个空闲端口
     2. 找到本机 Python（3.10+）
     3. 用它跑 serve.py（serve.py 自带静态服务 + 引擎管理）
     4. 等端口通了再 loadURL
     5. 退出时把子进程连同它拉起的 ComfyUI 一起收掉

   为什么不把网页直接打进窗口：serve.py 还要管「安装 ComfyUI / 启动引擎 /
   扫描模型目录」，这些都得有本机进程。前端调的是同源的 /engine/*。
   ============================================================ */

'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const updater = require('./updater');

const IS_WIN = process.platform === 'win32';
const MIN_PY = [3, 10];

let win = null;
let server = null;          // serve.py 子进程
let serverPort = 0;
let quitting = false;

/* ------------------------------------------------------------
   网页资源：开发时用仓库根目录，打包后先从 asar 外复制到用户目录
   （serve.py 要往自己的目录写 .engine.json / .engine.log，
     而 macOS 的 .app 包内是只读的，直接跑会在安装后报权限错）
   ------------------------------------------------------------ */
function webDir() {
  if (!app.isPackaged) return path.join(__dirname, '..');
  return path.join(app.getPath('userData'), 'web');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else {
      // 已经存在的 .engine.json 要留着：那是用户配置的引擎位置
      if (ent.name === '.engine.json' && fs.existsSync(d)) continue;
      fs.copyFileSync(s, d);
    }
  }
}

/** 网页资源指纹：文件数 + 总字节数。staging 有任何变动都会变，防止「版本号没 bump 就用旧前端」 */
function webFingerprint(dir) {
  let n = 0, size = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else { n++; size += fs.statSync(p).size; }
    }
  };
  try { walk(dir); } catch { }
  return `${n}:${size}`;
}

/** 首次启动 / 升级后把网页资源同步到用户目录。返回 web 目录。 */
function prepareWeb() {
  const dst = webDir();
  if (!app.isPackaged) return dst;

  const src = path.join(process.resourcesPath, 'web');
  const stamp = path.join(dst, '.version');
  // 指纹 = 版本号 + 资源内容摘要：改了网页即使没 bump 版本也会刷新
  const want = app.getVersion() + ' · ' + webFingerprint(src);
  let cur = '';
  try { cur = fs.readFileSync(stamp, 'utf8').trim(); } catch { }
  if (cur === want) return dst;

  copyDir(src, dst);
  fs.writeFileSync(stamp, want);
  return dst;
}

/** 把内置 standalone Python 从 resources 复制到 userData（.app 包内只读） */
function prepareRuntime() {
  if (!app.isPackaged) return;
  const src = path.join(process.resourcesPath, 'python');
  const dst = path.join(app.getPath('userData'), 'runtime', 'python');
  if (!fs.existsSync(src)) return;                       // 没打进去就算了（退回系统 Python）
  if (fs.existsSync(dst) && fs.readdirSync(dst).length) return;   // 已经复制过
  copyDir(src, dst);
}

/* ------------------------------------------------------------
   Python 探测
   优先级：① 随 App 打包进去的 standalone Python（无需用户装任何东西）
          ② 系统里用户自己装的 Python 3.10+
   ------------------------------------------------------------ */

/**
 * 内置 Python 的位置。
 * 打包后：extraResources 把 python-build-standalone 解压到 resources/python，
 *         首次启动会连网页资源一起复制到 userData/runtime/python。
 * 开发态：直接指到仓库 desktop/runtime/python。
 */
function bundledPython() {
  const roots = app.isPackaged
    ? [path.join(app.getPath('userData'), 'runtime', 'python'),
       path.join(process.resourcesPath, 'python')]
    : [path.join(__dirname, 'runtime', 'python')];
  for (const r of roots) {
    // mac 的 standalone 发行版是 bin/python3；Windows 版 python.exe 在根目录
    //（我们打包时也挪进 bin/，两种布局都认，谁存在用谁）
    const candidates = IS_WIN
      ? [path.join(r, 'bin', 'python.exe'), path.join(r, 'python.exe')]
      : [path.join(r, 'bin', 'python3')];
    const exe = candidates.find(p => fs.existsSync(p));
    if (exe) return { cmd: exe, args: [], version: '', bundled: true };
  }
  return null;
}

// 系统 Python 候选：先命令名（吃到 PATH 里任何 3.10+），再绝对路径兜底。
// 不要只写死 /usr/bin/python3 —— 那是 macOS 自带的 3.9，会把「有新版但不在
// 默认路径」的用户误判成「没装」。
const PY_CANDIDATES = IS_WIN
  ? [['py', ['-3']], ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']],
     ['python', []], ['python3', []]]
  : [['python3', []], ['python', []],
     '/opt/homebrew/bin/python3', '/usr/local/bin/python3',
     '/opt/homebrew/bin/python', '/usr/local/bin/python',
     '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
     '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3',
     '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3',
     '/usr/bin/python3'];

function pythonVersion(cmd, args) {
  try {
    const r = spawnSync(cmd, [...args, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true
    });
    if (r.error || r.status !== 0) return null;
    const v = String(r.stdout || '').trim();
    return /^\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** 返回 { cmd, args, version, bundled? } 或 null */
function findPython() {
  // ① 内置 standalone Python 优先：双击即用，不依赖用户装任何东西
  const bundled = bundledPython();
  if (bundled) {
    const v = pythonVersion(bundled.cmd, []);
    if (v) return { ...bundled, version: v };
  }

  // ② 退回系统 Python（绝对路径候选展开成 [cmd, []]；命令名保持原样）
  for (const cand of PY_CANDIDATES) {
    const [cmd, args] = Array.isArray(cand) ? cand : [cand, []];
    const v = pythonVersion(cmd, args);
    if (!v) continue;
    const [maj, min] = v.split('.').map(Number);
    const ok = maj > MIN_PY[0] || (maj === MIN_PY[0] && min >= MIN_PY[1]);
    if (ok) return { cmd, args, version: v };
  }
  return null;
}

/* ------------------------------------------------------------
   端口
   ------------------------------------------------------------ */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function waitReady(port, timeoutMs = 25000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, res => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - t0 > timeoutMs) return reject(new Error('本地服务启动超时'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

/* ------------------------------------------------------------
   崩溃残留：上次被强杀时 serve.py 会变成孤儿一直占着端口。
   记一个 pidfile，下次启动先把旧的收掉。
   ------------------------------------------------------------ */
function pidFile() {
  return path.join(app.getPath('userData'), 'server.json');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 这个 pid 到底是不是我们的 serve.py（防 pid 被系统复用后误杀别人） */
function isOurServer(pid) {
  try {
    if (IS_WIN) {
      const r = spawnSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', timeout: 6000, windowsHide: true });
      return /serve\.py/i.test(r.stdout || '');
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', timeout: 4000 });
    return /serve\.py/.test(r.stdout || '');
  } catch {
    return false;
  }
}

function reapStaleServer() {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(pidFile(), 'utf8')); } catch { return; }
  const pid = rec && Number(rec.pid);
  if (!pid || !alive(pid)) return;
  if (!isOurServer(pid)) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch { /* 收不掉就算了 */ }
}

function rememberServer(pid) {
  try { fs.writeFileSync(pidFile(), JSON.stringify({ pid, port: serverPort, at: Date.now() })); } catch { }
}

function forgetServer() {
  try { fs.unlinkSync(pidFile()); } catch { }
}

/* ------------------------------------------------------------
   启动 serve.py
   ------------------------------------------------------------ */
function startServer(dir) {
  const py = findPython();
  if (!py) return Promise.reject(Object.assign(new Error('NO_PYTHON'), { noPython: true }));

  // LOOM_PORT 是给调试 / 内网固定端口用的；正常启动由系统分配
  const want = Number(process.env.LOOM_PORT || 0);
  return (want > 0 ? Promise.resolve(want) : freePort()).then(port => {
    serverPort = port;
    const args = [...py.args, 'serve.py', String(port), '--no-open'];
    reapStaleServer();
    server = spawn(py.cmd, args, {
      cwd: dir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        // Windows 上 Python 默认按 GBK 往管道写，serve.py 里有大量中文日志，
        // 会抛 UnicodeEncodeError: 'gbk' codec can't encode character 并直接退出。
        // 强制 UTF-8，Node 这边也正好按 UTF-8 解码。
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !IS_WIN            // 非 Windows 建独立进程组，退出时整组收掉
    });

    let log = '';
    const keep = chunk => { log = (log + chunk).slice(-4000); };
    server.stdout.on('data', keep);
    server.stderr.on('data', keep);

    const exited = new Promise((_, rej) => {
      server.on('exit', code => {
        if (!quitting) {
          const err = new Error('本地服务意外退出（exit ' + code + '）\n' + log.slice(-1200));
          err.log = log;
          rej(err);
        }
      });
    });

    rememberServer(server.pid);

    return Promise.race([waitReady(port).then(() => log), exited]).then(() => port);
  });
}

function stopServer() {
  if (!server || server.killed) return;
  try {
    if (IS_WIN) {
      // Windows 上 kill 只杀 serve.py，它拉起的 ComfyUI 会留在后台
      spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-server.pid, 'SIGTERM');
    }
  } catch { /* 已经退了 */ }
  server = null;
  forgetServer();
}

/* ------------------------------------------------------------
   界面
   ------------------------------------------------------------ */
function errorPage(title, detail, extra = '') {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #f6f3ee; color: #1d1b19;
      font: 14px/1.75 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .box { max-width: 560px; padding: 34px 38px; }
    h1 { font-size: 18px; margin: 0 0 10px; font-weight: 600; }
    p  { margin: 0 0 12px; color: #4a4642; }
    pre {
      background: #fffdf9; border: 1px solid #e3ddd4; border-radius: 10px;
      padding: 12px 14px; font-size: 11.5px; line-height: 1.6;
      white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto;
      color: #6b645c;
    }
    .dot { width: 34px; height: 34px; border-radius: 10px; background: #1d1b19;
      display: grid; place-items: center; margin-bottom: 16px; }
    .dot i { width: 13px; height: 13px; border: 1.8px solid #fff; border-radius: 3px; }
    a { color: #a8655a; }
  </style>
  <div class="box">
    <div class="dot"><i></i></div>
    <h1>${title}</h1>
    ${extra}
  </div></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#f6f3ee',
    title: 'Loom 织造所',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(url);

  // 站内的外链一律交给系统浏览器，别在窗口里跳走
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith('http://127.0.0.1:')) {
      e.preventDefault();
      shell.openExternal(target);
    }
  });

  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tpl = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 Loom' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Loom' },
        { role: 'hideOthers', label: '隐藏其它' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Loom' }
      ]
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新…', click: () => updateFlow(false) },
        { type: 'separator' },
        { label: '项目主页', click: () => shell.openExternal('https://github.com/Atom-kkk/loom-vault') },
        { label: '在线体验', click: () => shell.openExternal('https://atom-kkk.github.io/loom-vault/') },
        { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

/* ------------------------------------------------------------
   启动流程
   ------------------------------------------------------------ */
async function boot() {
  let dir;
  try {
    dir = prepareWeb();
    prepareRuntime();   // 内置 Python 复制到 userData（.app 包内只读）
  } catch (e) {
    return createWindow(errorPage('资源没有解压成功',
      '', `<p>${e.message}</p>`));
  }

  try {
    const port = await startServer(dir);
    createWindow('http://127.0.0.1:' + port + '/');
  } catch (e) {
    if (e.noPython) {
      const dl = IS_WIN ? 'https://www.python.org/downloads/windows/' : 'https://www.python.org/downloads/macos/';
      createWindow(errorPage('这台电脑上没找到 Python 3.10+',
        '',
        `<p>Loom 的引擎管理和文件扫描由一个小型本地服务负责，它需要 Python 3.10 或更新版本。
          装一次就行，装完重新打开 Loom。</p>
         <p>安装时${IS_WIN ? '务必勾选 <b>Add Python to PATH</b>，' : ''}装完可以关掉安装器。</p>
         <p><a href="${dl}" target="_blank">${dl}</a></p>
         <p style="color:#8a8279;font-size:12px">已经装了但还是报这个错？可能是版本太旧（macOS 自带的 3.9 就不够），
         用 <code>python3 --version</code> 确认一下。</p>`));
      shell.openExternal(dl);
    } else {
      createWindow(errorPage('本地服务没起来', '', `<p>${e.message.split('\n')[0]}</p>
        <pre>${(e.log || e.message || '').slice(-1200)}</pre>
        <p style="font-size:12px;color:#8a8279">可以试试：菜单「视图 → 重新载入」，或退出重开。
        仍然不行就把上面这段贴到 GitHub issue 里。</p>`));
    }
  }
}

/* ------------------------------------------------------------
   内置更新：检查 → 询问 → 下载（任务栏进度）→ 引导安装
   ------------------------------------------------------------ */
let updateBusy = false;

async function updateFlow(silent) {
  if (updateBusy) return;
  updateBusy = true;
  const win0 = win;
  try {
    const r = await updater.checkForUpdate();
    rememberCheck();
    if (!r.hasUpdate) {
      if (!silent) dialog.showMessageBox(win0, {
        type: 'info', title: '检查更新',
        message: `已经是最新版本（v${r.current}）`
      });
      return;
    }
    const act = (await dialog.showMessageBox(win0, {
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 v${r.latest}（当前 v${r.current}）`,
      detail: '更新包在 GitHub Releases 上，大小约 170–210 MB。\n下载完成后会自动打开安装器。',
      buttons: ['立即下载', '查看发布页', '以后再说'],
      defaultId: 0, cancelId: 2, noLink: true
    })).response;
    if (act === 1) { shell.openExternal(r.page); return; }
    if (act !== 0) return;

    const target = win0 || win;
    const file = await updater.downloadUpdate(r.latest, (p) => {
      if (target && !target.isDestroyed()) target.setProgressBar(p);
    });
    if (target && !target.isDestroyed()) target.setProgressBar(-1);
    const open = (await dialog.showMessageBox(target, {
      type: 'info', title: '下载完成',
      message: `v${r.latest} 已下载完成`,
      detail: file,
      buttons: ['立即安装', '稍后自己打开'], defaultId: 0, cancelId: 1, noLink: true
    })).response;
    if (open === 0) updater.openUpdate(file);
  } catch (e) {
    rememberCheck();   // 失败也算查过，别每次启动都重试轰炸网络
    if (!silent) dialog.showMessageBox(win0, {
      type: 'warning', title: '检查更新失败',
      message: '连不上 GitHub（可能需要代理）',
      detail: String(e.message || e).slice(0, 300)
    });
  } finally {
    updateBusy = false;
  }
}

/** 每天最多自动静默检查一次（手动的「检查更新…」不受限） */
function checkFile() { return path.join(app.getPath('userData'), 'update-check.json'); }
function rememberCheck() {
  try { fs.writeFileSync(checkFile(), JSON.stringify({ at: Date.now() })); } catch { }
}
function shouldAutoCheck() {
  try {
    const j = JSON.parse(fs.readFileSync(checkFile(), 'utf8'));
    return Date.now() - (j.at || 0) > 24 * 3600 * 1000;
  } catch { return true; }
}

/* ------------------------------------------------------------
   单实例 / 生命周期
   ------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    buildMenu();
    boot();
    // 启动后 5 秒静默检查更新（每天最多一次，失败不打扰）
    setTimeout(() => { if (shouldAutoCheck()) updateFlow(true); }, 5000);
  });

  app.on('window-all-closed', () => {
    quitting = true;
    stopServer();
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopServer();
  });

  // 崩溃 / 强退也要收掉子进程，否则 ComfyUI 会一直占着显存
  process.on('exit', stopServer);
  process.on('SIGINT', () => { quitting = true; stopServer(); app.quit(); });
  process.on('SIGTERM', () => { quitting = true; stopServer(); app.quit(); });
}
