/* ============================================================
   parse.js — 图片元数据解析 + 缩略图
   目标：把「自己出的图」里已经烧进去的参数读出来
   · A1111 / Forge   → tEXt:parameters
   · ComfyUI         → tEXt:prompt (API JSON) + tEXt:workflow
   · NovelAI         → tEXt:Comment (JSON)
   · Fooocus / 其他  → tEXt/json
   ============================================================ */

window.Parse = (function () {

  /* ---------------- PNG chunk ---------------- */
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  function isPng(bytes) {
    if (bytes.length < 8) return false;
    return SIG.every((v, i) => bytes[i] === v);
  }

  async function inflateZlib(bytes) {
    if (typeof DecompressionStream === 'undefined') return '';
    try {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return await new Response(stream).text();
    } catch { return ''; }
  }

  async function readPngText(buf) {
    const bytes = new Uint8Array(buf);
    if (!isPng(bytes)) return {};
    const dv = new DataView(buf);
    const latin = new TextDecoder('latin1');
    const utf8 = new TextDecoder('utf-8');
    const out = {};
    let off = 8, guard = 0;

    while (off + 8 <= bytes.length && guard++ < 4000) {
      const len = dv.getUint32(off);
      const type = latin.decode(bytes.subarray(off + 4, off + 8));
      const start = off + 8;
      if (start + len > bytes.length) break;

      try {
        if (type === 'tEXt') {
          const data = bytes.subarray(start, start + len);
          const z = data.indexOf(0);
          if (z > 0) out[latin.decode(data.subarray(0, z))] = utf8.decode(data.subarray(z + 1));
        } else if (type === 'iTXt') {
          const data = bytes.subarray(start, start + len);
          const z = data.indexOf(0);
          if (z > 0) {
            const key = latin.decode(data.subarray(0, z));
            const flag = data[z + 1];
            let p = z + 3;
            const z2 = data.indexOf(0, p);           // language tag
            p = z2 >= 0 ? z2 + 1 : p;
            const z3 = data.indexOf(0, p);           // translated keyword
            p = z3 >= 0 ? z3 + 1 : p;
            const textBytes = data.subarray(p);
            out[key] = flag === 1 ? await inflateZlib(textBytes) : utf8.decode(textBytes);
          }
        } else if (type === 'zTXt') {
          const data = bytes.subarray(start, start + len);
          const z = data.indexOf(0);
          if (z > 0) {
            const key = latin.decode(data.subarray(0, z));
            out[key] = await inflateZlib(data.subarray(z + 2));
          }
        }
      } catch { /* 单个 chunk 坏掉不影响整体 */ }

      off = start + len + 4;
      if (type === 'IEND') break;
    }
    return out;
  }

  /* ---------------- A1111 参数串 ---------------- */
  function splitParams(line) {
    const out = {};
    const re = /([A-Za-z][A-Za-z0-9 _\-/]*):\s*("(?:[^"\\]|\\.)*"|[^,]*)(?:,\s*|$)/g;
    let m;
    while ((m = re.exec(line))) {
      let k = m[1].trim();
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      out[k] = v;
    }
    return out;
  }

  function parseA1111(raw) {
    const text = String(raw).replace(/\r\n/g, '\n').trim();
    if (!text) return null;

    const lines = text.split('\n');
    let paramLine = '';
    let bodyEnd = lines.length;

    // 参数行：从尾部找形如 "Steps: 20, Sampler: ..." 的行
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 12; i--) {
      if (/^\s*Steps:\s*\d/i.test(lines[i])) { paramLine = lines[i]; bodyEnd = i; break; }
    }

    let body = lines.slice(0, bodyEnd).join('\n');
    let negative = '';
    const negIdx = body.search(/(^|\n)\s*Negative prompt:\s*/i);
    if (negIdx >= 0) {
      const m = body.match(/(^|\n)\s*Negative prompt:\s*/i);
      const cut = negIdx + (m[1] ? 1 : 0) + m[0].replace(/^\n/, '').length;
      negative = body.slice(cut).trim();
      body = body.slice(0, negIdx).trim();
    }

    const p = paramLine ? splitParams(paramLine) : {};
    const size = (p['Size'] || '').match(/^(\d+)\s*x\s*(\d+)$/);

    const loras = [];
    const lh = p['Lora hashes'] || '';
    if (lh) {
      lh.split(',').forEach(seg => {
        const [n, h] = seg.split(':').map(s => s.trim());
        if (n) loras.push({ name: n, hash: h || '' });
      });
    }

    return {
      source: 'a1111',
      positive: body.trim(),
      negative,
      model: p['Model'] || '',
      modelHash: p['Model hash'] || '',
      vae: p['VAE'] || p['VAE hash'] || '',
      sampler: p['Sampler'] || '',
      scheduler: p['Schedule type'] || p['Scheduler'] || '',
      steps: p['Steps'] ? Number(p['Steps']) : null,
      cfg: p['CFG scale'] !== undefined ? Number(p['CFG scale']) : null,
      seed: p['Seed'] ? String(p['Seed']) : '',
      width: size ? Number(size[1]) : null,
      height: size ? Number(size[2]) : null,
      clipSkip: p['Clip skip'] ? Number(p['Clip skip']) : null,
      denoise: p['Denoising strength'] !== undefined ? Number(p['Denoising strength']) : null,
      loras,
      rawParams: p
    };
  }

  /* ---------------- ComfyUI ---------------- */
  function comfyNodeText(prompt, ref, depth = 0) {
    if (!ref || depth > 8) return '';
    const id = Array.isArray(ref) ? ref[0] : ref;
    const node = prompt[id];
    if (!node) return '';
    const inp = node.inputs || {};
    if (typeof inp.text === 'string') {
      // 处理 "字符串拼接 / 动态提示词" 节点
      let t = inp.text;
      if (Array.isArray(inp.text) || typeof inp.text === 'object') return '';
      // 若该文本节点还引用了别的文本（如 CLIPTextEncode 接 string 节点）
      return t;
    }
    if (typeof inp.string === 'string') return inp.string;
    if (typeof inp.value === 'string') return inp.value;
    if (Array.isArray(inp.text)) return comfyNodeText(prompt, inp.text, depth + 1);
    for (const k of ['text_g', 'text_l', 'prompt', 'positive', 'conditioning']) {
      if (inp[k]) {
        const t = comfyNodeText(prompt, inp[k], depth + 1);
        if (t) return t;
      }
    }
    return '';
  }

  function parseComfy(promptRaw, workflowRaw) {
    let prompt = null;
    try { prompt = typeof promptRaw === 'string' ? JSON.parse(promptRaw) : promptRaw; } catch { }
    if (!prompt || typeof prompt !== 'object') return null;

    const nodes = Object.entries(prompt).filter(([, n]) => n && n.class_type);
    if (!nodes.length) return null;

    const find = type => nodes.filter(([, n]) => n.class_type === type).map(([, n]) => n);
    const ks = find('KSampler')[0] || find('KSamplerAdvanced')[0] || find('SamplerCustom')[0];

    let positive = '', negative = '';
    if (ks) {
      positive = comfyNodeText(prompt, ks.inputs.positive);
      negative = comfyNodeText(prompt, ks.inputs.negative);
    }
    if (!positive) {
      const enc = nodes.filter(([, n]) => /CLIPTextEncode/i.test(n.class_type));
      const texts = enc.map(([, n]) => comfyNodeText(prompt, [Object.keys(prompt).find(k => prompt[k] === n), 0]) || n.inputs?.text || '');
      positive = texts[0] || '';
      negative = negative || texts[1] || '';
    }

    const ckpt = find('CheckpointLoaderSimple')[0] || find('CheckpointLoader')[0] || find('UNETLoader')[0];
    const model = ckpt?.inputs?.ckpt_name || ckpt?.inputs?.unet_name || '';

    const loras = find('LoraLoader').map(n => ({
      name: n.inputs?.lora_name || '',
      strength: n.inputs?.strength_model ?? n.inputs?.strength ?? null
    })).filter(l => l.name);

    const latent = find('EmptyLatentImage')[0] || find('EmptySD3LatentImage')[0];

    let workflowName = '';
    try {
      const wf = typeof workflowRaw === 'string' ? JSON.parse(workflowRaw) : workflowRaw;
      workflowName = wf?.extra?.ds?.filename_prefix || '';
    } catch { }

    return {
      source: 'comfyui',
      positive, negative,
      model,
      loras,
      sampler: ks?.inputs?.sampler_name || '',
      scheduler: ks?.inputs?.scheduler || '',
      steps: ks?.inputs?.steps ?? null,
      cfg: ks?.inputs?.cfg ?? null,
      seed: ks?.inputs?.seed != null ? String(ks.inputs.seed) : (ks?.inputs?.noise_seed != null ? String(ks.inputs.noise_seed) : ''),
      denoise: ks?.inputs?.denoise ?? null,
      width: latent?.inputs?.width ?? null,
      height: latent?.inputs?.height ?? null,
      clipSkip: null,
      workflowName,
      comfyPrompt: prompt,
      comfyWorkflow: workflowRaw || null
    };
  }

  /* ---------------- NovelAI ---------------- */
  function parseNovelAI(commentRaw) {
    let j;
    try { j = JSON.parse(commentRaw); } catch { return null; }
    if (!j || typeof j !== 'object') return null;
    if (!j.prompt && !j.uc) return null;
    return {
      source: 'novelai',
      positive: j.prompt || '',
      negative: j.uc || '',
      model: j.model || '',
      sampler: j.sampler || '',
      scheduler: j.noise_schedule || '',
      steps: j.steps ?? null,
      cfg: j.scale ?? null,
      seed: j.seed != null ? String(j.seed) : '',
      width: j.width ?? null,
      height: j.height ?? null,
      loras: []
    };
  }

  /* ---------------- 统一入口 ---------------- */
  async function readMeta(file) {
    const result = { width: null, height: null, info: null, raw: {}, software: '' };
    try {
      const head = await file.slice(0, 64).arrayBuffer();
      const bytes = new Uint8Array(head);
      const isJ = bytes[0] === 0xFF && bytes[1] === 0xD8;
      const isW = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57; // RIFF....WEBP

      if (isPng(bytes)) {
        const texts = await readPngText(await file.arrayBuffer());
        result.raw = texts;

        if (texts.parameters) result.info = parseA1111(texts.parameters);
        else if (texts.prompt) result.info = parseComfy(texts.prompt, texts.workflow);
        else if (texts.Comment) result.info = parseNovelAI(texts.Comment);
        else if (texts.Description || texts.description) {
          result.info = { source: 'text', positive: texts.Description || texts.description, negative: '', loras: [] };
        }
        result.software = texts.Software || texts.software || '';
      } else if (isJ || isW) {
        // JPEG / WebP 的 EXIF/XMP 读取成本高，先只取尺寸与无损文本
        result.software = isJ ? 'JPEG' : 'WebP';
      }
    } catch (e) {
      console.warn('元数据解析失败', e);
    }

    // 读取真实尺寸
    try {
      const bmp = await createImageBitmap(file);
      result.width = bmp.width;
      result.height = bmp.height;
      bmp.close?.();
    } catch { }

    if (result.info) {
      if (!result.info.width) result.info.width = result.width;
      if (!result.info.height) result.info.height = result.height;
    }
    return result;
  }

  /* ---------------- 缩略图 ---------------- */
  async function makeThumb(file, maxEdge = 640, quality = 0.82) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close?.();

      const blob = await new Promise(res => {
        canvas.toBlob(b => res(b), 'image/webp', quality);
      });
      return blob || await new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', quality));
    } catch {
      return file;
    }
  }

  /* ---------------- 生成参数的文本快照 ---------------- */
  function paramsSnapshot(img) {
    const lines = [];
    if (img.modelName) lines.push('Model: ' + img.modelName);
    if (img.sampler) lines.push('Sampler: ' + img.sampler + (img.scheduler ? ' ' + img.scheduler : ''));
    if (img.steps != null) lines.push('Steps: ' + img.steps);
    if (img.cfg != null) lines.push('CFG scale: ' + img.cfg);
    if (img.seed) lines.push('Seed: ' + img.seed);
    if (img.width && img.height) lines.push('Size: ' + img.width + 'x' + img.height);
    if (img.loraNames?.length) lines.push('LoRA: ' + img.loraNames.join(', '));
    return lines.join('\n');
  }

  return { readMeta, makeThumb, parseA1111, parseComfy, paramsSnapshot, readPngText };
})();
