/* ============================================================
   ai.js — 多服务商 + 智能体
   · 服务商 Provider：一个 OpenAI 兼容接口端点（DeepSeek / 智谱 / 本地 Ollama…）
   · 智能体 Agent  ：服务商 + 模型 + 系统提示词 + 温度 = 一套「人设」
   出图时按智能体生成；结果只追加新版本，绝不覆盖旧提示词。
   ============================================================ */

window.AI = (function () {
  'use strict';

  /* ============================================================
     服务商预设
     ============================================================ */
  const PROVIDER_PRESETS = [
    {
      key: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      needKey: true,
      hint: '在 platform.deepseek.com 申请 Key，按 token 计费'
    },
    {
      key: 'zhipu',
      label: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air', 'glm-4v-plus'],
      needKey: true,
      hint: 'open.bigmodel.cn 申请 Key；glm-4v-plus 支持看图'
    },
    {
      key: 'ollama',
      label: '本地 Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b', 'gemma2:9b'],
      needKey: false,
      hint: '先跑 ollama serve；跨域需设 OLLAMA_ORIGINS=*'
    },
    {
      key: 'lmstudio',
      label: 'LM Studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      models: [],
      needKey: false,
      hint: '启动 Local Server（默认 1234 端口）后在开发者设置里打开 CORS'
    },
    {
      key: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
      needKey: true,
      hint: '填 sk- 开头的 Key 即可，接口按 OpenAI 协议'
    },
    {
      key: 'custom',
      label: '自定义接口',
      baseUrl: '',
      models: [],
      needKey: false,
      hint: '任何 OpenAI 兼容接口：vLLM / OneAPI / 自建网关都行'
    }
  ];

  const presetOf = key => PROVIDER_PRESETS.find(p => p.key === key) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];

  /* ============================================================
     智能体预设（六套人设）
     ============================================================ */
  const AGENT_PRESETS = [
    {
      key: 'engineer',
      name: '提示词工程师',
      brief: '结构化英文提示词：主体→细节→服装材质→姿态→镜头→光线→画质',
      temperature: 0.9,
      systemPrompt:
        '你是一位资深 AI 绘画提示词工程师。你的输出只包含提示词正文：' +
        '用英文撰写，逗号分隔的短语，按「主体 → 外观细节 → 服装/材质 → 姿态表情 → 镜头与构图 → 光线 → 画质词」的顺序排列，' +
        '不写解释、不加标题、不用引号、不用代码块、不输出负面提示词。'
    },
    {
      key: 'minimal',
      name: '极简派',
      brief: '只留对画面影响最大的要素，40 词以内，不堆画质词',
      temperature: 0.8,
      systemPrompt:
        '你写极简的 AI 绘画提示词。规则：英文、逗号分隔、不超过 40 个词；' +
        '只保留主体、动作、环境、光线这四类信息；删掉所有画质词（masterpiece、8k、best quality 等）与重复修饰。' +
        '直接输出提示词正文，不要任何解释。'
    },
    {
      key: 'photo',
      name: '写实摄影',
      brief: '强调机身镜头、焦段、光圈、胶片质感与现场光',
      temperature: 1.0,
      systemPrompt:
        '你是一位商业摄影指导，专门写写实摄影风格的 AI 提示词。' +
        '输出英文逗号短语，必须包含：具体机位与镜头焦段（如 35mm/85mm/135mm）、光圈与景深、' +
        '现场光描述（窗光、霓虹、硬光/柔光）、材质与皮肤质感、以及一种胶片或色彩科学（如 Kodak Portra 400、cinematic teal-orange）。' +
        '避免夸张画质词。只输出提示词正文。'
    },
    {
      key: 'anime',
      name: '二次元绘师',
      brief: 'danbooru 标签流，质量词前置，适配 SD / NAI',
      temperature: 1.0,
      systemPrompt:
        '你写二次元插画的 AI 提示词，风格接近 danbooru 标签体系。' +
        '输出英文逗号标签，质量词前置（masterpiece, best quality, intricate details），' +
        '然后依次写：角色数量与性别、发型发色、瞳色、服装与配饰、表情、姿势、构图与镜头、背景、光影。' +
        '标签之间用逗号加空格分隔，不要写成自然语言句子。只输出标签串。'
    },
    {
      key: 'negative',
      name: '负面词专家',
      brief: '按正向提示词反推配套负面词，分组覆盖常见缺陷',
      temperature: 0.7,
      systemPrompt:
        '你是负面提示词专家。根据给到的正向提示词，输出一条配套的英文负面提示词。' +
        '覆盖：低质量与模糊、解剖与手部错误、多余肢体、文字与水印、logo、压缩噪点、' +
        '以及与该画风冲突的要素。用逗号分隔，不要重复正向词，不要解释。'
    },
    {
      key: 'translator',
      name: '中英转换',
      brief: '中文描述转专业英文提示词，按提示词惯例重排而非直译',
      temperature: 0.7,
      systemPrompt:
        '你是中英提示词翻译专家。把中文画面描述转换成专业的英文 AI 绘画提示词。' +
        '不要逐字直译，要按提示词惯例重排语序、补齐必要的英文惯用表达（如材质、光线、镜头）。' +
        '只输出英文提示词正文，不要中文解释。'
    }
  ];

  /* ============================================================
     状态
     ============================================================ */
  const store = {
    providers: [],
    agents: [],
    lastAgentId: ''
  };

  const uid = p => U.uid(p);

  /* ---------------- 默认数据 ---------------- */
  function defaultProvider(key = 'deepseek', over = {}) {
    const p = presetOf(key);
    return {
      id: uid('prv'),
      key: p.key,
      name: p.label,
      baseUrl: p.baseUrl,
      apiKey: '',
      models: [...p.models],
      createdAt: Date.now(),
      ...over
    };
  }

  function defaultAgents(providerId) {
    return AGENT_PRESETS.map((a, i) => ({
      id: uid('agt'),
      key: a.key,
      name: a.name,
      brief: a.brief,
      providerId,
      model: '',
      temperature: a.temperature,
      systemPrompt: a.systemPrompt,
      createdAt: Date.now() + i
    }));
  }

  const DEFAULT_MODES = {
    refine: {
      label: '润色细化',
      tip: '保留原意，补足材质、光线、镜头等细节',
      build: c => `在保持原有主体与风格不变的前提下润色下面这条提示词，补足材质、光线、镜头与画质细节，让画面更可控：\n\n${c.prompt}`
    },
    variant: {
      label: '同风格变体',
      tip: '同一主体，换构图与氛围',
      build: c => `以这条提示词的主体与风格为基准，生成 ${c.count || 3} 条差异明显的变体（换构图、光线、镜头或氛围，主体不变）。每条之间用单独一行 "---" 分隔，不要编号：\n\n${c.prompt}`
    },
    expand: {
      label: '扩写',
      tip: '一句话扩成完整提示词',
      build: c => `把下面这段简短的描述扩写成一条完整的、可直接用于文生图模型的英文提示词：\n\n${c.prompt}`
    },
    style: {
      label: '换风格',
      tip: '换画风但保留主体',
      build: c => `保留主体内容，把画风改成「${c.style || '电影感写实摄影'}」，重写这条提示词：\n\n${c.prompt}`
    },
    translate: {
      label: '中译英',
      tip: '中文描述转英文提示词',
      build: c => `把下面的中文描述转换成专业的英文文生图提示词，不要逐字直译，按提示词惯例组织：\n\n${c.prompt}`
    },
    fromParams: {
      label: '按参数反推',
      tip: '只有模型/参数时，反推可复用的提示词',
      build: c => `我有一张图，已知生成参数如下。请反推一条最可能生成该效果的英文提示词。\n\n${c.prompt}`
    },
    shorten: {
      label: '精简',
      tip: '压到 40 词以内',
      build: c => `把这条提示词精简到 40 个英文词以内，只保留对画面影响最大的要素，其余删掉：\n\n${c.prompt}`
    },
    negative: {
      label: '生成负面词',
      tip: '按正向提示词反推负面词',
      build: c => `根据下面这条正向提示词，写一条配套的负面提示词（英文逗号短语，覆盖常见缺陷：多余手指、畸形、水印、文字、模糊、低质量等，不要重复正向词）：\n\n${c.prompt}`
    },
    describe: {
      label: '看图反推',
      tip: '让视觉模型看图写提示词',
      vision: true,
      build: c => `根据这张图片反推一条能复现它的英文提示词。${c.extra ? '补充要求：' + c.extra : ''}`
    }
  };
  const MODES = DEFAULT_MODES;

  /* ============================================================
     读写
     ============================================================ */
  async function load() {
    const s = await DB.getSettings();
    store.providers = Array.isArray(s.aiProviders) ? s.aiProviders : [];
    store.agents = Array.isArray(s.aiAgents) ? s.aiAgents : [];
    store.lastAgentId = s.aiLastAgent || '';

    // 迁移旧版单一配置
    const legacy = s.ai;
    if (legacy && (legacy.apiKey || legacy.baseUrl) && !store.providers.length) {
      const prv = defaultProvider(legacy.baseUrl?.includes('bigmodel') ? 'zhipu' : 'deepseek', {
        baseUrl: legacy.baseUrl || 'https://api.deepseek.com',
        apiKey: legacy.apiKey || '',
        models: [legacy.model || 'deepseek-chat'],
        name: (legacy.baseUrl?.includes('bigmodel') ? '智谱 GLM' : 'DeepSeek') + '（旧配置）'
      });
      store.providers = [prv];
      store.agents = defaultAgents(prv.id).map(a =>
        a.key === 'engineer'
          ? { ...a, model: legacy.model || '', systemPrompt: legacy.systemPrompt || a.systemPrompt, temperature: legacy.temperature ?? a.temperature }
          : { ...a, model: legacy.model || '' }
      );
      await persist();
    }

    // 首次使用：给一个空 Key 的 DeepSeek + 六套智能体，用户填 Key 就能跑
    if (!store.providers.length) {
      const prv = defaultProvider('deepseek');
      store.providers = [prv];
      store.agents = defaultAgents(prv.id);
      await persist();
    }
    if (!store.agents.length) {
      store.agents = defaultAgents(store.providers[0].id);
      await persist();
    }
    // 智能体指向的服务商被删掉时兜底
    const okIds = new Set(store.providers.map(p => p.id));
    for (const a of store.agents) {
      if (!okIds.has(a.providerId)) a.providerId = store.providers[0].id;
    }
    return store;
  }

  async function persist() {
    await DB.setSetting('aiProviders', store.providers);
    await DB.setSetting('aiAgents', store.agents);
    await DB.setSetting('aiLastAgent', store.lastAgentId || '');
    return store;
  }

  const providers = () => store.providers;
  const agents = () => store.agents;
  const providerById = id => store.providers.find(p => p.id === id) || store.providers[0] || null;
  const agentById = id => store.agents.find(a => a.id === id) || store.agents[0] || null;

  async function upsertProvider(p) {
    const i = store.providers.findIndex(x => x.id === p.id);
    if (i >= 0) store.providers[i] = { ...store.providers[i], ...p };
    else store.providers.push({ ...p, id: p.id || uid('prv'), createdAt: Date.now() });
    await persist();
    return store.providers.find(x => x.id === p.id);
  }

  async function removeProvider(id) {
    store.providers = store.providers.filter(p => p.id !== id);
    if (!store.providers.length) {
      const prv = defaultProvider('deepseek');
      store.providers.push(prv);
    }
    const fallback = store.providers[0].id;
    store.agents.forEach(a => { if (a.providerId === id) a.providerId = fallback; });
    await persist();
  }

  async function upsertAgent(a) {
    const i = store.agents.findIndex(x => x.id === a.id);
    if (i >= 0) store.agents[i] = { ...store.agents[i], ...a };
    else store.agents.push({ ...a, id: a.id || uid('agt'), createdAt: Date.now() });
    await persist();
    return store.agents.find(x => x.id === a.id);
  }

  async function removeAgent(id) {
    if (store.agents.length <= 1) throw new Error('至少保留一个智能体');
    store.agents = store.agents.filter(a => a.id !== id);
    if (store.lastAgentId === id) store.lastAgentId = store.agents[0].id;
    await persist();
  }

  async function setLastAgent(id) {
    store.lastAgentId = id;
    await DB.setSetting('aiLastAgent', id);
  }

  /* ============================================================
     请求
     ============================================================ */
  function endpoint(base) {
    let b = String(base || '').trim().replace(/\/+$/, '');
    if (!b) throw new Error('服务商接口地址为空');
    if (!/\/chat\/completions$/.test(b)) b += '/chat/completions';
    return b;
  }

  function clean(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
    t = t.replace(/^(prompt|提示词|正向提示词|negative prompt|负面提示词)\s*[:：]\s*/i, '');
    return t.replace(/^["“「]|["”」]$/g, '').trim();
  }

  function friendlyError(e, provider) {
    const msg = String(e?.message || e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      if (provider?.key === 'ollama' || provider?.key === 'lmstudio' || /127\.0\.0\.1|localhost/.test(provider?.baseUrl || '')) {
        return `连不上本地模型服务（${provider.baseUrl}）。确认已在运行，并且允许跨域：` +
          (provider.key === 'ollama' ? 'Ollama 需 `OLLAMA_ORIGINS=* ollama serve`' : 'LM Studio 需在 Server 设置里打开 CORS');
      }
      return '网络请求失败：检查接口地址、代理或网络。' + (msg.includes(':') ? '（' + msg + '）' : '');
    }
    return msg;
  }

  async function chat(provider, model, messages, { temperature = 0.9, maxTokens = 1400 } = {}) {
    if (!provider) throw new Error('没有可用的服务商，先去设置里添加一个');
    if (provider.needKey !== false && !provider.apiKey && presetOf(provider.key).needKey) {
      throw new Error(`「${provider.name}」还没填 API Key`);
    }
    const mdl = model || (provider.models || [])[0];
    if (!mdl) throw new Error(`「${provider.name}」没有指定模型`);

    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = 'Bearer ' + provider.apiKey;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let res;
    try {
      res = await fetch(endpoint(provider.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: mdl,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false
        }),
        signal: ctrl.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时（90 秒）。本地模型首次加载会比较慢，再试一次。');
      throw new Error(friendlyError(e, provider));
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.error?.message || j?.message || j?.error || JSON.stringify(j).slice(0, 200);
      } catch {
        detail = (await res.text().catch(() => '')).slice(0, 200);
      }
      const hint = res.status === 401 ? '（Key 无效或已过期）'
        : res.status === 402 ? '（余额不足）'
          : res.status === 404 ? '（接口地址或模型名不对）'
            : res.status === 429 ? '（请求太频繁 / 额度用尽）'
              : res.status === 400 ? '（请求被拒，可能模型名不对）' : '';
      throw new Error(`HTTP ${res.status} ${hint}${detail ? ' · ' + detail : ''}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('接口返回为空：' + JSON.stringify(data).slice(0, 180));
    return content;
  }

  /* ============================================================
     生成
     ============================================================ */
  async function generate({ agentId, mode = 'refine', prompt = '', negative = '', style = '', count = 3, extra = '' } = {}) {
    const agent = agentById(agentId);
    if (!agent) throw new Error('没有可用的智能体');
    const provider = providerById(agent.providerId);
    const m = MODES[mode] || MODES.refine;

    const ctx = {
      prompt: (prompt || '').trim() || '（无，请根据参数推断）',
      negative, style, count, extra
    };
    const userMsg = m.build(ctx) + (extra && mode !== 'describe' ? `\n\n补充要求：${extra}` : '');

    const raw = await chat(provider, agent.model, [
      { role: 'system', content: agent.systemPrompt },
      { role: 'user', content: userMsg }
    ], { temperature: Number(agent.temperature ?? 0.9) });

    const parts = raw.split(/\n\s*-{3,}\s*\n/).map(clean).filter(Boolean);
    return {
      text: parts[0] || clean(raw),
      parts,
      mode,
      agentId: agent.id,
      agentName: agent.name,
      providerName: provider?.name || '',
      model: agent.model || provider?.models?.[0] || ''
    };
  }

  /** 看图反推（需要视觉模型，如 glm-4v-plus / gpt-4o） */
  async function describeImage({ agentId, base64, mime = 'image/jpeg', extra = '' } = {}) {
    const agent = agentById(agentId);
    const provider = providerById(agent?.providerId);
    const raw = await chat(provider, agent?.model, [
      { role: 'system', content: agent?.systemPrompt || AGENT_PRESETS[0].systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: '根据这张图片反推一条能复现它的英文提示词。' + (extra ? '补充要求：' + extra : '') },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
        ]
      }
    ], { temperature: 0.7, maxTokens: 900 });
    return { text: clean(raw), model: agent?.model || '' };
  }

  function resolveProvider(x) {
    if (!x) return null;
    return typeof x === 'string' ? providerById(x) : x;
  }

  async function test(providerOrId, model) {
    const provider = resolveProvider(providerOrId);
    if (!provider) throw new Error('服务商不存在');
    const raw = await chat(provider, model, [
      { role: 'system', content: '只回答两个字：可用' },
      { role: 'user', content: '连接测试' }
    ], { maxTokens: 16, temperature: 0 });
    return raw.trim();
  }

  /** 拉取本地服务商的模型列表（Ollama / LM Studio 支持 GET /models） */
  async function listModels(providerOrId) {
    const provider = resolveProvider(providerOrId);
    if (!provider) throw new Error('服务商不存在');
    let base = String(provider.baseUrl || '').replace(/\/+$/, '');
    const url = /\/v1$/.test(base) ? base + '/models' : base.replace(/\/chat\/completions$/, '') + '/models';
    const headers = {};
    if (provider.apiKey) headers['Authorization'] = 'Bearer ' + provider.apiKey;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const arr = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
      return arr;
    } catch (e) {
      throw new Error('拉取模型失败：' + friendlyError(e, provider));
    }
  }

  const lastAgentId = () => store.lastAgentId || (store.agents[0]?.id || '');

  function migrateDefaults() { /* 占位，保持接口稳定 */ }

  return {
    MODES, PROVIDER_PRESETS, AGENT_PRESETS, presetOf,
    load, persist,
    providers, agents, providerById, agentById,
    upsertProvider, removeProvider, upsertAgent, removeAgent, setLastAgent,
    generate, describeImage, test, listModels, lastAgentId,
    defaultProvider, defaultAgents,
    chat, clean, endpoint
  };
})();
