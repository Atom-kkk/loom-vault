/* ============================================================
   builtin.js — 内置默认工作流
   · 首次启动播种开箱即用的内置工作流（API 格式），升级后老用户按版本门槛补种
   · 作者均来自 B 站的 古手梨花sama
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

  /* 内置清单：播种时依次入库。老用户靠 builtinWfVersion 门槛补种新条目
     （since = 引入版本，当前库版本低于它就补一条）。
     modelLink 是作者提供的模型网盘（夸克），展示在工作流卡片备注上。
     槽位标注已在导出前打好（prompt / negative_prompt / seed / size / ref_image_NN），
     其中 Qwen 2.1 编辑总控的 10 个 LoadImage 都是可选参考图位。 */
  const WORKFLOWS = [
    {
      id: 'builtin-krea2-cc-portrait',
      name: 'KREA2 CC 人像',
      filename: 'KREA2-CC人像.json',
      author: '来自 B 站的 古手梨花sama',
      modelLink: 'https://pan.quark.cn/s/732e2f9bb6ad',
      since: 1,
      api: {"137":{"class_type":"VAEDecode","inputs":{"samples":["158",0],"vae":["167",0]},"_meta":{"title":"VAEDecode"}},"156":{"class_type":"EmptyLatentImage","inputs":{"width":1216,"height":832,"batch_size":1},"_meta":{"title":"EmptyLatentImage"}},"158":{"class_type":"KSampler","inputs":{"model":["347",0],"seed":-1,"steps":10,"cfg":1,"sampler_name":"euler","scheduler":"simple","positive":["164",0],"negative":["173",0],"latent_image":["156",0],"denoise":1},"_meta":{"title":"seed"}},"164":{"class_type":"CLIPTextEncode","inputs":{"text":"采用特写镜头从第一人称主观视角斜侧方平视拍摄，机位极近，聚焦于女性鞋尖与鞋底摩擦的动作，浅景深将车窗外流动的街灯光斑虚化为绚丽暗色块，营造车内逼仄而充满反差感的私密张力。车内冷蓝的仪表盘微光与窗外渗入的暖黄路灯交织，侧逆光沿她薄透的丝袜边缘与黑色漆皮鞋面的反光勾出锐利轮廓，其余区域沉入暗影，整体冷调低明度，氛围暧昧且充满甜美的背德感。\n\n年轻东亚女性，气质甜美纯欲，画面中仅露出她微红的脸颊与狡黠的微笑。黑色长发扎成活泼的双马尾，额前留着空气刘海。甜妹妆容，眼下大面积粉色腮红，唇部涂着水光感十足的蜜桃色唇釉。右小臂内侧有一个精致的红色爱心纹身。\n\nShe wears a white pleated mini skirt, paired with sheer nude pantyhose that faintly reveals the pale skin of her legs, and a pair of black glossy patent leather pointed-toe stiletto heels on her feet. She leans back, extending her leg and pressing the smooth, hard toe box and the glossy sole of her high heel directly against his shaft, her foot arched tightly while her toes remain completely enclosed and hidden within the solid leather tip of the shoe, rubbing the sleek surface up and down in a slow, deliberate rhythm.\n\n狭窄的车厢内部，黑色真皮座椅微陷，中控台按键在暗处泛着冷光。构图采用引导线——从她穿着肉色丝袜的脚踝与紧绷的脚背线条，一路汇聚至漆皮鞋尖与男性接触的焦点，留白空间强化了车内封闭环境与足部特写的视觉张力。","clip":["166",0]},"_meta":{"title":"prompt"}},"166":{"class_type":"CLIPLoader","inputs":{"clip_name":"qwen3vl_4b_bf16.safetensors","type":"krea2","device":"default"},"_meta":{"title":"CLIPLoader"}},"167":{"class_type":"VAELoader","inputs":{"vae_name":"qwen_image_vae.safetensors"},"_meta":{"title":"VAELoader"}},"168":{"class_type":"UNETLoader","inputs":{"unet_name":"Krea2-MuseByStable_v15Turbo_fp8.safetensors","weight_dtype":"default"},"_meta":{"title":"UNETLoader"}},"173":{"class_type":"CLIPTextEncode","inputs":{"text":"马赛克, mosaic, censored, 模糊，低分辨率，低质量图像，扭曲的肢体，诡异的外观，丑陋，噪点，网格感，JPEG压缩条纹，异常的肢体，水印，乱码，意义不明的字符","clip":["166",0]},"_meta":{"title":"negative_prompt"}},"346":{"class_type":"LoraLoaderModelOnly","inputs":{"model":["168",0],"lora_name":"krea2-Cc-天魔-身材.safetensors","strength_model":0.7},"_meta":{"title":"LoraLoaderModelOnly"}},"347":{"class_type":"LoraLoaderModelOnly","inputs":{"model":["346",0],"lora_name":"krea2-Cc-MJ-风格滤镜.safetensors","strength_model":0.3},"_meta":{"title":"LoraLoaderModelOnly"}},"353":{"class_type":"SaveImage","inputs":{"images":["137",0],"filename_prefix":"Krea2"},"_meta":{"title":"SaveImage"}}}
    },
    {
      id: 'builtin-qwen21-edit-master',
      name: 'Qwen-Image 2.1 单图/多图编辑总控',
      filename: 'Qwen-Image-2.1-图片编辑总控.json',
      author: '来自 B 站的 古手梨花sama',
      modelLink: 'https://pan.quark.cn/s/0d49a0b21264',
      // 10 个图位：图1 固定是编辑目标，图2~10 按需打开（不连图时提交前会被剔除）
      since: 6,
      api: {"13":{"class_type":"ResolutionSelector","inputs":{"aspect_ratio":"16:9 (Widescreen)","megapixels":1,"multiple":32},"_meta":{"title":"可选 · 自定义尺寸"}},"451":{"class_type":"UNETLoader","inputs":{"unet_name":"qwen_image_2.1_bf16.safetensors","weight_dtype":"default"},"_meta":{"title":"① 加载 Qwen Image 2.1 扩散模型"}},"453":{"class_type":"CLIPLoader","inputs":{"clip_name":"qwen3vl_8b_bf16.safetensors","type":"qwen_image","device":"default"},"_meta":{"title":"② 加载 Qwen3-VL 图文编码器"}},"454":{"class_type":"VAELoader","inputs":{"vae_name":"qwen_image_2.1_vae_bf16.safetensors"},"_meta":{"title":"③ 加载 Qwen Image 2.1 VAE"}},"456":{"class_type":"EmptyLatentImage","inputs":{"width":["13",0],"height":["13",1],"batch_size":1},"_meta":{"title":"自定义尺寸 Latent"}},"457":{"class_type":"VAEDecode","inputs":{"samples":["458",0],"vae":["454",0]},"_meta":{"title":"⑦ VAE 解码"}},"458":{"class_type":"KSampler","inputs":{"model":["469",0],"positive":["474",0],"negative":["474",1],"latent_image":["468",0],"seed":-1,"steps":25,"cfg":1,"sampler_name":"euler","scheduler":"simple","denoise":1},"_meta":{"title":"seed"}},"461":{"class_type":"SaveImage","inputs":{"images":["457",0],"filename_prefix":"Qwen21/编辑总控"},"_meta":{"title":"保存结果 · PNG"}},"468":{"class_type":"ComfySwitchNode","inputs":{"on_false":["474",2],"on_true":["456",0],"switch":false},"_meta":{"title":"custom_size 画布切换"}},"469":{"class_type":"QwenImage21Cache","inputs":{"model":["451",0],"device":"auto","dtype":"default"},"_meta":{"title":"⑤ Qwen 2.1 KV Cache"}},"470":{"class_type":"LoadImage","inputs":{"image":"单视角人物底图-林夏.png"},"_meta":{"title":"ref_image_01"}},"474":{"class_type":"TextEncodeQwenImage21","inputs":{"clip":["453",0],"images.image_1":["470",0],"vae":["454",0],"images.image_4":["478",0],"images.image_5":["479",0],"images.image_6":["480",0],"images.image_7":["481",0],"images.image_8":["482",0],"images.image_9":["483",0],"images.image_10":["484",0],"images.image_2":["475",0],"images.image_3":["477",0],"prompt":"图片1是唯一的人物身份与服装参考。根据图片1制作一张专业动漫人物四视角设定图。\n\n横向画布，从左到右严格排列四个完整全身视图：\n1. 正面\n2. 角色左侧90度侧面\n3. 背面\n4. 角色右侧90度侧面\n\n四个视图必须是同一个成年角色，采用统一的自然A字站姿，双臂稍微离开身体；头顶高度、脚底基线、身体比例和画面缩放完全一致。纯浅灰背景，各视图之间留出均匀空白，不添加文字和视角标签。\n\n严格保持图片1的脸型、年龄、身高、体型、深栗色齐肩短发和左侧长侧发。正确处理所有非对称特征，不能左右镜像或重复：\n- 小痣始终位于角色左眼下方\n- 银色圆环耳坠只在左耳\n- 橙色三角形布章只在角色左上臂\n- 银色链条只在角色右侧裤腰\n- 红色腕表只在右手腕\n\n服装的颜色、裁片、长度、口袋、鞋型与图片1一致。侧面和背面必须按照真实服装结构合理推导，不得简单复制正面，不得出现多余人物、重复肢体、错误朝向、文字、Logo或水印。","negative_prompt":"","resolution":0},"_meta":{"title":"prompt"}},"475":{"class_type":"LoadImage","inputs":{"image":"example.png"},"_meta":{"title":"ref_image_02"}},"477":{"class_type":"LoadImage","inputs":{"image":"example.png"},"_meta":{"title":"ref_image_03"}},"478":{"class_type":"LoadImage","inputs":{"image":"example.png"},"_meta":{"title":"ref_image_04"}},"479":{"class_type":"LoadImage","inputs":{"image":"example.png"},"_meta":{"title":"ref_image_05"}},"480":{"class_type":"LoadImage","inputs":{"image":"example.png"},"_meta":{"title":"ref_image_06"}},"481":{"class_type":"LoadImage","inputs":{"image":"example.png"},"_meta":{"title":"ref_image_07"}},"482":{"class_type":"LoadImage","inputs":{"image":"example.png"},"_meta":{"title":"ref_image_08"}},"483":{"class_type":"LoadImage","inputs":{"image":"example.png"},"_meta":{"title":"ref_image_09"}},"484":{"class_type":"LoadImage","inputs":{"image":"example.png"},"_meta":{"title":"ref_image_10"}}}
    },
    {
      id: 'builtin-moss-image-sft',
      name: 'MOSS-Image SFT 一键加速',
      filename: 'MOSS-Image-SFT-一键加速开关版.json',
      author: '来自 B 站的 古手梨花sama',
      modelLink: 'https://pan.quark.cn/s/e2110229fb8c',
      // 纯文生图：主体提示词 + 固定质量词拼接，开关控制 8 步加速 / 50 步原始
      since: 6,
      api: {"1":{"class_type":"UNETLoader","inputs":{"unet_name":"moss_image_sft_bf16.safetensors","weight_dtype":"default"},"_meta":{"title":"① SFT主模型｜精度自动识别"}},"4":{"class_type":"CLIPTextEncode","inputs":{"clip":["31",0],"text":["42",0]},"_meta":{"title":"正向编码｜自动接收拼接结果"}},"5":{"class_type":"CLIPTextEncode","inputs":{"clip":["31",0],"text":"worst quality, bad anatomy, watermark, jpeg artifact"},"_meta":{"title":"negative_prompt"}},"6":{"class_type":"EmptyFlux2LatentImage","inputs":{"width":1408,"height":1408,"batch_size":1},"_meta":{"title":"size"}},"13":{"class_type":"SkipLayerGuidanceDiTSimple","inputs":{"model":["15",0],"double_layers":"","single_layers":"22","start_percent":0,"end_percent":1},"_meta":{"title":"关闭分支｜官方负向跳层22"}},"15":{"class_type":"ModelSamplingAuraFlow","inputs":{"model":["1",0],"shift":5,"sampling":"flow"},"_meta":{"title":"共用｜MOSS Flow shift 5"}},"16":{"class_type":"KSampler","inputs":{"model":["22",0],"positive":["4",0],"negative":["5",0],"latent_image":["6",0],"steps":["27",0],"cfg":["28",0],"seed":-1,"sampler_name":"euler","scheduler":"sgm_uniform","denoise":1},"_meta":{"title":"seed"}},"17":{"class_type":"VAEDecode","inputs":{"samples":["16",0],"vae":["32",0]},"_meta":{"title":"VAEDecode"}},"18":{"class_type":"SaveImage","inputs":{"images":["17",0],"filename_prefix":"MOSS-Image/SFT_8step_toggle"},"_meta":{"title":"保存图片"}},"20":{"class_type":"PrimitiveBoolean","inputs":{"value":true},"_meta":{"title":"唯一开关｜开启=8步；关闭=50步"}},"21":{"class_type":"LoraLoaderModelOnly","inputs":{"model":["15",0],"lora_name":"moss_image/MOSS-Image-SFT-8steps-DMD_latest.safetensors","strength_model":0.7},"_meta":{"title":"开启分支｜DMD latest，强度0.7"}},"22":{"class_type":"ComfySwitchNode","inputs":{"on_false":["13",0],"on_true":["21",0],"switch":["20",0]},"_meta":{"title":"自动切换模型分支"}},"23":{"class_type":"PrimitiveInt","inputs":{"value":50},"_meta":{"title":"关闭：50步"}},"24":{"class_type":"PrimitiveInt","inputs":{"value":8},"_meta":{"title":"开启：8步"}},"25":{"class_type":"PrimitiveFloat","inputs":{"value":3},"_meta":{"title":"关闭：CFG 3"}},"26":{"class_type":"PrimitiveFloat","inputs":{"value":1},"_meta":{"title":"开启：CFG 1"}},"27":{"class_type":"ComfySwitchNode","inputs":{"on_false":["23",0],"on_true":["24",0],"switch":["20",0]},"_meta":{"title":"自动切换步数"}},"28":{"class_type":"ComfySwitchNode","inputs":{"on_false":["25",0],"on_true":["26",0],"switch":["20",0]},"_meta":{"title":"自动切换CFG"}},"31":{"class_type":"CLIPLoader","inputs":{"clip_name":"qwen3.5_9b_bf16.safetensors","type":"moss_image","device":"default"},"_meta":{"title":"② 文本编码器｜Qwen3.5-9B"}},"32":{"class_type":"VAELoader","inputs":{"vae_name":"flux2-vae.safetensors"},"_meta":{"title":"③ VAE｜FLUX.2 Small Decoder"}},"40":{"class_type":"PrimitiveStringMultiline","inputs":{"value":"best quality, highres"},"_meta":{"title":"固定质量词｜通常无需修改"}},"41":{"class_type":"PrimitiveStringMultiline","inputs":{"value":"{\"summary\":{\"canvas\":\"multi_panel\",\"caption\":\"A full-color Japanese anime comedy manga with expressive clean linework, soft cel shading, warm afternoon light and playful facial acting. Exactly four rectangular panels in a two-by-two grid, read top-left, top-right, bottom-left, bottom-right, with white gutters and thin black borders. Aemeath (爱弥斯) and Denia (达妮娅) from Wuthering Waves argue affectionately over the last slice of strawberry cake at a cafe table. Aemeath has very long pink hair, amber eyes and her recognizable white futuristic outfit and hair ornaments. Denia has pale hair shading into pink and lavender with blue inner strands, blue eyes, her recognizable black-and-white outfit and red gloves. Keep their official hairstyles, accessories and outfit designs consistent. Aemeath stays on the left and Denia on the right in every panel. Each panel contains these two characters and two white speech balloons with black Chinese lettering, with tails clearly pointing to the correct speaker. The only lettering is the eight supplied dialogue lines.\"},\"items\":[{\"label\":\"object\",\"caption\":\"Top-left panel: an eye-level medium two-shot at a sunny cafe table. One untouched strawberry cake slice sits on a small white plate between the pair. Soft window light and a blurred cafe interior.\",\"bbox\":[-680,-680,-16,-16]},{\"label\":\"character\",\"caption\":\"Top-left panel, Aemeath on the left: smiling triumphantly, leaning toward the cake, holding her fork poised above it.\",\"bbox\":[-494,-656,-58,-364]},{\"label\":\"character\",\"caption\":\"Top-left panel, Denia on the right: one eyebrow raised, an amused sideways glance at Aemeath, calmly holding up three red-gloved fingers.\",\"bbox\":[-494,-344,-58,-40]},{\"label\":\"text\",\"caption\":\"Top-left panel, upper-left rounded speech balloon, tail to Aemeath on the left, large readable Chinese lettering.\",\"text\":\"最后一块，归我啦！\",\"bbox\":[-656,-656,-526,-350]},{\"label\":\"text\",\"caption\":\"Top-left panel, upper-right rounded speech balloon, tail to Denia on the right, large readable Chinese lettering.\",\"text\":\"你已经吃了三块。\",\"bbox\":[-640,-324,-510,-44]},{\"label\":\"object\",\"caption\":\"Top-right panel: a slightly closer two-shot across the same cafe table. The untouched cake remains between them. Warm rim light catches their hair.\",\"bbox\":[-680,16,-16,680]},{\"label\":\"character\",\"caption\":\"Top-right panel, Aemeath on the left: sitting proudly upright, free hand on her chest, sparkling eyes and an exaggerated heroic grin; her fork remains in her other hand.\",\"bbox\":[-484,40,-54,336]},{\"label\":\"character\",\"caption\":\"Top-right panel, Denia on the right: chin resting on one red-gloved hand, half-lidded eyes and a tiny teasing smile aimed at Aemeath.\",\"bbox\":[-484,356,-54,656]},{\"label\":\"text\",\"caption\":\"Top-right panel, upper-left speech balloon, tail to Aemeath, large readable Chinese lettering.\",\"text\":\"英雄需要补充能量！\",\"bbox\":[-656,40,-512,342]},{\"label\":\"text\",\"caption\":\"Top-right panel, upper-right speech balloon, tail to Denia, large readable Chinese lettering.\",\"text\":\"抢蛋糕也算拯救世界？\",\"bbox\":[-640,366,-496,656]},{\"label\":\"object\",\"caption\":\"Bottom-left panel: a low tabletop-angle two-shot emphasizing a second fork entering toward the last cake slice from Denia's side. Both faces remain visible above the plate. The sunny cafe background is continuous.\",\"bbox\":[16,-680,680,-16]},{\"label\":\"character\",\"caption\":\"Bottom-left panel, Aemeath on the left: pointing at Denia's approaching fork with her free hand, eyes widened in indignant surprise, mouth open mid-retort.\",\"bbox\":[220,-656,640,-364]},{\"label\":\"character\",\"caption\":\"Bottom-left panel, Denia on the right: extending her fork toward the cake with a red-gloved hand, maintaining a serenely innocent smile and looking at Aemeath.\",\"bbox\":[220,-344,640,-40]},{\"label\":\"text\",\"caption\":\"Bottom-left panel, upper-left speech balloon, tail to Aemeath, large readable Chinese lettering.\",\"text\":\"那你为什么拿叉子？\",\"bbox\":[40,-656,184,-350]},{\"label\":\"text\",\"caption\":\"Bottom-left panel, upper-right speech balloon, tail to Denia, large readable Chinese lettering.\",\"text\":\"我这是替你分担。\",\"bbox\":[56,-324,200,-44]},{\"label\":\"object\",\"caption\":\"Bottom-right panel: comic punchline, tight two-shot with simplified warm cafe colors. Both forks have pierced opposite edges of the same remaining cake slice, stretching its cream slightly as the two girls pull gently in opposite directions. The plate stays on the table. Small drawn tension marks emphasize the harmless standoff.\",\"bbox\":[16,16,680,680]},{\"label\":\"character\",\"caption\":\"Bottom-right panel, Aemeath on the left: puffed cheeks, furrowed brows and a competitive pout, leaning forward and gripping her fork while staring at Denia.\",\"bbox\":[230,40,644,336]},{\"label\":\"character\",\"caption\":\"Bottom-right panel, Denia on the right: a smug closed-mouth smile, narrowed playful eyes, red-gloved hand firmly gripping her fork, looking directly at Aemeath.\",\"bbox\":[230,356,644,656]},{\"label\":\"text\",\"caption\":\"Bottom-right panel, upper-left jagged speech balloon, tail to Aemeath, bold readable Chinese lettering.\",\"text\":\"你倒是松手啊！\",\"bbox\":[40,40,184,342]},{\"label\":\"text\",\"caption\":\"Bottom-right panel, upper-right small rounded speech balloon, tail to Denia, large readable Chinese lettering.\",\"text\":\"你先。\",\"bbox\":[76,416,196,616]}],\"bbox_coord_space\":\"abs_centralized\",\"bbox_format\":\"yxyx\"}\n"},"_meta":{"title":"prompt"}},"42":{"class_type":"StringConcatenate","inputs":{"string_a":["40",0],"string_b":["41",0],"delimiter":", "},"_meta":{"title":"固定质量词 + 主体提示词"}}}
    }
  ];

  // 当前内置清单版本：老库 builtinWfVersion 低于它就触发补种 / 迁移
  const WF_VERSION = 6;

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

  // 内置工作流里哪几个节点是「槽位」（改了标题，UI 就能按槽位长）
  // 156 是 EmptyLatentImage，宽高都在它身上 —— 标一个 size 就等于同时暴露宽和高。
  const SLOT_TITLES = { '164': 'prompt', '173': 'negative_prompt', '158': 'seed', '156': 'size' };

  /** 只给内置工作流补标注：用户自己传的工作流一概不碰 */
  function annotateBuiltin(content) {
    let api;
    try { api = JSON.parse(content); } catch { return null; }
    if (!api || Array.isArray(api.nodes)) return null;
    let changed = 0;
    Object.keys(SLOT_TITLES).forEach(id => {
      const node = api[id];
      if (!node) return;
      node._meta = node._meta || {};
      if (node._meta.title !== SLOT_TITLES[id]) {
        node._meta.title = SLOT_TITLES[id];
        changed++;
      }
    });
    return changed ? JSON.stringify(api) : null;
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
        // 内置工作流补槽位标注（只认我们自己播种的那条，别人的工作流不动）
        else if (wf.id === 'builtin-krea2-cc-portrait') patched = annotateBuiltin(wf.content);
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

  /** 入库一条内置工作流（播种和补种共用） */
  async function putWorkflow(def) {
    // 初代 KREA2 播种时补槽位标注（新条目导出前就标好了，无需再改）
    let content;
    if (def.id === 'builtin-krea2-cc-portrait') {
      const raw = JSON.stringify(def.api);
      content = annotateBuiltin(raw) || raw;
    } else {
      content = JSON.stringify(def.api);
    }
    const wf = {
      id: def.id,
      name: def.name,
      modelId: '',
      format: 'api-json',
      filename: def.filename,
      size: content.length,
      nodes: Object.keys(def.api).length,
      content: content,
      note: def.author + ' · 模型夸克网盘：' + def.modelLink,
      builtin: true,
      createdAt: Date.now()
    };
    await DB.put('workflows', wf);

    // 收进简易节点包（settings 现取：循环里连续播种时不能拿过期快照，会互相覆盖）
    const st = await DB.getSettings().catch(() => ({}));
    const pack = Array.isArray(st.simplePack) ? st.simplePack : [];
    if (!pack.some(p => p.wfId === def.id)) {
      pack.unshift({ wfId: def.id, name: def.name, at: Date.now() });
      await DB.setSetting('simplePack', pack.slice(0, 60)).catch(() => {});
    }
  }

  /**
   * 老库里没有的内置工作流补种（按 since 门槛）。
   * 必须在 migrate() 之前跑：migrate 会把 builtinWfVersion 推到最新，
   * 推完门槛就再也进不来了。
   */
  async function backfill() {
    const st = await DB.getSettings().catch(() => ({}));
    const libVer = st.builtinWfVersion || 1;
    if (libVer >= WF_VERSION) return 0;

    const existing = (await DB.getAll('workflows')) || [];
    const have = new Set(existing.map(w => w && w.id).filter(Boolean));
    // 用户主动删过的内置不复活（删除时 manage.js 记进 wfBuiltinDismissed）
    const dismissed = Array.isArray(st.wfBuiltinDismissed) ? st.wfBuiltinDismissed : [];
    let seeded = 0;

    for (const def of WORKFLOWS) {
      if (def.since <= libVer) continue;       // 库版本已经见过的条目不补
      if (have.has(def.id)) continue;
      if (dismissed.includes(def.id)) continue;

      await putWorkflow(def);
      seeded++;
      console.log('[内置工作流] 补种', def.name);
    }
    return seeded;
  }

  async function seed() {
    try {
      const st = await DB.getSettings().catch(() => ({}));
      const existing = (await DB.getAll('workflows')) || [];
      // 全新用户：没播种过且库里什么都没有 → 全清单一起播
      const firstRun = !st.wfSeeded && !existing.length;

      // ① 老用户：按「升级前」的版本门槛补种（要在 migrate 推高版本之前）
      if (!firstRun) await backfill();

      // ② 迁移旧库（rgthree / 占位符 / 槽位标注），推高 builtinWfVersion
      await migrate();

      // ③ 全新用户播种完整清单
      if (firstRun) {
        for (const def of WORKFLOWS) {
          if (def.since > WF_VERSION) continue;   // 未启用的条目
          await putWorkflow(def);
        }
        await DB.setSetting('wfSeeded', true).catch(() => {});
        console.log('[内置工作流] 已播种', WORKFLOWS.map(w => w.name).join('、'));
      }
    } catch (e) {
      console.warn('[内置工作流] 播种失败', e);
    }
  }

  return {
    seed, migrate, backfill,
    list: () => WORKFLOWS.map(w => ({ id: w.id, name: w.name, author: w.author, modelLink: w.modelLink })),
    name: WORKFLOWS[0].name, author: WORKFLOWS[0].author, modelLink: WORKFLOWS[0].modelLink
  };
})();
