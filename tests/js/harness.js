/* ============================================================
   tests/js/harness.js — 在 Node 里加载浏览器脚本
   ------------------------------------------------------------
   项目没有构建步骤，assets/*.js 是直接挂在 window 上的 IIFE。
   这里用 node:vm 造一个最小浏览器环境，把脚本原样跑起来，
   这样测的就是「真正会被浏览器执行的代码」，不是复制品。
   ============================================================ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

function makeSandbox() {
  const store = new Map();

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    JSON,
    Math,
    Date,
    URL,
    URLSearchParams,
    Blob: class Blob {
      constructor(parts, opts) {
        this.parts = parts || [];
        this.type = (opts && opts.type) || '';
        this.size = this.parts.reduce((n, p) => n + String(p).length, 0);
      }
    },
    // 浏览器里这些是全局可用的
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear()
    },
    document: {
      createElement: () => ({
        style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {}, setAttribute() {}, addEventListener() {}, querySelector: () => null
      }),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { appendChild() {} }
    },
    navigator: { userAgent: 'node-test' },
    location: { protocol: 'http:', href: 'http://127.0.0.1:8787/' },
    // 测试里不允许偷偷发请求
    fetch: async () => { throw new Error('测试环境禁止真实网络请求'); },
    WebSocket: class { constructor() { throw new Error('测试环境禁用 WebSocket'); } }
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return vm.createContext(sandbox);
}

/** 把 assets/<name>.js 跑起来，返回所在的 sandbox（window 上会有脚本导出的对象） */
function loadScript(name, sandbox) {
  const ctx = sandbox || makeSandbox();
  const file = path.join(ROOT, 'assets', name);
  const code = fs.readFileSync(file, 'utf8');
  vm.runInContext(code, ctx, { filename: name });
  return ctx;
}

function loadComfy() {
  const ctx = loadScript('comfy.js');
  return { comfy: ctx.window.Comfy, ctx };
}

module.exports = { ROOT, makeSandbox, loadScript, loadComfy };
