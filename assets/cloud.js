/* ============================================================
   cloud.js — 云端生图
   · 模型库里配好「接口地址 + Key + 模型名 + 调用形态」就能用
   · 两条通道：
       ① OpenAI 兼容（覆盖 OpenAI / 智谱 / 火山 Seedream / SiliconFlow /
          以及几乎所有中转站）：
            · images 形态：POST {base}/images/generations
            · chat   形态：POST {base}/chat/completions（部分中转把生图
              模型包成对话接口，图片以 markdown 链接混在回复里）
       ② 厂商原生适配器：
            · dashscope —— 阿里通义万相（提交任务 → 轮询 task_id）
            · bfl      —— Black Forest Labs Flux（提交任务 → 轮询 get_result）
            · google   —— Google Imagen（:predict，返回 base64）
   · 浏览器直连被 CORS 挡住时自动回落到本地服务代理（/comfy?u=…，
     serve.py 会转发 Authorization），桌面版和本地 serve 场景都能通。
   ============================================================ */

window.Cloud = (function () {
  'use strict';

  const U = window.U;

  /* ---------------- 预设目录：市面上的主流云端生图模型 ----------------
     base 填到根（不带 /images/generations），shape 决定调用方式。
     中转站用户：选「OpenAI 兼容（中转站）」预设，填中转站地址和模型名。 */
  const CLOUD_PRESETS = [
    {
      key: 'openai-gpt-image', name: 'GPT-Image 2.5', vendor: 'OpenAI',
      base: 'https://api.openai.com/v1', model: 'gpt-image-2.5-sunburst', shape: 'images',
      note: '另有 Flare 变体：直接改模型名为 gpt-image-2.5-flare；支持图生图（/images/edits）'
    },
    {
      key: 'zhipu-glm-image', name: 'GLM-Image', vendor: '智谱',
      base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-image', shape: 'images',
      note: '智谱新旗舰生图模型；open.bigmodel.cn 申请 Key'
    },
    {
      key: 'dashscope-wan27', name: 'Wan2.7-Image Pro', vendor: '阿里云',
      base: 'https://dashscope.aliyuncs.com', model: 'wan2.7-image-pro', shape: 'dashscope',
      note: '通义万相 2.7 生成与编辑；异步任务制，提交后自动轮询'
    },
    {
      key: 'ark-seedream', name: 'Seedream 5.0 Pro', vendor: '火山引擎（即梦）',
      base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-pro-260628', shape: 'images',
      note: '另有 Flash 档：doubao-seedream-5-0-flash-260915；4.x 版本官方已标记即将下线'
    },
    {
      key: 'google-nano-banana', name: 'Nano Banana 2.1', vendor: 'Google',
      base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-nano-banana-2.1', shape: 'chat',
      note: '走 Gemini 的 OpenAI 兼容层（chat 返图）；支持参考图编辑，Google AI Studio 申请 Key'
    },
    {
      key: 'bfl-flux3', name: 'FLUX 3 Image Klein', vendor: 'Black Forest Labs',
      base: 'https://api.bfl.ai/v1', model: 'flux-3-image-klein', shape: 'bfl',
      note: 'BFL 最新一代；另有 FLUX.2 Pro（模型名改 flux-2-pro）；异步任务制'
    },
    {
      key: 'siliconflow-kolors', name: 'Kolors 2.1', vendor: 'SiliconFlow',
      base: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors-2.1', shape: 'images',
      note: '硅基流动国内直连快；确切模型 ID 可在编辑卡片时核对'
    },
    {
      key: 'relay', name: 'OpenAI 兼容（中转站 / 自建）', vendor: '自定义',
      base: '', model: '', shape: 'images',
      note: '填中转站地址（带 /v1）、Key 和模型名；走 images 或 chat 形态'
    }
  ];

  const SHAPE_LABEL = {
    images: 'images（OpenAI /images/generations）',
    chat: 'chat（对话接口返图，部分中转站）',
    dashscope: '万相（阿里 DashScope 异步任务）',
    bfl: 'Flux（BFL 异步任务）',
    google: 'Imagen（Google :predict）'
  };

  /* ---------------- 请求通道：直连优先，被 CORS 挡住走本地代理 ---------------- */
  async function raw(url, opts) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { }
    if (!res.ok) {
      const msg = (json && (json.error && (json.error.message || json.error)) || text || ('HTTP ' + res.status));
      throw new Error(typeof msg === 'string' ? msg.slice(0, 300) : JSON.stringify(msg).slice(0, 300));
    }
    return json !== null ? json : text;
  }

  async function call(url, opts = {}) {
    try {
      return await raw(url, opts);
    } catch (e) {
      // TypeError = 浏览器侧网络失败（CORS / 断网）。本地服务在跑就走它转发
      if (!(e instanceof TypeError) || !(window.Comfy && Comfy.hasBackend())) throw e;
      const r = await fetch('/comfy?u=' + encodeURIComponent(url), opts);
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { }
      if (!r.ok) {
        const msg = (json && (json.error && (json.error.message || json.error)) || text || ('HTTP ' + r.status));
        throw new Error(typeof msg === 'string' ? msg.slice(0, 300) : JSON.stringify(msg).slice(0, 300));
      }
      return json !== null ? json : text;
    }
  }

  const dataURLof = b64 => 'data:image/png;base64,' + b64;

  async function toBlob(src) {
    if (src.startsWith('data:')) {
      return await (await fetch(src)).blob();
    }
    const r = await fetch(src).catch(() => null);
    if (!r || !r.ok) throw new Error('生成结果下载失败');
    return await r.blob();
  }

  /* ---------------- 形态一：OpenAI /images/generations ---------------- */
  async function genImages(model, { prompt, count, refs, onStatus }) {
    const base = String(model.apiBase || '').replace(/\/+$/, '');
    // gpt-image 系支持图生图（/images/edits multipart）；其它模型有参考图时提示忽略
    if (refs.length && /gpt-image/i.test(model.apiModel || model.name || '')) {
      onStatus && onStatus('上传参考图到云端…');
      const fd = new FormData();
      fd.append('model', model.apiModel);
      fd.append('prompt', prompt);
      fd.append('n', String(count || 1));
      if (model.size) fd.append('size', model.size);
      for (let i = 0; i < Math.min(refs.length, 4); i++) {
        fd.append('image[]', refs[i], `ref_${i}.png`);
      }
      const j = await call(base + '/images/edits', {
        method: 'POST', headers: { Authorization: 'Bearer ' + (model.apiKey || '') }, body: fd
      });
      return await collectOpenAI(j);
    }
    if (refs.length) {
      onStatus && onStatus('这个云端模型不吃参考图，已忽略（只有 GPT Image 系支持）');
    }
    const body = { model: model.apiModel, prompt, n: count || 1 };
    if (model.size) body.size = model.size;
    const j = await call(base + '/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (model.apiKey || '') },
      body: JSON.stringify(body)
    });
    return await collectOpenAI(j);
  }

  async function collectOpenAI(j) {
    const out = [];
    for (const d of (j && j.data) || []) {
      if (d.b64_json) out.push(await toBlob(dataURLof(d.b64_json)));
      else if (d.url) out.push(await toBlob(d.url));
    }
    if (!out.length) throw new Error('云端返回里没有图片（检查模型名是否是生图模型）');
    return out;
  }

  /* ---------------- 形态二：/chat/completions 里返图（部分中转站） ---------------- */
  async function genChat(model, { prompt, refs, onStatus }) {
    const base = String(model.apiBase || '').replace(/\/+$/, '');
    let content = prompt;
    if (refs.length) {
      // 视觉风格多段 content：文本 + 参考图（dataURL）
      content = [{ type: 'text', text: prompt }];
      for (let i = 0; i < Math.min(refs.length, 3); i++) {
        const blob = refs[i];
        const dataURL = await new Promise((ok) => {
          const fr = new FileReader();
          fr.onload = () => ok(fr.result); fr.readAsDataURL(blob);
        });
        content.push({ type: 'image_url', image_url: { url: dataURL } });
      }
    }
    onStatus && onStatus('云端生成中…');
    const j = await call(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (model.apiKey || '') },
      body: JSON.stringify({ model: model.apiModel, messages: [{ role: 'user', content }] })
    });
    const msg0 = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
    let text = typeof msg0.content === 'string' ? msg0.content : '';
    const inline = [];
    if (Array.isArray(msg0.content)) {
      // 多段 content（视觉模型常见）：图片在 image_url 段里，文字拼起来再兜底解析
      for (const part of msg0.content) {
        if (part && part.type === 'image_url' && part.image_url && part.image_url.url) inline.push(part.image_url.url);
        if (part && typeof part.text === 'string') text += part.text;
      }
    }
    // 抠 markdown 图片链接或内嵌 base64
    const md = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/i);
    const raw = text.match(/(https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp)[^\s)"']*)/i);
    const b64 = text.match(/data:(image\/[a-z]+);base64,[A-Za-z0-9+/=]+/i);
    const pick = inline[0] || (md && md[1]) || (b64 && b64[0]) || (raw && raw[1]);
    if (!pick) throw new Error('对话返回里没有图片链接（这个中转可能不是这种形态）');
    return [await toBlob(pick)];
  }

  /* ---------------- 形态三：阿里 DashScope（万相，异步任务） ---------------- */
  async function genDashscope(model, { prompt, count, onStatus }) {
    if (refsWarn(onStatus)) { /* 万相暂不吃参考图 */ }
    const base = String(model.apiBase || '').replace(/\/+$/, '');
    onStatus && onStatus('提交云端任务…');
    const sub = await call(base + '/api/v1/services/aigc/text2image/image-synthesis', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (model.apiKey || ''),
        'X-DashScope-Async': 'enable'
      },
      body: JSON.stringify({
        model: model.apiModel,
        input: { prompt },
        parameters: { n: count || 1, size: (model.size || '1024*1024').replace('x', '*') }
      })
    });
    const taskId = sub && sub.output && sub.output.task_id;
    if (!taskId) throw new Error('万相任务提交失败：' + JSON.stringify(sub).slice(0, 200));
    return await poll({
      onStatus,
      fetchOnce: async () => {
        const t = await call(base + '/api/v1/tasks/' + taskId, {
          headers: { Authorization: 'Bearer ' + (model.apiKey || '') }
        });
        const st = t && t.output && t.output.task_status;
        if (st === 'SUCCEEDED') {
          const urls = ((t.output.results || [])).map(r => r.url).filter(Boolean);
          if (!urls.length) throw new Error('万相任务成功但没返回图片');
          const out = [];
          for (const u of urls) out.push(await toBlob(u));
          return out;
        }
        if (st === 'FAILED' || st === 'CANCELED' || st === 'UNKNOWN') {
          throw new Error('万相任务失败：' + ((t.output && t.output.message) || st));
        }
        return null;   // 还在跑
      }
    });
  }

  /* ---------------- 形态四：BFL Flux（异步任务） ---------------- */
  async function genBfl(model, { prompt, onStatus }) {
    const base = String(model.apiBase || '').replace(/\/+$/, '');
    onStatus && onStatus('提交云端任务…');
    const j = await call(base + '/' + (model.apiModel || 'flux-pro-1.1'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-key': model.apiKey || '', accept: 'application/json' },
      body: JSON.stringify({ prompt, width: 1024, height: 1024 })
    });
    const id = j && j.id;
    if (!id) throw new Error('Flux 任务提交失败：' + JSON.stringify(j).slice(0, 200));
    return await poll({
      onStatus,
      fetchOnce: async () => {
        const r = await call(base + '/get_result?id=' + encodeURIComponent(id), {
          headers: { 'x-key': model.apiKey || '', accept: 'application/json' }
        });
        if (r.status === 'Ready') {
          const url = r.result && r.result.sample;
          if (!url) throw new Error('Flux 任务成功但没返回图片');
          return [await toBlob(url)];
        }
        if (r.status === 'Error' || r.status === 'Content Moderated') {
          throw new Error('Flux 任务失败：' + r.status);
        }
        return null;
      }
    });
  }

  /* ---------------- 形态五：Google Imagen（:predict，同步 base64） ---------------- */
  async function genGoogle(model, { prompt, count, onStatus }) {
    const base = String(model.apiBase || '').replace(/\/+$/, '');
    onStatus && onStatus('云端生成中…');
    const j = await call(base + '/models/' + (model.apiModel || 'imagen-4.0-generate-001') + ':predict?key=' + encodeURIComponent(model.apiKey || ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: count || 1 } })
    });
    const out = [];
    for (const p of (j && j.predictions) || []) {
      if (p.bytesBase64Encoded) out.push(await toBlob(dataURLof(p.bytesBase64Encoded)));
      else if (p.gcsUri) throw new Error('Imagen 返回了 GCS 地址，浏览器拿不到（改用支持 base64 的模型版本）');
    }
    if (!out.length) throw new Error('Imagen 返回里没有图片');
    return out;
  }

  function refsWarn(onStatus) {
    onStatus && onStatus('这个云端模型暂不支持参考图，参考图将被忽略');
    return true;
  }

  /** 轮询骨架：每 3 秒问一次，最长 5 分钟 */
  async function poll({ fetchOnce, onStatus, intervalMs = 3000, maxMs = 5 * 60 * 1000 }) {
    const t0 = Date.now();
    let n = 0;
    while (Date.now() - t0 < maxMs) {
      await new Promise(ok => setTimeout(ok, n === 0 ? 1200 : intervalMs));
      n++;
      onStatus && onStatus(`云端任务运行中…（${Math.round((Date.now() - t0) / 1000)}s）`);
      const r = await fetchOnce();
      if (r) return r;
    }
    throw new Error('云端任务超时（' + Math.round(maxMs / 60000) + ' 分钟），任务可能还在跑，稍后重试');
  }

  /* ---------------- 统一入口 ---------------- */
  /**
   * @param {object} model 模型库里的云端模型记录（apiBase/apiKey/apiModel/shape/size）
   * @param {object} opts  { prompt, negative, count, refs: Blob[], onStatus }
   * @returns {Promise<Blob[]>}
   */
  async function generate(model, opts = {}) {
    const o = { count: 1, refs: [], ...opts };
    switch (model.shape || 'images') {
      case 'chat': return await genChat(model, o);
      case 'dashscope': return await genDashscope(model, o);
      case 'bfl': return await genBfl(model, o);
      case 'google': return await genGoogle(model, o);
      default: return await genImages(model, o);
    }
  }

  /** 模型表单的「测试连接」：能列模型的服务商就拉一次 /models */
  async function testConnection(model) {
    const base = String(model.apiBase || '').replace(/\/+$/, '');
    if (!base || !model.apiModel) throw new Error('先填接口地址和模型名');
    if ((model.shape || 'images') === 'images') {
      try {
        const j = await call(base + '/models', { headers: { Authorization: 'Bearer ' + (model.apiKey || '') } });
        const ids = (j && j.data || []).map(x => x.id);
        if (ids.length && !ids.some(id => String(id).includes(String(model.apiModel).split('/').pop()))) {
          return '连接成功 ✓（注意：模型列表里没看到 ' + model.apiModel + '，确认名字没写错）';
        }
        return '连接成功 ✓';
      } catch (e) {
        // 不少网关不开 /models，连通性没坏 —— 提示用户以实际生成为准
        return '没列出动模型列表（部分网关不支持 /models，不影响使用，以实际生成为准）';
      }
    }
    return '字段完整 ✓（' + (SHAPE_LABEL[model.shape] || model.shape) + ' 不支持 /models 探测，以实际生成为准）';
  }

  return { CLOUD_PRESETS, SHAPE_LABEL, generate, testConnection, presetOf: k => CLOUD_PRESETS.find(p => p.key === k) };
})();
