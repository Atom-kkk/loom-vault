/* ============================================================
   builtin.js — 内置默认工作流
   · 首次启动播种一套开箱即用的「KREA2 CC 人像」工作流（API 格式）
   · 作者：来自 B 站的 古手梨花sama
   · 模型（夸克网盘）：https://pan.quark.cn/s/732e2f9bb6ad
   工作流本身来源 ComfyUI 导出，模型文件需自行下载放入 ComfyUI 对应目录。
   ============================================================ */
/* 注意：v1 的默认工作流用了 rgthree 的 Seed 节点（第三方插件），
   没装插件的人点「生成」会直接 400 missing_node_type。
   v2 改成原生 seed=-1，由 comfy.js 在提交时随机，
   下面 migrate() 会把老用户库里已经播种的那份也一并修掉。 */

window.BUILTIN = (function () {
  'use strict';

  const U = window.U;
  const DB = window.DB;

  const WF_ID = 'builtin-krea2-cc-portrait';
  const WF_NAME = 'KREA2 CC 人像';
  const AUTHOR = "来自 B 站的 古手梨花sama";
  const MODEL_LINK = "https://pan.quark.cn/s/732e2f9bb6ad";
  const API = {"137":{"class_type":"VAEDecode","inputs":{"samples":["158",0],"vae":["167",0]},"_meta":{"title":"VAEDecode"}},"156":{"class_type":"EmptyLatentImage","inputs":{"width":1216,"height":832,"batch_size":1},"_meta":{"title":"EmptyLatentImage"}},"158":{"class_type":"KSampler","inputs":{"model":["347",0],"seed":-1,"steps":10,"cfg":1,"sampler_name":"euler","scheduler":"simple","positive":["164",0],"negative":["173",0],"latent_image":["156",0],"denoise":1},"_meta":{"title":"KSampler"}},"164":{"class_type":"CLIPTextEncode","inputs":{"text":"采用特写镜头从第一人称主观视角斜侧方平视拍摄，机位极近，聚焦于女性鞋尖与鞋底摩擦的动作，浅景深将车窗外流动的街灯光斑虚化为绚丽暗色块，营造车内逼仄而充满反差感的私密张力。车内冷蓝的仪表盘微光与窗外渗入的暖黄路灯交织，侧逆光沿她薄透的丝袜边缘与黑色漆皮鞋面的反光勾出锐利轮廓，其余区域沉入暗影，整体冷调低明度，氛围暧昧且充满甜美的背德感。\n\n年轻东亚女性，气质甜美纯欲，画面中仅露出她微红的脸颊与狡黠的微笑。黑色长发扎成活泼的双马尾，额前留着空气刘海。甜妹妆容，眼下大面积粉色腮红，唇部涂着水光感十足的蜜桃色唇釉。右小臂内侧有一个精致的红色爱心纹身。\n\nShe wears a white pleated mini skirt, paired with sheer nude pantyhose that faintly reveals the pale skin of her legs, and a pair of black glossy patent leather pointed-toe stiletto heels on her feet. She leans back, extending her leg and pressing the smooth, hard toe box and the glossy sole of her high heel directly against his shaft, her foot arched tightly while her toes remain completely enclosed and hidden within the solid leather tip of the shoe, rubbing the sleek surface up and down in a slow, deliberate rhythm.\n\n狭窄的车厢内部，黑色真皮座椅微陷，中控台按键在暗处泛着冷光。构图采用引导线——从她穿着肉色丝袜的脚踝与紧绷的脚背线条，一路汇聚至漆皮鞋尖与男性接触的焦点，留白空间强化了车内封闭环境与足部特写的视觉张力。","clip":["166",0]},"_meta":{"title":"CLIPTextEncode"}},"166":{"class_type":"CLIPLoader","inputs":{"clip_name":"qwen3vl_4b_bf16.safetensors","type":"krea2","device":"default"},"_meta":{"title":"CLIPLoader"}},"167":{"class_type":"VAELoader","inputs":{"vae_name":"qwen_image_vae.safetensors"},"_meta":{"title":"VAELoader"}},"168":{"class_type":"UNETLoader","inputs":{"unet_name":"Krea2-MuseByStable_v15Turbo_fp8.safetensors","weight_dtype":"default"},"_meta":{"title":"UNETLoader"}},"173":{"class_type":"CLIPTextEncode","inputs":{"text":"马赛克, mosaic, censored, 模糊，低分辨率，低质量图像，扭曲的肢体，诡异的外观，丑陋，噪点，网格感，JPEG压缩条纹，异常的肢体，水印，乱码，意义不明的字符","clip":["166",0]},"_meta":{"title":"负面条件"}},"346":{"class_type":"LoraLoaderModelOnly","inputs":{"model":["168",0],"lora_name":"krea2-Cc-天魔-身材.safetensors","strength_model":0.7},"_meta":{"title":"LoraLoaderModelOnly"}},"347":{"class_type":"LoraLoaderModelOnly","inputs":{"model":["346",0],"lora_name":"krea2-Cc-MJ-风格滤镜.safetensors","strength_model":0.3},"_meta":{"title":"LoraLoaderModelOnly"}},"353":{"class_type":"SaveImage","inputs":{"images":["137",0],"filename_prefix":"Krea2"},"_meta":{"title":"SaveImage"}}};

  const WF_VERSION = 3;

  // 把「指向 rgthree Seed 节点的连线」换成字面量 -1，并删掉该节点
  function stripRgthree(content) {
    let api;
    try { api = JSON.parse(content); } catch { return null; }
    const seedNodes = Object.keys(api).filter(id => api[id] && api[id].class_type === 'Seed (rgthree)');
    if (!seedNodes.length) return null;
    Object.keys(api).forEach(id => {
      const node = api[id];
      if (!node || !node.inputs) return;
      Object.keys(node.inputs).forEach(k => {
        const v = node.inputs[k];
        if (Array.isArray(v) && seedNodes.includes(String(v[0]))) node.inputs[k] = -1;
      });
    });
    seedNodes.forEach(id => { delete api[id]; });
    return JSON.stringify(api);
  }

  // 老库里的内置工作流也修一遍（用户自己改过的提示词不动，只拆 rgthree）
  async function migrate() {
    try {
      const st = await DB.getSettings().catch(() => ({}));
      if ((st.builtinWfVersion || 1) >= WF_VERSION) return;
      const all = (await DB.getAll('workflows')) || [];
      let n = 0;
      for (const wf of all) {
        if (!wf || !wf.content) continue;
        let patched = null;
        if (String(wf.content).indexOf('Seed (rgthree)') >= 0) patched = stripRgthree(wf.content);
        else if (String(wf.content).indexOf('%date:yyyyMMddhhmmss%') >= 0) {
          // A1111 风格的日期占位符，ComfyUI 不认，会原样出现在文件名里
          patched = String(wf.content).split('%date:yyyyMMddhhmmss%').join('');
        }
        if (!patched) continue;
        wf.content = patched;
        wf.size = patched.length;
        try { wf.nodes = Object.keys(JSON.parse(patched)).length; } catch { }
        await DB.put('workflows', wf);
        n++;
      }
      await DB.setSetting('builtinWfVersion', WF_VERSION).catch(() => {});
      if (n) console.log('[内置工作流] 已修复 ' + n + ' 个用到 rgthree 的工作流');
    } catch (e) {
      console.warn('[内置工作流] 迁移失败', e);
    }
  }

  async function seed() {
    try {
      await migrate();
      const st = await DB.getSettings().catch(() => ({}));
      if (st.wfSeeded) return;

      // 老库已有工作流也不重复播种
      const existing = (await DB.getAll('workflows')) || [];
      if (existing.length) {
        await DB.setSetting('wfSeeded', true).catch(() => {});
        return;
      }

      const wf = {
        id: WF_ID,
        name: WF_NAME,
        modelId: '',
        format: 'api-json',
        filename: 'KREA2-CC人像.json',
        size: JSON.stringify(API).length,
        nodes: Object.keys(API).length,
        content: JSON.stringify(API),
        note: AUTHOR + ' · 模型夸克网盘：' + MODEL_LINK,
        builtin: true,
        createdAt: Date.now()
      };
      await DB.put('workflows', wf);

      // 收进简易节点包
      const pack = Array.isArray(st.simplePack) ? st.simplePack : [];
      if (!pack.some(p => p.wfId === WF_ID)) {
        pack.unshift({ wfId: WF_ID, name: WF_NAME, at: Date.now() });
        await DB.setSetting('simplePack', pack.slice(0, 60)).catch(() => {});
      }

      await DB.setSetting('wfSeeded', true).catch(() => {});
      console.log('[内置工作流] 已播种', WF_NAME);
    } catch (e) {
      console.warn('[内置工作流] 播种失败', e);
    }
  }

  return { seed, migrate, name: WF_NAME, author: AUTHOR, modelLink: MODEL_LINK };
})();
