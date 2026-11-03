/* ============================================================
   tests/js/comfy.test.js
   覆盖：槽位协议 / applyInputs 两条路径 / 插件种子兜底 / 随机种子 /
        结果解析 / UI→API 转换
   运行：node --test tests/js
   ============================================================ */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
// 被测代码跑在 node:vm 沙箱里，数组/对象的原型来自另一个 context，
// deepStrictEqual 会因为「原型不同」误报，所以结构性比较走宽松版
const loose = require('node:assert');
const deep = loose.deepEqual;
const { loadComfy } = require('./harness');

const { comfy, ctx: sandbox } = loadComfy();

/* ---------------- 公共夹具 ---------------- */
const slotWorkflow = () => ({
  '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: '旧提示词' }, _meta: { title: 'prompt' } },
  '2': { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: 'negative_prompt' } },
  '3': { class_type: 'PrimitiveInt', inputs: { value: 123 }, _meta: { title: 'seed' } },
  '4': { class_type: 'LoadImage', inputs: { image: 'a.png' }, _meta: { title: 'ref_image_01' } },
  '5': { class_type: 'LoadImage', inputs: { image: 'b.png' }, _meta: { title: 'ref_image_02' } },
  '6': { class_type: 'LoadImage', inputs: { image: 'm.png' }, _meta: { title: 'ref_mask' } },
  '7': { class_type: 'KSampler', inputs: { seed: ['3', 0], positive: ['8', 0], negative: ['9', 0], steps: 20 } },
  '8': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['10', 0] } },
  '9': { class_type: 'CLIPTextEncode', inputs: { text: 'y', clip: ['10', 0] } },
  '10': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } }
});

const legacyWorkflow = () => ({
  '1': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'y.png' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
  '5': { class_type: 'KSampler', inputs: { positive: ['3', 0], negative: ['4', 0] } }
});

/* ---------------- 槽位解析 ---------------- */
describe('parseSlots', () => {
  test('识别标注、排序参考图、推导能力', () => {
    const s = comfy.parseSlots(slotWorkflow());
    assert.equal(s.labeled, true);
    deep(s.refs.map(r => r.index), [1, 2]);
    assert.equal(s.refs[0].id, '4');
    assert.equal(s.mask.id, '6');
    assert.equal(s.numbers.seed.id, '3');
    assert.equal(s.imageSlots, 2);
    assert.ok(s.capabilities.includes('inpaint'));
    assert.ok(s.capabilities.includes('i2i'));
  });

  test('参考图按编号数值排序（10 排在 2 之后）', () => {
    const api = {
      '1': { inputs: { image: '' }, _meta: { title: 'ref_image_10' } },
      '2': { inputs: { image: '' }, _meta: { title: 'ref_image_2' } }
    };
    const s = comfy.parseSlots(api);
    deep(s.refs.map(r => r.index), [2, 10]);
  });

  test('标题大小写、空格、短横线都宽容', () => {
    const s = comfy.parseSlots({ '1': { inputs: { value: 1 }, _meta: { title: '  Ref-Image 01 ' } } });
    assert.equal(s.labeled, true);
    assert.equal(s.refs[0].name, 'ref_image_01');
  });

  test('首尾帧同时存在才算 firstlast，只有首帧算 video', () => {
    const both = comfy.parseSlots({
      '1': { inputs: { image: '' }, _meta: { title: 'first_frame' } },
      '2': { inputs: { image: '' }, _meta: { title: 'last_frame' } }
    });
    assert.ok(both.capabilities.includes('firstlast'));
    const onlyFirst = comfy.parseSlots({ '1': { inputs: { image: '' }, _meta: { title: 'first_frame' } } });
    assert.ok(onlyFirst.capabilities.includes('video'));
  });

  test('没有标注时 labeled=false', () => {
    const s = comfy.parseSlots(legacyWorkflow());
    assert.equal(s.labeled, false);
    deep(s.capabilities, []);
  });

  test('重复标注会给出警告并取前者', () => {
    const s = comfy.parseSlots({
      '1': { inputs: { text: '' }, _meta: { title: 'prompt' } },
      '2': { inputs: { text: '' }, _meta: { title: 'prompt' } }
    });
    assert.equal(s.slots.prompt.id, '1');
    assert.match(s.warnings.join(''), /重复标注/);
  });

  test('槽位节点没有可写输入时给出警告', () => {
    const s = comfy.parseSlots({ '1': { inputs: {}, _meta: { title: 'prompt' } } });
    assert.match(s.warnings.join(''), /找不到可写入的输入/);
  });
});

/* ---------------- applyInputs：槽位路径 ---------------- */
describe('applyInputs（有标注）', () => {
  test('按槽位精确写入，且不改动原对象', () => {
    const api = slotWorkflow();
    const r = comfy.applyInputs(api, {
      prompt: '新提示词', negative: '坏手',
      images: ['u1.png', 'u2.png'], mask: 'mask.png', seed: 42
    });
    assert.equal(r.mode, 'slot');
    assert.equal(r.used, 2);
    assert.equal(r.slots, 2);
    assert.equal(r.api['1'].inputs.value, '新提示词');
    assert.equal(r.api['2'].inputs.value, '坏手');
    assert.equal(r.api['4'].inputs.image, 'u1.png');
    assert.equal(r.api['5'].inputs.image, 'u2.png');
    assert.equal(r.api['6'].inputs.image, 'mask.png');
    assert.equal(r.api['3'].inputs.value, 42);
    assert.equal(api['1'].inputs.value, '旧提示词', '原工作流不应被修改');
  });

  test('参考图多于图位时 dropped 正确', () => {
    const r = comfy.applyInputs(slotWorkflow(), { images: ['a', 'b', 'c'] });
    assert.equal(r.used, 2);
    assert.equal(r.dropped, 1);
  });

  test('没有 ref_mask 槽位却传了遮罩 → 警告而非静默丢弃', () => {
    const api = {
      '1': { inputs: { value: '' }, _meta: { title: 'prompt' } },
      '2': { inputs: { image: '' }, _meta: { title: 'ref_image_01' } }
    };
    const r = comfy.applyInputs(api, { prompt: 'p', images: ['a.png'], mask: 'm.png' });
    assert.match(r.warnings.join(''), /ref_mask/);
  });

  test('只有 first_frame 时第一张图当首帧', () => {
    const api = { '1': { inputs: { image: '' }, _meta: { title: 'first_frame' } } };
    const r = comfy.applyInputs(api, { images: ['f.png'] });
    assert.equal(r.api['1'].inputs.image, 'f.png');
    assert.equal(r.used, 1);
  });

  test('数值槽位写 width / height / batch', () => {
    const api = {
      '1': { inputs: { value: 0 }, _meta: { title: 'width' } },
      '2': { inputs: { value: 0 }, _meta: { title: 'height' } },
      '3': { inputs: { value: 0 }, _meta: { title: 'batch' } }
    };
    const r = comfy.applyInputs(api, { width: 832, height: 1216, batch: 4 });
    assert.equal(r.api['1'].inputs.value, 832);
    assert.equal(r.api['2'].inputs.value, 1216);
    assert.equal(r.api['3'].inputs.value, 4);
  });

  test('空字符串 / NaN 不会把数值槽位写成 0', () => {
    const api = { '1': { inputs: { value: 7 }, _meta: { title: 'width' } } };
    const r = comfy.applyInputs(api, { width: '', seed: undefined });
    assert.equal(r.api['1'].inputs.value, 7);
  });
});

/* ---------------- applyInputs：旧路径 ---------------- */
describe('applyInputs（无标注降级）', () => {
  test('按 KSampler 的 positive/negative 连线找提示词节点', () => {
    const r = comfy.applyInputs(legacyWorkflow(), { prompt: '猫', negative: '丑' });
    assert.equal(r.mode, 'legacy');
    assert.equal(r.api['3'].inputs.text, '猫');
    assert.equal(r.api['4'].inputs.text, '丑');
    assert.match(r.warnings.join(''), /没有槽位标注/);
  });

  test('LoadImage 按节点 id 升序填图', () => {
    const r = comfy.applyInputs(legacyWorkflow(), { images: ['one.png', 'two.png'] });
    assert.equal(r.used, 2);
    assert.equal(r.api['1'].inputs.image, 'one.png');
    assert.equal(r.api['2'].inputs.image, 'two.png');
  });
});

/* ---------------- 种子相关 ---------------- */
describe('withFreshSeeds / stripPluginSeeds', () => {
  test('负数 seed 被替换成正整数，正数保持不变', () => {
    const r = comfy.withFreshSeeds({
      '1': { inputs: { seed: -1 } },
      '2': { inputs: { noise_seed: -1 } },
      '3': { inputs: { seed: 12345 } }
    });
    assert.ok(r['1'].inputs.seed > 0);
    assert.ok(r['2'].inputs.noise_seed > 0);
    assert.equal(r['3'].inputs.seed, 12345);
  });

  test('拆掉 rgthree 的 Seed 节点并把引用改成字面量', () => {
    const r = comfy.stripPluginSeeds({
      '1': { class_type: 'Seed (rgthree)', inputs: { seed: 1 } },
      '2': { class_type: 'KSampler', inputs: { seed: ['1', 0], steps: 8 } }
    });
    assert.equal(r['1'], undefined);
    assert.equal(r['2'].inputs.seed, -1);
  });

  test('没有插件节点时原样返回（同一个对象）', () => {
    const api = { '1': { class_type: 'KSampler', inputs: { seed: 5 } } };
    assert.equal(comfy.stripPluginSeeds(api), api);
  });
});

/* ---------------- 结果解析 ---------------- */
describe('extractImages', () => {
  test('同时收 images 与 gifs，空值安全', () => {
    assert.equal(comfy.extractImages(null).length, 0);
    assert.equal(comfy.extractImages({}).length, 0);
    const imgs = comfy.extractImages({
      outputs: { '9': { images: [{ filename: 'a.png' }] }, '10': { gifs: [{ filename: 'b.gif' }] } }
    });
    deep(imgs.map(x => x.filename), ['a.png', 'b.gif']);
  });
});

/* ---------------- UI → API ---------------- */
describe('uiToApi', () => {
  const objectInfo = {
    CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP', {}] } } },
    KSampler: {
      input: {
        required: {
          model: ['MODEL', {}], positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}],
          seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}]
        }
      }
    },
    EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } } }
  };

  const ui = {
    nodes: [
      { id: 1, type: 'CLIPTextEncode', title: 'prompt', inputs: [{ name: 'clip', link: null }], widgets_values: ['一只猫'] },
      {
        id: 2, type: 'KSampler',
        inputs: [{ name: 'model', link: null }, { name: 'positive', link: 10 }, { name: 'negative', link: null }],
        widgets_values: [12345, 'randomize', 20, 7.5]
      },
      { id: 3, type: 'EmptyLatentImage', inputs: [], widgets_values: [512, 768, 1] }
    ],
    links: [[10, 1, 0, 2, 1, 'CONDITIONING']]
  };

  test('widgets_values 按定义顺序填，seed 后面那个 randomize 会被跳过', () => {
    const r = comfy.uiToApi(ui, objectInfo);
    assert.equal(r.api['2'].inputs.seed, 12345);
    assert.equal(r.api['2'].inputs.steps, 20, 'randomize 不该被当成 steps');
    assert.equal(r.api['2'].inputs.cfg, 7.5);
    deep(r.api['3'].inputs, { width: 512, height: 768, batch_size: 1 });
  });

  test('连线会转成 [上游id, 槽位]', () => {
    const r = comfy.uiToApi(ui, objectInfo);
    deep(r.api['2'].inputs.positive, ['1', 0]);
  });

  test('节点标题写进 _meta.title（槽位标注能跟着转过去）', () => {
    const r = comfy.uiToApi(ui, objectInfo);
    assert.equal(r.api['1']._meta.title, 'prompt');
  });

  test('缺失节点定义时抛明确错误', () => {
    const bad = { nodes: [{ id: 1, type: 'NotInstalled', inputs: [], widgets_values: [] }], links: [] };
    assert.throws(() => comfy.uiToApi(bad, objectInfo), /找不到节点/);
  });
});

/* ---------------- 槽位摘要 ---------------- */
test('slotSummary 生成人类可读摘要', () => {
  const s = comfy.parseSlots(slotWorkflow());
  const text = comfy.slotSummary(s);
  assert.match(text, /参考图/);
  assert.match(text, /2 个图位/);
  assert.match(text, /遮罩/);
  assert.equal(comfy.slotSummary({ labeled: false }), '');
});

/* ============================================================
   资源监控用到的格式化 / 耗时估计
   ============================================================ */
describe('fmtClock', () => {
  test('不到一小时是 mm:ss，超过就带小时', () => {
    assert.equal(comfy.fmtClock(0), '00:00');
    assert.equal(comfy.fmtClock(72), '01:12');
    assert.equal(comfy.fmtClock(3725), '1:02:05');
  });

  test('负数 / 非数字按 0 处理，不吐 NaN', () => {
    assert.equal(comfy.fmtClock(-5), '00:00');
    assert.equal(comfy.fmtClock(null), '00:00');
    assert.equal(comfy.fmtClock('abc'), '00:00');
  });
});

describe('fmtLoose', () => {
  test('秒 / 分 / 小时三种量级', () => {
    assert.equal(comfy.fmtLoose(48), '48 秒');
    assert.equal(comfy.fmtLoose(200), '3 分 20 秒');
    assert.equal(comfy.fmtLoose(180), '3 分');
    assert.equal(comfy.fmtLoose(4320), '1 小时 12 分');
  });
});

describe('fmtBytes', () => {
  test('GB / MB / KB 自动选单位', () => {
    assert.equal(comfy.fmtBytes(16 * 1024 ** 3), '16 GB');
    // 10 GB 以上取整：显存/内存面板里 "15 GB / 16 GB" 比 "15.2 GB" 好读
    assert.equal(comfy.fmtBytes(15.2 * 1024 ** 3), '15 GB');
    assert.equal(comfy.fmtBytes(3.4 * 1024 ** 3), '3.4 GB');
    assert.equal(comfy.fmtBytes(834 * 1024 ** 2), '834 MB');
    assert.equal(comfy.fmtBytes(2048), '2 KB');
  });

  test('0 / 空值不显示成 0 GB', () => {
    assert.equal(comfy.fmtBytes(0), '—');
    assert.equal(comfy.fmtBytes(null), '—');
    assert.equal(comfy.fmtBytes('x'), '—');
  });
});

describe('生成耗时历史', () => {
  test('durKey 把批次分开（批量 4 张不该污染批量 1 张）', () => {
    assert.equal(comfy.durKey('wf1', 1), 'wf1#1');
    assert.equal(comfy.durKey('wf1', 4), 'wf1#4');
    assert.equal(comfy.durKey('', 0), 'wf#1', '空 id / 非法批量要归一');
  });

  test('没记录时 durAvg 返回 null，不编造一个数', () => {
    assert.equal(comfy.durAvg('nope#1'), null);
  });

  test('记录后取中位数（秒），偶尔一次异常值不会带偏', () => {
    const key = 'wfX#1';
    [100000, 110000, 105000].forEach(ms => comfy.durRecord(key, ms));
    assert.equal(comfy.durAvg(key), 105);

    comfy.durRecord(key, 1620000);        // 那次卡了 27 分钟
    const v = comfy.durAvg(key);
    assert.ok(v >= 105 && v <= 110, `中位数应仍在 ~105s，实际 ${v}`);
  });

  test('durLast 记录最近一次', () => {
    comfy.durRecord('wfY#1', 45000);
    assert.equal(comfy.durLast(), 45);
  });

  test('非法耗时直接丢弃', () => {
    comfy.durRecord('wfZ#1', 0);
    comfy.durRecord('wfZ#1', -3);
    comfy.durRecord('wfZ#1', NaN);
    assert.equal(comfy.durAvg('wfZ#1'), null);
  });

  test('只保留最近 DUR_KEEP 条（不让 localStorage 无限长）', () => {
    const key = 'wfKeep#1';
    for (let i = 0; i < 20; i++) comfy.durRecord(key, 1000 + i);
    // localStorage 在 vm 沙箱里，不是 Node 全局
    const raw = JSON.parse(sandbox.localStorage.getItem('vault.gen.dur'));
    assert.equal(raw[key].length, 6);
  });
});

/* ============================================================
   etaText —— 画布节点上的「已用 / 剩余」
   ============================================================ */
describe('etaText', () => {
  const T0 = 1_700_000_000_000;

  test('没有计时器时返回空串（状态行不该多出个 ·）', () => {
    assert.equal(comfy.etaText(null), '');
    assert.equal(comfy.etaText(undefined), '');
  });

  test('一点进度都没有时，只说已用', () => {
    const s = comfy.etaText({ t0: T0, step: 0, total: 0, per: 0, hist: null }, T0 + 72_000);
    assert.equal(s, '已用 01:12');
    assert.ok(!/剩余/.test(s), '没数据就不该编个预计出来');
  });

  test('有步进进度就按速率外推', () => {
    // 20 步跑了 4 步，用了 60 秒 → 每步 15 秒 → 还剩 16 步 = 240 秒
    const g = { t0: T0, curT0: T0, batchIdx: 0, batchTotal: 1, step: 4, total: 20, per: 15 };
    const s = comfy.etaText(g, T0 + 60_000);
    assert.match(s, /已用 01:00/);
    assert.match(s, /剩余约 04:00/);
  });

  test('批量生成会把后面还没跑的张数算进去', () => {
    // 第 1/3 张、20 步跑了 4 步 → 当前张剩 240 秒 + 后面 2 张 × 300 秒 = 840 秒
    const g = { t0: T0, curT0: T0, batchIdx: 0, batchTotal: 3, step: 4, total: 20, per: 15 };
    const s = comfy.etaText(g, T0 + 60_000);
    assert.match(s, /已用 01:00/);
    assert.match(s, /剩余约 14:00/);
  });

  test('批量跑到第 2 张时已用时间不从零算', () => {
    const g = { t0: T0, curT0: T0 + 300_000, batchIdx: 1, batchTotal: 3, step: 4, total: 20, per: 15 };
    const s = comfy.etaText(g, T0 + 360_000);
    assert.match(s, /已用 06:00/, '整批已用 6 分钟');
    assert.match(s, /剩余约 09:00/, '本张剩 4 分 + 后面 1 张 5 分');
  });

  test('没有进度但有历史耗时就拿历史减已用', () => {
    const g = { t0: T0, step: 0, total: 0, per: 0, hist: 200 };
    const s = comfy.etaText(g, T0 + 80_000);
    assert.match(s, /已用 01:20/);
    assert.match(s, /剩余约 02:00/);
  });

  test('超过历史耗时就说快好了，不吐负数', () => {
    const g = { t0: T0, step: 0, total: 0, per: 0, hist: 200 };
    const s = comfy.etaText(g, T0 + 240_000);
    assert.match(s, /快好了/);
    assert.ok(!/-\d/.test(s), '不该出现负数时间：' + s);
  });

  test('进度算出来不足 1 秒时也是快好了', () => {
    const g = { t0: T0, batchIdx: 0, batchTotal: 1, step: 19, total: 20, per: 0.01 };
    assert.match(comfy.etaText(g, T0 + 60_000), /快好了/);
  });

  test('时间戳早于 t0（系统时钟被改）时不出现负数已用', () => {
    const g = { t0: T0, step: 0, total: 0, per: 0, hist: null };
    assert.equal(comfy.etaText(g, T0 - 30_000), '已用 00:00');
  });
});

/* ============================================================
   分辨率槽位：parseSlots 要带出工作流里的当前宽高，
   画布上的尺寸输入框靠它预填（用户不改就沿用工作流原值）
   ============================================================ */
describe('parseSlots · 分辨率与时长', () => {
  const sized = () => ({
    '1': { inputs: { value: 'p' }, _meta: { title: 'prompt' } },
    '2': { inputs: { value: 1216 }, _meta: { title: 'width' } },
    '3': { inputs: { value: 832 }, _meta: { title: 'height' } },
    '4': { inputs: { value: 5 }, _meta: { title: 'duration' } }
  });

  test('width / height / duration 进 numbers，且带出当前值', () => {
    const s = comfy.parseSlots(sized());
    assert.equal(s.numbers.width.id, '2');
    assert.equal(s.numbers.width.value, 1216);
    assert.equal(s.numbers.height.value, 832);
    assert.equal(s.numbers.duration.value, 5);
  });

  test('applyInputs 只写传进来的那一个，没传的保持工作流原值', () => {
    const s = comfy.parseSlots(sized());
    const r1 = comfy.applyInputs(sized(), { width: 768 });
    assert.equal(r1.api['2'].inputs.value, 768, '宽度被改');
    assert.equal(r1.api['3'].inputs.value, 832, '高度不动');
    assert.ok(s.numbers.height, '原始解析仍然记得高度槽位');

    const r2 = comfy.applyInputs(sized(), { width: 768, height: 1344 });
    assert.equal(r2.api['2'].inputs.value, 768);
    assert.equal(r2.api['3'].inputs.value, 1344);
  });

  test('传空值 / NaN 不写（不把工作流里的尺寸弄坏）', () => {
    const r = comfy.applyInputs(sized(), { width: '', height: null });
    assert.equal(r.api['2'].inputs.value, 1216);
    assert.equal(r.api['3'].inputs.value, 832);
  });

  test('没标尺寸槽位的流，传了也无处可写、不报错', () => {
    const r = comfy.applyInputs(legacyWorkflow(), { width: 1024, height: 1024 });
    assert.equal(r.mode, 'legacy');
    assert.ok(r.api['1'].inputs);
  });
});

/* ============================================================
   size 合体槽位：宽高在同一个节点（EmptyLatentImage / 视频 latent）
   ============================================================ */
describe('size 合体槽位', () => {
  const latent = () => ({
    '1': { class_type: 'EmptyLatentImage', inputs: { width: 1216, height: 832, batch_size: 1 }, _meta: { title: 'size' } }
  });

  test('一个 size 顶 width + height，带出原值', () => {
    const s = comfy.parseSlots(latent());
    assert.equal(s.labeled, true);
    assert.equal(s.numbers.width.field, 'width');
    assert.equal(s.numbers.height.field, 'height');
    assert.equal(s.numbers.width.value, 1216);
    assert.equal(s.numbers.height.value, 832);
    assert.equal(s.numbers.width.id, '1');
    assert.equal(s.numbers.width.via, 'size');
  });

  test('applyInputs 写进同一个节点的两个 input', () => {
    const r = comfy.applyInputs(latent(), { width: 768, height: 1344 });
    assert.equal(r.api['1'].inputs.width, 768);
    assert.equal(r.api['1'].inputs.height, 1344);
    assert.equal(r.api['1'].inputs.batch_size, 1, '别的 input 不许动');
  });

  test('只给宽度就只改宽度，高度留原值', () => {
    const r = comfy.applyInputs(latent(), { width: 1024 });
    assert.equal(r.api['1'].inputs.width, 1024);
    assert.equal(r.api['1'].inputs.height, 832);
  });

  test('节点里没有 width / height 时给出警告而不是静默失效', () => {
    const s = comfy.parseSlots({ '1': { inputs: { value: 1 }, _meta: { title: 'size' } } });
    assert.ok(s.warnings.some(w => /size/.test(w)), s.warnings.join('|'));
  });

  test('单独标 width / height 的老写法照样能用', () => {
    const s = comfy.parseSlots({
      '1': { inputs: { value: 512 }, _meta: { title: 'width' } },
      '2': { inputs: { value: 768 }, _meta: { title: 'height' } }
    });
    assert.equal(s.numbers.width.id, '1');
    assert.equal(s.numbers.height.id, '2');
    assert.equal(s.numbers.width.via, undefined);
  });
});
