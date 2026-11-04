/* 把要打进桌面版的网页文件 + 内置 Python 复制到 desktop/staging，供 extraResources 用。
   不直接 from:"../" 扫仓库根：那样会把 .git、desktop 自己、docs 都卷进 glob，
   在 CI 的受限环境里处理 4345 个缩略图时容易挂。 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath 而不是 import.meta.dirname：后者要 Node 20.11+，CI 的 20.x 未必够
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const desktop = path.join(root, 'desktop');
const dst = path.join(desktop, 'staging');

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

// ① 网页文件
const files = [
  'index.html', 'serve.py', 'favicon.ico',
  'apple-touch-icon.png', 'apple-touch-icon-precomposed.png',
  'LICENSE', 'README.md'
];
for (const f of files) {
  const s = path.join(root, f);
  if (existsSync(s)) cpSync(s, path.join(dst, f));
}
for (const dir of ['assets', 'reference', 'demo']) {
  cpSync(path.join(root, dir), path.join(dst, dir), { recursive: true });
}

// ② 内置 standalone Python 不进 staging：package.json 的 extraResources
//    直接把 runtime/python 映射到 resources/python（main.js 从那里找它）。
//    放进 staging 会跟着 web 一起被打进包、再被复制进用户目录，白占 67MB。
//    这里只把关：没有它就违背了「双击即用」的要求，直接拒绝打包。
const macPy = path.join(desktop, 'runtime', 'python', 'bin', 'python3');
const winPy = [
  path.join(desktop, 'runtime', 'python-win', 'bin', 'python.exe'),
  path.join(desktop, 'runtime', 'python-win', 'python.exe')
].find(existsSync);
const isWin = process.platform === 'win32';

if (isWin) {
  // Windows runner 只需要 Windows runtime；mac 版由 mac runner 单独打
  if (!winPy) {
    console.error('  ✕ 未找到 desktop/runtime/python-win 的 python.exe —— 内置 Python 缺失，拒绝打包');
    process.exit(1);
  }
  console.log('  windows python runtime 就位（win.extraResources: runtime/python-win → resources/python）');
} else {
  if (!existsSync(macPy)) {
    console.error('  ✕ 未找到 desktop/runtime/python/bin/python3 —— 内置 Python 缺失，拒绝打包');
    console.error('    请下载 python-build-standalone（macOS arm64/x64，install_only 版）');
    console.error('    解压后把内容放到 desktop/runtime/python，再重新打包。');
    process.exit(1);
  }
  console.log('  python runtime 就位（extraResources: runtime/python → resources/python）');
  if (!winPy) {
    console.warn('  ⚠ 未找到 runtime/python-win 的 python.exe —— Windows 包会退回系统 Python');
  } else {
    console.log('  windows python runtime 就位（win.extraResources: runtime/python-win → resources/python）');
  }
}

console.log('staged ->', dst);
