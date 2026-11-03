/* 把要打进桌面版的网页文件复制到 desktop/staging，供 extraResources 用。
   不直接 from:"../" 扫仓库根：那样会把 .git、desktop 自己、docs 都卷进 glob，
   在 CI 的受限环境里处理 4345 个缩略图时容易挂。 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const dst = path.join(root, 'desktop', 'staging');

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

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

console.log('staged ->', dst);
