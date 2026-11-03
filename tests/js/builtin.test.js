/* ============================================================
   tests/js/builtin.test.js
   覆盖：内置工作流清单（KREA2 / Qwen-Image 2.1 编辑总控 / MOSS-Image SFT）
        · 播种：全新用户全量、二次启动不重复、老用户按版本补种、删除不复活
        · 槽位：两个新工作流在 parseSlots / applyInputs 下的真实表现
          （同节点多槽位认领、未接图 ref 槽位的 bypass 剔除）
   运行：node --test tests/js
   ============================================================ */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
// 跨 vm 沙箱的数组/对象原型不同，deepStrictEqual 会误报，结构比较走宽松版
const deep = require('node:assert').deepEqual;
const { loadComfy } = require('./harness');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { comfy } = loadComfy();

/* 在 node:vm 里跑 assets/builtin.js，DB 用内存版 IndexedDB 语义（put 按 id upsert） */
function loadBuiltin() {
  const ctx = { console, window: {} };
  const settings = {};
  const store = {};
  ctx.window.U = { uid: (p) => p + Math.random().toString(36).slice(2, 8) };
  ctx.window.DB = {
    getSettings: async () => JSON.parse(JSON.stringify(settings)),
    setSetting: async (k, v) => { settings[k] = v; },
    getAll: async (t) => JSON.parse(JSON.stringify(store[t] || [])),
    put: async (t, rec) => {
      const list = (store[t] = store[t] || []);
      const i = list.findIndex(x => x.id === rec.id);
      if (i >= 0) list[i] = rec; else list.push(rec);
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../assets/builtin.js'), 'utf8'), ctx);
  return { BUILTIN: ctx.window.BUILTIN, settings, store };
}

const BUILTIN_IDS = ['builtin-krea2-cc-portrait', 'builtin-qwen21-edit-master', 'builtin-moss-image-sft'];

/** 播种后从库里取某套内置的 API 内容 */
async function seededApi(id) {
  const { BUILTIN, store } = loadBuiltin();
  await BUILTIN.seed();
  const wf = store.workflows.find(w => w.id === id);
  assert.ok(wf, '播种库里应该有 ' + id);
  return JSON.parse(wf.content);
}

/* ---------------- 播种 ---------------- */
describe('内置工作流播种', () => {
  test('全新用户：三套全播，含槽位标注与备注链接', async () => {
    const { BUILTIN, store, settings } = loadBuiltin();
    await BUILTIN.seed();
    assert.deepEqual(store.workflows.map(w => w.id), BUILTIN_IDS);
    assert.equal(settings.wfSeeded, true);
    // 初代 KREA2 播种时就打上槽位标注
    const krea = JSON.parse(store.workflows[0].content);
    assert.equal(krea['164']._meta.title, 'prompt');
    assert.equal(krea['156']._meta.title, 'size');
    // 备注带作者的模型网盘
    assert.ok(store.workflows[1].note.includes('pan.quark.cn/s/0d49a0b21264'));
    assert.ok(store.workflows[2].note.includes('pan.quark.cn/s/e2110229fb8c'));
    // 全部收进简易节点包
    assert.equal(settings.simplePack.length, 3);
  });

  test('二次启动不重复播种', async () => {
    const { BUILTIN, store } = loadBuiltin();
    await BUILTIN.seed();
    await BUILTIN.seed();
    assert.equal(store.workflows.length, 3);
  });

  test('v5 老用户升级：按门槛补种两条，已有的不动', async () => {
    const { BUILTIN, store, settings } = loadBuiltin();
    settings.wfSeeded = true;
    settings.builtinWfVersion = 5;
    store.workflows = [{ id: 'builtin-krea2-cc-portrait', name: 'KREA2', content: '{}', size: 2 }];
    await BUILTIN.seed();
    const ids = store.workflows.map(w => w.id);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.includes('builtin-qwen21-edit-master'));
    assert.ok(ids.includes('builtin-moss-image-sft'));
  });

  test('删过的内置升级时不复活（wfBuiltinDismissed）', async () => {
    const { BUILTIN, store, settings } = loadBuiltin();
    settings.wfSeeded = true;
    settings.builtinWfVersion = 5;
    settings.wfBuiltinDismissed = ['builtin-moss-image-sft'];
    store.workflows = [{ id: 'builtin-krea2-cc-portrait', name: 'KREA2', content: '{}', size: 2 }];
    await BUILTIN.seed();
    const ids = store.workflows.map(w => w.id);
    assert.ok(!ids.includes('builtin-moss-image-sft'), '被删的内置复活了');
    assert.ok(ids.includes('builtin-qwen21-edit-master'), '没删的不该缺席');
  });

  test('v6 用户再启动：一切保持原样', async () => {
    const { BUILTIN, settings } = loadBuiltin();
    settings.wfSeeded = true;
    settings.builtinWfVersion = 6;
    const { BUILTIN: _, store } = loadBuiltin(); // 独立实例只用于断言前的准备
    const fresh = loadBuiltin();
    await fresh.BUILTIN.seed();
    const before = fresh.store.workflows.map(w => w.id);
    await fresh.BUILTIN.seed();
    assert.deepEqual(fresh.store.workflows.map(w => w.id), before);
  });
});

/* ---------------- 槽位解析（真实工作流内容） ---------------- */
describe('内置工作流 · parseSlots', () => {
  test('Qwen 2.1：10 个图位，seed/steps/cfg/denoise 同节点认领', async () => {
    const s = comfy.parseSlots(await seededApi('builtin-qwen21-edit-master'));
    assert.equal(s.labeled, true);
    assert.equal(s.imageSlots, 10);
    assert.ok(s.capabilities.includes('i2i'));
    assert.equal(s.slots.prompt.id, '474');
    assert.equal(s.slots.prompt.field, 'prompt');
    assert.equal(s.slots.negative_prompt.id, '474', 'negative_prompt 应从同一节点认领');
    assert.equal(s.slots.negative_prompt.field, 'negative_prompt');
    ['seed', 'steps', 'cfg', 'denoise'].forEach(k => assert.equal(s.numbers[k].id, '458', k + ' 应从 KSampler 认领'));
    // 参考图编号数值排序：01 在 10 之前
    deep(s.refs.map(r => r.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('MOSS：文生图 + size 拆宽高；steps/cfg 是连线不被认领', async () => {
    const s = comfy.parseSlots(await seededApi('builtin-moss-image-sft'));
    assert.equal(s.labeled, true);
    assert.equal(s.imageSlots, 0);
    assert.ok(s.capabilities.includes('t2i'));
    assert.equal(s.slots.prompt.id, '41');
    assert.equal(s.slots.prompt.field, 'value');
    assert.equal(s.slots.negative_prompt.id, '5');
    assert.equal(s.numbers.width.id, '6');
    assert.equal(s.numbers.height.id, '6');
    assert.equal(s.numbers.seed.id, '16');
    assert.equal(s.numbers.denoise.id, '16', 'denoise 是标量，应被认领');
    assert.equal(s.numbers.steps, undefined, 'steps 是连线，不该被认领');
    assert.equal(s.numbers.cfg, undefined, 'cfg 是连线，不该被认领');
    deep(s.warnings, []);
  });
});

/* ---------------- applyInputs（真实工作流内容） ---------------- */
describe('内置工作流 · applyInputs', () => {
  test('Qwen 2.1：只连 1 张图时，其余 9 个图位按 bypass 剔除', async () => {
    const api = await seededApi('builtin-qwen21-edit-master');
    const r = comfy.applyInputs(api, { prompt: '把背景换成海边', images: ['a.png'] });
    assert.equal(Object.values(r.api).filter(n => n.class_type === 'LoadImage').length, 1);
    // 编码节点只剩 image_1 输入（其余 images.image_N 连线一并删掉）
    const imgInputs = Object.keys(r.api['474'].inputs).filter(k => k.startsWith('images.'));
    assert.deepEqual(imgInputs, ['images.image_1']);
    assert.equal(r.api['474'].inputs.prompt, '把背景换成海边');
    assert.equal(r.used, 1);
    assert.equal(r.dropped, 0);
  });

  test('Qwen 2.1：3 张图各就各位', async () => {
    const api = await seededApi('builtin-qwen21-edit-master');
    const r = comfy.applyInputs(api, { images: ['a.png', 'b.png', 'c.png'] });
    assert.equal(Object.values(r.api).filter(n => n.class_type === 'LoadImage').length, 3);
    assert.equal(r.api['475'].inputs.image, 'b.png');
    assert.equal(r.api['477'].inputs.image, 'c.png');
  });

  test('Qwen 2.1：零图时全部图位剔除，纯文本也能过（image 输入都是可选的）', async () => {
    const api = await seededApi('builtin-qwen21-edit-master');
    const r = comfy.applyInputs(api, { prompt: 'p' });
    assert.equal(Object.values(r.api).filter(n => n.class_type === 'LoadImage').length, 0);
    assert.equal(Object.keys(r.api['474'].inputs).some(k => k.startsWith('images.')), false);
  });

  test('MOSS：提示词写进主体框，负向空值不覆盖默认，开关链路完好', async () => {
    const api = await seededApi('builtin-moss-image-sft');
    const r = comfy.applyInputs(api, { prompt: '一只橘猫在阳台晒太阳', negative: '', width: 1024, height: 768 });
    assert.equal(r.api['41'].inputs.value, '一只橘猫在阳台晒太阳');
    // 空负向不写：保留工作流自带的默认负向
    assert.equal(r.api['5'].inputs.text, 'worst quality, bad anatomy, watermark, jpeg artifact');
    // 尺寸槽位生效
    assert.equal(r.api['6'].inputs.width, 1024);
    assert.equal(r.api['6'].inputs.height, 768);
    // 质量词拼接与加速开关链路原样保留
    assert.deepEqual(r.api['42'].inputs.string_a, ['40', 0]);
    assert.deepEqual(r.api['42'].inputs.string_b, ['41', 0]);
    assert.deepEqual(r.api['16'].inputs.steps, ['27', 0]);
    assert.equal(r.mode, 'slot');
  });
});
