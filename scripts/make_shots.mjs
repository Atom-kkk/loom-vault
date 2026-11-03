/* ============================================================
   scripts/make_shots.mjs — 生成文档用的界面截图
   ------------------------------------------------------------
   为什么是 Node 而不是 Python：项目零依赖，但截图需要真实渲染，
   而 Node 18+ 自带 fetch / WebSocket，能直接驱动 Chrome DevTools 协议，
   不用装 playwright / puppeteer。

   用法：
     python3 serve.py 8811 --no-open        # 另开一个终端把站起在 8811
     node scripts/make_shots.mjs            # 输出到 docs/screenshots/

   依赖：本机有 Google Chrome（macOS 路径写死，其它平台改 CHROME 常量）。
   脚本会用一个独立的临时 profile，不会碰你自己的浏览器数据。
   ============================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const SITE = process.env.SHOT_URL || 'http://127.0.0.1:8811/';
const PORT = Number(process.env.CDP_PORT || 9400);
const SCALE = Number(process.env.SHOT_SCALE || 1.5);
const VW = 1440, VH = 900;

// 参考图库一页 120 张、滚动自动加载，连截三张会把内存吃干净。
// 用 SHOTS 分批跑：SHOTS=ref 只跑名字里带 ref 的那几张。
const ONLY = (process.env.SHOTS || '').split(',').map(s => s.trim()).filter(Boolean);
const want = name => !ONLY.length || ONLY.some(k => name.includes(k));

const CHROME = process.env.CHROME_PATH || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  linux: '/usr/bin/google-chrome'
}[process.platform];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- CDP 最小客户端 ---------------- */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const errors = [];

    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { ok, no } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? no(new Error(JSON.stringify(m.error))) : ok(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(String(m.params.exceptionDetails.exception?.description
          || m.params.exceptionDetails.text).slice(0, 240));
      }
    };

    ws.onopen = () => resolve({
      errors,
      send: (method, params = {}) => new Promise((ok, no) => {
        const mid = ++id;
        pending.set(mid, { ok, no });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
      close: () => ws.close()
    });
    ws.onerror = reject;
  });
}

async function waitForTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { }
    await sleep(200);
  }
  throw new Error('Chrome 没起来（CDP 端口 ' + PORT + ' 无响应）');
}

/* ---------------- 主流程 ---------------- */
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--mute-audio', '--no-first-run', '--no-default-browser-check',
  `--window-size=${VW},${VH}`,
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/loom-shots-profile',
  'about:blank'
], { stdio: 'ignore' });

fs.mkdirSync(OUT, { recursive: true });

const cdp = await connect(await waitForTarget());
const { send } = cdp;

const ev = async expr => {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  }
  return r.result.value;
};

let shotCount = 0;
async function shot(name, note) {
  if (!want(name)) return;
  await sleep(260);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  shotCount++;
  console.log(`  ✓ ${name}.png${note ? '  — ' + note : ''}`);
}

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: SCALE, mobile: false
  });

  await send('Page.navigate', { url: SITE });
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const n = await ev(`document.querySelectorAll('#nav .nav-item').length`).catch(() => 0);
    if (n > 0) break;
  }
  await ev(`localStorage.setItem('vault.theme','light'); document.documentElement.dataset.theme='light'`);

  /* ---- 库里没图才走「空库 → 导入」这一段（复用 profile 跑第二批时会跳过） ---- */
  const existing = await ev(`Vault.state.images.length`);
  if (!existing) {
    await ev(`(async()=>{ await Vault.go('gallery'); return 1 })()`);
    await sleep(900);
    await shot('01-gallery-empty', '第一次打开：空图库');

    const picked = await ev(`(async () => {
      const names = ['portrait_a1111.png','garden_comfy.png','abstract_plain.png'];
      const files = [];
      for (const n of names) {
        const r = await fetch('/demo/' + n);
        const b = await r.blob();
        files.push(new File([b], n, { type: 'image/png' }));
      }
      Vault.handleFiles(files);
      return files.length;
    })()`);
    await sleep(1800);
    await shot('02-upload-modal', '导入确认弹窗：PNG 里的生成参数已自动读出来');
    await ev(`document.querySelector('#up-do')?.click()`);
    await sleep(2600);
    await ev(`(async()=>{ await Vault.reload(); await Vault.go('gallery'); return Vault.state.images.length })()`);
    await sleep(1400);
    console.log('导入 demo 图：', picked, '张');
  } else {
    await ev(`(async()=>{ await Vault.reload(); await Vault.go('gallery'); return 1 })()`);
    await sleep(1200);
  }

  /* ============ 图库 ============ */
  await shot('03-gallery', '图库：缩略图墙 + 侧栏导航');

  // 灯箱：点第一张
  await ev(`document.querySelector('.card[data-open]').click()`);
  await sleep(1400);
  await shot('04-lightbox', '点开一张图：大图 + 右侧参数面板');
  await ev(`document.querySelector('#lightbox').classList.add('hidden')`);
  await sleep(300);

  /* ============ 画布 ============ */
  await ev(`(async()=>{ await Vault.go('canvas'); return 1 })()`);
  await sleep(1200);
  await shot('05-canvas-empty', '空画布：工具条、小地图、提示条');

  // 用内置工作流铺一套三件套
  await ev(`(async () => {
    const wf = Vault.state.workflows.find(w => w.builtin);
    const cvs = Canvas.current;
    cvs.nodes = [];
    cvs.edges = [];
    const mk = (id, type, x, y, w, data) => ({ id, type, x, y, w, data });
    cvs.nodes.push(mk('p1', 'prompt', 60, 60, 260, { role:'正向', text:'采用特写镜头从第一人称主观视角斜侧方平视拍摄，浅景深将车窗外流动的街灯光斑虚化为绚丽暗色块。' }));
    cvs.nodes.push(mk('n1', 'prompt', 60, 240, 260, { role:'负向', text:'马赛克, 低清, 变形的手, 多余的手指' }));
    cvs.nodes.push(mk('g1', 'gen', 380, 90, 356, {
      workflowId: wf.id, wfName: wf.name, status:'idle', statusText:'', batch:1, imageSlots:0
    }));
    cvs.edges.push({ from:'p1', to:'g1' }, { from:'n1', to:'g1' });
    await Vault.go('gallery');
    await Vault.go('canvas');
    return cvs.nodes.length;
  })()`);
  await sleep(1400);
  await ev(`document.querySelector('[data-cv="fit"]')?.click()`);
  await sleep(700);
  await shot('06-canvas-flow', '正向 / 负向 / 输出 三件套连好线');

  // 生成节点特写：把输出节点放大到 170% 并居中，尺寸 / 张数 / 生成按钮要看得清
  await ev(`(() => {
    const cvs = Canvas.current;
    const n = cvs.nodes.find(x => x.id === 'g1');
    cvs.view.k = 1.7;
    // 世界坐标 → 屏幕坐标的逆运算：让节点中心落在视口中心
    const vp = document.querySelector('#cv-viewport').getBoundingClientRect();
    cvs.view.x = vp.width / 2 - (n.x + (n.w || 320) / 2) * cvs.view.k;
    cvs.view.y = vp.height / 2 - (n.y + 150) * cvs.view.k;
    document.querySelector('#cv-world').style.transform =
      'translate(' + cvs.view.x + 'px,' + cvs.view.y + 'px) scale(' + cvs.view.k + ')';
    return 1;
  })()`).catch(e => console.log('特写失败：', e.message));
  await sleep(900);
  await shot('07-canvas-node', '输出节点特写：尺寸 / 张数 / 生成按钮');

  /* ============ 参考图库 ============ */
  // 每截完一个就清空 DOM：120 张缩略图 × 3 组留在内存里会把渲染进程顶爆
  const relax = async () => {
    await ev(`(() => { const v = document.querySelector('#view'); if (v) v.innerHTML = ''; return 1 })()`);
    await sleep(500);
  };

  for (const [view, file, note] of [
    ['outfits', '08-ref-outfits', '服饰参考：1407 条，顶部可按分类筛选'],
    ['faces', '09-ref-faces', '人脸参考：1499 条'],
    ['poses', '10-ref-poses', '姿势参考：1439 条，按体系分组']
  ]) {
    await ev(`(async()=>{ await Vault.go('${view}'); return 1 })()`);
    await sleep(2000);
    await shot(file, note);
    await relax();
  }

  /* ============ 提示词 ============ */
  await ev(`(async()=>{ await Vault.go('composer'); return 1 })()`);
  await sleep(1200);
  await shot('11-composer', '提示词组合台');

  await ev(`(async()=>{ await Vault.go('snippets'); return 1 })()`);
  await sleep(1200);
  await shot('12-snippets', '提示词片段库');

  /* ============ 资产 ============ */
  for (const [view, file, note] of [
    ['models', '13-models', '模型库'],
    ['loras', '14-loras', 'LoRA 列表'],
    ['workflows', '15-workflows', '工作流列表（含内置 KREA2）'],
    ['categories', '16-categories', '分类管理']
  ]) {
    await ev(`(async()=>{ await Vault.go('${view}'); return 1 })()`);
    await sleep(1200);
    await shot(file, note);
  }

  /* ============ 本地配置（原「设置」里的引擎段 + 画布「高级选项」的模型路径） ============ */
  await ev(`(async()=>{ await Vault.go('local'); return 1 })()`);
  await sleep(1800);
  await shot('15-local-engine', '本地配置：一键安装 / 引擎目录 / 启动与重启');

  const scrollTo = async (y) => {
    await ev(`(() => { const v = document.querySelector('#view'); if (v) v.scrollTop = ${y}; return 1 })()`);
    await sleep(700);
  };
  await scrollTo(660);
  await shot('16-local-paths', '本地配置：模型目录（默认就是 ComfyUI 的 models）');

  /* ============ AI 智能体 ============ */
  await ev(`(async()=>{ await Vault.go('ai'); return 1 })()`);
  await sleep(1300);
  await shot('19-ai-agents', 'AI 智能体：服务商与智能体（不配也能出图）');

  /* ============ 设置（只剩数据与关于） ============ */
  await ev(`(async()=>{ await Vault.go('settings'); return 1 })()`);
  await sleep(1200);
  await shot('25-settings', '设置：数据备份、存储占用与关于');

  /* ============ 资源监控面板 ============ */
  await ev(`(async()=>{ await Vault.go('gallery'); return 1 })()`);
  await sleep(900);
  await ev(`document.querySelector('#sys-badge').click()`);
  await sleep(2000);
  await shot('20-monitor', '资源监控面板（引擎未启动时会说明原因）');
  await ev(`document.querySelector('#sys-badge').click()`);
  await sleep(400);

  /* ============ 导入工作流弹窗 ============ */
  await ev(`(async()=>{ await Vault.go('canvas'); return 1 })()`);
  await sleep(900);
  await ev(`document.querySelector('[data-cv="import-wf"]').click()`);
  await sleep(1000);
  await shot('23-import-workflow', '导入 ComfyUI 工作流的弹窗');
  await ev(`document.querySelector('#modal')?.classList.add('hidden')`);
  await sleep(400);

  /* ============ 遮罩编辑器 ============ */
  await ev(`(async () => {
    const cvs = Canvas.current;
    cvs.nodes = cvs.nodes.filter(n => n.id !== 'm1');
    cvs.nodes.push({ id:'m1', type:'image', x: 60, y: 420, w: 260,
      data:{ src:'/demo/portrait_a1111.png', status:'idle', statusText:'' } });
    await Vault.go('gallery');
    await Vault.go('canvas');
    return 1;
  })()`);
  await sleep(1400);
  await ev(`document.querySelector('.cv-node[data-id="m1"] [data-cvnode="mask"]')?.click()`);
  await sleep(1200);
  await shot('24-mask-editor', '遮罩编辑器：涂哪儿重绘哪儿');
  await ev(`document.querySelector('#modal')?.classList.add('hidden')`);
  await sleep(300);

  /* ============ 简易节点包 ============ */
  await ev(`(async()=>{ await Vault.go('canvas'); return 1 })()`);
  await sleep(900);
  await ev(`document.querySelector('[data-cv="pack"]').click()`);
  await sleep(1000);
  await shot('21-simple-pack', '简易节点包：一键放一套三件套');
  await ev(`document.querySelector('#modal')?.classList.add('hidden')`);
  await sleep(300);

  /* ============ 加参考图弹窗（底栏「参考图」） ============ */
  await ev(`(async()=>{ await Vault.go('canvas'); return 1 })()`);
  await sleep(900);
  await ev(`document.querySelector('[data-cv="add-ref"]').click()`);
  await sleep(1600);
  await ev(`document.querySelector('[data-lib="outfits"]')?.click()`);
  await sleep(1200);
  await ev(`(() => { const g = document.querySelectorAll('#ref-grid .refpick'); g[0]?.click(); g[2]?.click(); return 1 })()`);
  await sleep(400);
  await shot('26-canvas-add-ref', '加参考图：图库 / 三个参考图库 / 本地文件，可多选');
  await ev(`document.querySelector('#modal')?.classList.add('hidden')`);
  await sleep(300);

  /* ============ 深色主题对照 ============ */
  await ev(`document.documentElement.dataset.theme='dark'`);
  await ev(`(async()=>{ await Vault.go('gallery'); return 1 })()`);
  await sleep(1400);
  await shot('22-dark-theme', '深色主题下的图库');
  await ev(`document.documentElement.dataset.theme='light'`);

  const errs = cdp.errors.filter(e => !/favicon/.test(e));
  console.log(`\n完成：${shotCount} 张 → docs/screenshots/`);
  console.log(errs.length ? '页面异常：\n' + errs.join('\n') : '页面异常：0');
} catch (e) {
  console.error('截图失败：', e.message);
  process.exitCode = 1;
} finally {
  cdp.close();
  chrome.kill();
}
