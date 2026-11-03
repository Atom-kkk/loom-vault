/* ============================================================
   updater.js — 内置更新（连 GitHub Releases）
   ------------------------------------------------------------
   为什么不用 electron-updater：
     · Squirrel.Mac 在 macOS 上要求代码签名，本应用未签名走不通；
     · 它要求每次发布都附 latest.yml / latest-mac.yml 元数据，发布流程重；
     · 国内访问 api.github.com / objects.githubusercontent.com 很不稳。
   这里的做法按「未签名 + 国内网络」现实来：
     · 检查：HEAD {repo}/releases/latest 读 302 Location 里的 tag ——
       不碰 /api，一条 HEAD 就够；直连失败自动切 gh-proxy 镜像。
     · 下载：资产名是构建产物的固定命名（Loom Setup x.y.z.exe /
       Loom-x.y.z-arm64.dmg），按平台和架构挑，直连 → 镜像链重试。
     · 进度：win.setProgressBar()（Windows 任务栏 / macOS 程序坞原生进度）。
     · 安装：shell.openPath 引导（未签名做不了静默替换，引导到位即可）。
   ============================================================ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { app } = require('electron');

const REPO = 'Atom-kkk/loom-vault';
const MIRRORS = ['', 'https://gh-proxy.com/'];   // 空 = 直连优先，其余按序重试

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** 带镜像重试的 HEAD（不跟随重定向，返回 { status, location }） */
function headOnce(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', timeout: 12000 }, res => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

/** 带镜像重试的 GET（跟随重定向，返回 web stream 响应） */
function getStream(url, headers = {}) {
  const attempt = (u) => new Promise((resolve, reject) => {
    const req = https.get(u, { headers, timeout: 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return attempt(new URL(res.headers.location, u).href).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
  return (async () => {
    let lastErr;
    for (const m of MIRRORS) {
      try { return await attempt(m + url); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('下载失败');
  })();
}

/** 解析 tag 里的 x.y.z（v2.3.1 / 2.3.1 都认） */
function semverOf(tag) {
  const m = String(tag || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function isNewer(latest, current) {
  const a = semverOf(latest), b = semverOf(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * 检查最新版本：HEAD releases/latest → 302 Location → /tag/vX.Y.Z
 * @returns {{latest:string, current:string, hasUpdate:boolean, page:string}|null}
 *          null = 检查不了（离线 / 镜像都挂），由调用方决定是否提示
 */
async function checkForUpdate() {
  const current = app.getVersion();
  const target = `https://github.com/${REPO}/releases/latest`;
  let latest = null;
  let lastErr;
  for (const m of MIRRORS) {
    try {
      const r = await headOnce(m + target);
      const loc = r.location || '';
      const mm = loc.match(/\/tag\/(v?\d+\.\d+\.\d+)/);
      if (r.status === 200 && !mm) { latest = current; break; }   // 已经在 latest 页：无新版
      if (mm) { latest = mm[1].replace(/^v/, ''); break; }
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
  }
  if (!latest) throw lastErr || new Error('检查失败');
  return {
    latest, current,
    hasUpdate: isNewer(latest, current),
    page: `https://github.com/${REPO}/releases/tag/v${latest}`
  };
}

/** 当前平台该下载哪个资产（与 electron-builder 的产物命名一一对应） */
function assetNamesFor(version) {
  if (isWin) return [`Loom Setup ${version}.exe`, `Loom-${version}-win64.zip`];
  if (isMac) return process.arch === 'arm64'
    ? [`Loom-${version}-arm64.dmg`, `Loom-${version}-arm64-mac.zip`]
    : [`Loom-${version}-x64.dmg`, `Loom-${version}-x64-mac.zip`];
  return [];
}

/**
 * 下载对应平台的安装包到 userData/updates/
 * @returns {Promise<string>} 落地文件路径
 */
async function downloadUpdate(version, onProgress = () => { }) {
  const dir = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(dir, { recursive: true });

  let lastErr = null;
  for (const name of assetNamesFor(version)) {
    const url = `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(name)}`;
    const dst = path.join(dir, name);
    try {
      const res = await getStream(url);
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dst);
        res.on('data', c => {
          got += c.length;
          if (total) onProgress(Math.min(1, got / total), got, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
        res.on('error', reject);
      });
      if (total && got < total * 0.9) throw new Error('下载不完整');
      return dst;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(dst); } catch { }
    }
  }
  throw lastErr || new Error('没有找到匹配的安装包');
}

/** 打开下载好的安装包（exe / dmg 由系统接管） */
async function openUpdate(file) {
  const { shell } = require('electron');
  return shell.openPath(file);
}

module.exports = { checkForUpdate, downloadUpdate, openUpdate, assetNamesFor, isNewer };
