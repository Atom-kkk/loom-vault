/* ============================================================
   manage.js — 模型库 / LoRA / 工作流 / 分类 / 设置
   ============================================================ */

(function () {
  'use strict';

  const V = window.Vault;
  const { toast, icon, openModal, confirmDialog, go } = V;
  const esc = U.esc;

  const FILE_KINDS = [
    { v: 'checkpoint', label: '主模型 Checkpoint', dir: 'ComfyUI/models/checkpoints' },
    { v: 'lora', label: 'LoRA', dir: 'ComfyUI/models/loras' },
    { v: 'vae', label: 'VAE', dir: 'ComfyUI/models/vae' },
    { v: 'clip', label: 'CLIP', dir: 'ComfyUI/models/clip' },
    { v: 'text_encoder', label: 'Text Encoder', dir: 'ComfyUI/models/text_encoders' },
    { v: 'controlnet', label: 'ControlNet', dir: 'ComfyUI/models/controlnet' },
    { v: 'upscaler', label: '放大模型', dir: 'ComfyUI/models/upscale_models' },
    { v: 'embedding', label: 'Embedding', dir: 'ComfyUI/models/embeddings' },
    { v: 'workflow', label: '工作流文件', dir: 'ComfyUI/user/default/workflows' },
    { v: 'other', label: '其他', dir: '' }
  ];
  const kindOf = k => FILE_KINDS.find(f => f.v === k) || FILE_KINDS[FILE_KINDS.length - 1];

  /* ============================================================
     模型库
     ============================================================ */
  function modelImages(id) { return V.state.images.filter(i => i.modelId === id); }

  function modelCard(m) {
    const imgs = modelImages(m.id).length;
    const files = (m.files || []).length;
    const wfs = (m.workflowIds || []).length;
    const loras = (m.loraIds || []).length;
    return `<div class="model-card" data-act="model-open" data-id="${m.id}">
      <div class="model-card-head">
        <div class="model-card-icon">${esc((m.name || '?').slice(0, 2).toUpperCase())}</div>
        <div style="min-width:0">
          <h3>${esc(m.name)}${m.version ? `<span style="font-weight:400;color:var(--text-3);font-size:11.5px"> · ${esc(m.version)}</span>` : ''}</h3>
          <div class="sub">${esc([m.platform, m.base].filter(Boolean).join(' · ') || (m.type === 'local' ? '本地部署' : '云端服务'))}</div>
        </div>
        <div class="spacer"></div>
        <span class="badge ${m.type === 'local' ? 'local' : 'cloud'}">${m.type === 'local' ? '本地' : '云端'}</span>
      </div>
      ${m.desc ? `<p class="desc">${esc(m.desc)}</p>` : ''}
      <div class="model-tags">
        ${m.endpoint ? `<span class="badge mono">${esc(m.endpoint.replace(/^https?:\/\//, ''))}</span>` : ''}
        ${m.access ? `<span class="badge">${esc(m.access)}</span>` : ''}
      </div>
      <div class="model-meta">
        <span>出图 <b>${imgs}</b></span>
        <span>文件 <b>${files}</b></span>
        <span>LoRA <b>${loras}</b></span>
        <span>工作流 <b>${wfs}</b></span>
      </div>
    </div>`;
  }

  V.registerView('models', {
    title: '云端模型',
    sub: () => `${V.state.models.length} 个模型 · 云端 API 在这里配置；本地模型随工作流导入自动登记`,
    actions: () => `
      <button class="btn" data-act="model-export-all">${icon('down', 15)} 导出全部清单</button>
      <button class="btn primary" data-act="model-new">${icon('plus', 15)} 添加模型</button>`,
    render: async (c) => {
      // 本地基座不再入库（文件名显示在工作流卡片上），这里只有外接 API 的云端模型
      const list = V.state.models.filter(m => m.type !== 'local');
      c.innerHTML = list.length
        ? `<div class="model-grid">${list.map(modelCard).join('')}</div>`
        : `<div class="empty">${icon('cpu', 40)}<b>还没有云端模型</b><p>点右上角「添加模型」，选一个预设填上 Key 就能在画布直接出图。</p></div>`;
    }
  });

  V.on('model-new', () => modelForm(null));
  V.on('model-open', el => modelDetail(el.dataset.id));
  V.on('model-export-all', () => exportAllManifests());

  /* ---------------- 文件清单编辑 ---------------- */
  function fileRow(f = {}) {
    const k = f.kind || 'checkpoint';
    return `<div class="file-row" style="display:flex;flex-wrap:wrap;gap:6px;padding:8px;border:1px solid var(--line-strong);border-radius:8px;margin-bottom:6px;background:var(--panel-2)">
      <select class="f-kind" style="flex:0 0 150px;height:30px;font-size:12px">
        ${FILE_KINDS.map(x => `<option value="${x.v}" ${k === x.v ? 'selected' : ''}>${x.label}</option>`).join('')}
      </select>
      <input class="f-name" style="flex:1 1 160px;height:30px;font-size:12px" placeholder="文件名，如 krea2_fp16.safetensors" value="${esc(f.filename || '')}">
      <input class="f-size" style="flex:0 0 90px;height:30px;font-size:12px" placeholder="体积" value="${esc(f.size || '')}">
      <button class="icon-btn f-del" style="flex:0 0 30px" title="删除">${icon('close', 14)}</button>
      <input class="f-url" style="flex:1 1 100%;height:30px;font-size:12px;font-family:var(--mono)" placeholder="下载链接（HuggingFace / Civitai / 网盘）" value="${esc(f.url || '')}">
      <input class="f-hash" style="flex:1 1 100%;height:30px;font-size:12px;font-family:var(--mono)" placeholder="SHA256（可选，用于校验）" value="${esc(f.sha256 || '')}">
    </div>`;
  }

  function bindFileRows(container, addBtn) {
    addBtn.onclick = () => {
      const wrap = container;
      wrap.insertAdjacentHTML('beforeend', fileRow());
      bindOne(wrap.lastElementChild);
    };
    function bindOne(row) {
      row.querySelector('.f-del').onclick = () => row.remove();
      row.querySelector('.f-kind').onchange = e => {
        const k = kindOf(e.target.value);
        const nameInput = row.querySelector('.f-name');
        if (!nameInput.value && k.dir) nameInput.placeholder = k.dir.split('/').pop() + ' 下的文件名';
      };
    }
    Array.from(container.children).forEach(bindOne);
  }

  function readFileRows(container) {
    return Array.from(container.querySelectorAll('.file-row')).map(row => ({
      kind: row.querySelector('.f-kind').value,
      filename: row.querySelector('.f-name').value.trim(),
      url: row.querySelector('.f-url').value.trim(),
      size: row.querySelector('.f-size').value.trim(),
      sha256: row.querySelector('.f-hash').value.trim()
    })).filter(f => f.filename || f.url);
  }

  /* ---------------- 模型表单 ---------------- */
  function modelForm(m) {
    const isNew = !m;
    m = m || { type: 'local', platform: 'ComfyUI', files: [], loraIds: [], workflowIds: [] };

    openModal({
      title: isNew ? '添加模型' : '编辑模型',
      sub: '选一个预设填上 Key 就能在画布直接出图；Key 只存在本机',
      wide: true,
      body: `
        <div class="form-grid">
          <div class="field"><label>模型名称 *</label>
            <input type="text" id="m-name" value="${esc(m.name || '')}" placeholder="GPT Image 1 / CogView-4 / Flux.1 dev"></div>
          <div class="field"><label>平台 / 服务商</label>
            <input type="text" id="m-platform" value="${esc(m.platform || '')}" placeholder="OpenAI / 智谱 / 即梦 / 中转站">
          </div>
          <div class="field"><label>基座 / 系列</label>
            <input type="text" id="m-base" value="${esc(m.base || '')}" placeholder="gpt-image / cogview / flux"></div>
          <div class="field"><label>版本</label>
            <input type="text" id="m-version" value="${esc(m.version || '')}" placeholder="v1.0 / fp16"></div>
          <div class="field"><label>访问方式</label>
            <input type="text" id="m-access" value="${esc(m.access || '')}" placeholder="API / 网页"></div>
          <div class="field full"><label>说明</label>
            <textarea id="m-desc" style="min-height:60px">${esc(m.desc || '')}</textarea></div>
        </div>

        <div class="section">
          <div class="section-title">云端接入<span></span></div>
          <p class="hint" style="margin:0 0 9px">选一个预设自动填好接口和模型名；中转站选最后一项，填中转站地址（带 /v1）和它要求的模型名。Key 只存在本机浏览器里。</p>
          <div class="chips" id="m-cloud-presets" style="margin-bottom:12px">
            ${(Cloud.CLOUD_PRESETS).map(p => `<button type="button" class="chip" data-pk="${p.key}" title="${esc(p.note || '')}">${esc(p.name)}</button>`).join('')}
          </div>
          <div class="form-grid">
            <div class="field full"><label>接口地址</label>
              <input type="text" id="m-api-base" value="${esc(m.apiBase || '')}" placeholder="https://api.openai.com/v1（中转站填到 /v1）"></div>
            <div class="field"><label>API Key</label>
              <input type="password" id="m-api-key" value="${esc(m.apiKey || '')}" placeholder="在厂商控制台申请，只存本机"></div>
            <div class="field"><label>模型名（API 参数）</label>
              <input type="text" id="m-api-model" value="${esc(m.apiModel || '')}" placeholder="gpt-image-1 / cogview-4-250304 / 中转站要求的名字"></div>
            <div class="field"><label>调用形态</label>
              <select id="m-api-shape">
                ${Object.entries(Cloud.SHAPE_LABEL).map(([k, label]) => `<option value="${k}" ${(m.shape || 'images') === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
              </select>
              <span class="hint">中转站不确定形态就先试 images，报「没有图片链接」再换 chat。</span></div>
            <div class="field"><label>出图尺寸（可选）</label>
              <input type="text" id="m-api-size" value="${esc(m.size || '')}" placeholder="1024x1024（万相用 1024*1024，留空走默认）"></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
            <button class="btn sm" id="m-api-test">测试连接</button>
            <span class="hint" id="m-api-test-result" style="margin:0"></span>
          </div>
        </div>`,
      footer: `${!isNew ? `<button class="btn danger" id="m-del">${icon('trash', 14)} 删除</button>` : ''}
               <div class="spacer"></div>
               <button class="btn" data-close>取消</button>
               <button class="btn primary" id="m-save">保存</button>`,
      onMount: (box, close) => {
        // 云端预设：点一下自动填接口 / 模型名 / 形态 / 服务商（新模型名称为空时连名字一起填）
        box.querySelectorAll('#m-cloud-presets .chip').forEach(ch => {
          ch.onclick = () => {
            const p = Cloud.presetOf(ch.dataset.pk);
            if (!p) return;
            box.querySelectorAll('#m-cloud-presets .chip').forEach(x => x.classList.toggle('active', x === ch));
            box.querySelector('#m-api-base').value = p.base || '';
            box.querySelector('#m-api-model').value = p.model || '';
            box.querySelector('#m-api-shape').value = p.shape || 'images';
            box.querySelector('#m-platform').value = p.vendor || '';
            if (isNew && !box.querySelector('#m-name').value.trim()) box.querySelector('#m-name').value = p.name;
          };
        });

        // 测试连接（用表单里当前的值，不用已保存的）
        box.querySelector('#m-api-test').onclick = async () => {
          const out = box.querySelector('#m-api-test-result');
          out.textContent = '测试中…';
          try {
            out.textContent = await Cloud.testConnection({
              apiBase: box.querySelector('#m-api-base').value.trim(),
              apiKey: box.querySelector('#m-api-key').value.trim(),
              apiModel: box.querySelector('#m-api-model').value.trim(),
              shape: box.querySelector('#m-api-shape').value
            });
          } catch (e) {
            out.textContent = '✕ ' + e.message;
          }
        };

        box.querySelector('#m-save').onclick = async () => {
          const name = box.querySelector('#m-name').value.trim();
          if (!name) return toast('模型名称不能为空', 'err');
          if (!box.querySelector('#m-api-base').value.trim()) {
            return toast('云端模型要填接口地址（或点一个预设自动填）', 'err');
          }
          const obj = {
            ...m,
            name, type,
            platform: box.querySelector('#m-platform').value.trim(),
            base: box.querySelector('#m-base').value.trim(),
            version: box.querySelector('#m-version').value.trim(),
            access: box.querySelector('#m-access').value.trim(),
            desc: box.querySelector('#m-desc').value.trim(),
            endpoint: box.querySelector('#m-endpoint').value.trim(),
            installPath: box.querySelector('#m-install').value.trim(),
            apiBase: box.querySelector('#m-api-base').value.trim().replace(/\/+$/, ''),
            apiKey: box.querySelector('#m-api-key').value.trim(),
            apiModel: box.querySelector('#m-api-model').value.trim(),
            shape: box.querySelector('#m-api-shape').value,
            size: box.querySelector('#m-api-size').value.trim(),
            files: type === 'local' ? readFileRows(filesWrap) : (m.files || []),
            updatedAt: Date.now()
          };
          if (!obj.access && type === 'cloud') obj.access = 'API';
          if (!obj.id) obj.id = U.uid('mdl');
          if (!obj.createdAt) obj.createdAt = Date.now();
          obj.loraIds = obj.loraIds || [];
          obj.workflowIds = obj.workflowIds || [];
          await DB.put('models', obj);
          close();
          await V.reload(); V.renderNav(); V.render();
          toast('模型已保存', 'ok');
        };

        const delBtn = box.querySelector('#m-del');
        if (delBtn) delBtn.onclick = async () => {
          close();
          const ok = await confirmDialog({
            title: '删除模型？',
            message: `「${m.name}」会从模型库移除，已关联的图片不会被删除，只会变成未指定模型。`,
            danger: true, okText: '删除'
          });
          if (!ok) return;
          await DB.del('models', m.id);
          // 预置的云端模型：记一笔，下次启动不复活用户明确删掉的
          if (m.builtin) {
            const st = await DB.getSettings().catch(() => ({}));
            const gone = Array.isArray(st.autoModelDismissed) ? st.autoModelDismissed : [];
            if (!gone.includes(m.id)) await DB.setSetting('autoModelDismissed', [...gone, m.id]);
          }
          await V.reload(); V.renderNav(); V.render();
          toast('已删除', 'ok');
        };
      }
    });
  }

  /* ---------------- 模型详情 ---------------- */
  function modelDetail(id) {
    const m = V.state.models.find(x => x.id === id);
    if (!m) return;
    const imgs = modelImages(m.id);
    const loras = (m.loraIds || []).map(x => V.state.loras.find(l => l.id === x)).filter(Boolean);
    const wfs = (m.workflowIds || []).map(x => V.state.workflows.find(w => w.id === x)).filter(Boolean);
    const files = m.files || [];

    openModal({
      title: m.name,
      sub: [m.platform, m.base, m.version].filter(Boolean).join(' · '),
      wide: true,
      body: `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
          <span class="badge ${m.type === 'local' ? 'local' : 'cloud'}">${m.type === 'local' ? '本地部署' : '云端 API'}</span>
          ${m.endpoint ? `<span class="badge mono">${esc(m.endpoint)}</span>` : ''}
          ${m.access ? `<span class="badge">${esc(m.access)}</span>` : ''}
          <div style="flex:1"></div>
          ${m.endpoint ? `<button class="btn sm" data-open-url="${esc(m.endpoint)}">${icon('link', 12)} 打开 ComfyUI</button>` : ''}
          <button class="btn sm" data-act="model-edit" data-id="${m.id}">${icon('edit', 12)} 编辑</button>
          <button class="btn sm" data-act="model-manifest" data-id="${m.id}">${icon('down', 12)} 部署清单</button>
        </div>

        ${m.desc ? `<p style="font-size:12.5px;color:var(--text-2);line-height:1.7;margin:0 0 14px">${esc(m.desc)}</p>` : ''}

        <div class="section" style="margin-top:0">
          <div class="section-title">部署文件（${files.length}）<span></span></div>
          ${files.length ? `<table class="file-table">
            <thead><tr><th style="width:130px">类型</th><th>文件</th><th style="width:80px">体积</th><th style="width:70px">链接</th></tr></thead>
            <tbody>${files.map(f => `<tr>
              <td><span class="kind">${esc(f.kind)}</span></td>
              <td class="mono">${esc(f.filename || '—')}${f.sha256 ? `<div style="color:var(--text-3);font-size:10px">${esc(f.sha256.slice(0, 24))}…</div>` : ''}</td>
              <td class="mono">${esc(f.size || '—')}</td>
              <td>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">下载</a>` : '<span style="color:var(--text-3)">—</span>'}</td>
            </tr>`).join('')}</tbody>
          </table>` : `<p style="font-size:12px;color:var(--text-3);margin:0">还没有登记文件。点「编辑」把 checkpoint / LoRA / VAE 的下载链接加进去。</p>`}
        </div>

        ${loras.length ? `<div class="section">
          <div class="section-title">关联 LoRA（${loras.length}）<span></span></div>
          <div class="chips">${loras.map(l => `<span class="chip" style="font-size:12px">${esc(l.name)}</span>`).join('')}</div>
        </div>` : ''}

        ${wfs.length ? `<div class="section">
          <div class="section-title">关联工作流（${wfs.length}）<span></span></div>
          <div class="chips">${wfs.map(w => `<span class="chip" style="font-size:12px">${esc(w.name)}</span>`).join('')}</div>
        </div>` : ''}

        <div class="section">
          <div class="section-title">这个模型出的图（${imgs.length}）<span></span></div>
          ${imgs.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px">
            ${imgs.slice(0, 18).map(i => `<div class="card" data-open="${esc(i.id)}" style="border-radius:8px">
              <img class="card-img loading" data-blob="${esc(i.thumbId)}" style="aspect-ratio:1">
            </div>`).join('')}
          </div>` : `<p style="font-size:12px;color:var(--text-3);margin:0">还没有用这个模型入库的图。</p>`}
        </div>`,
      footer: `<button class="btn" data-close>关闭</button>`
    });

    setTimeout(() => {
      const root = document.querySelector('#modal .modal-body');
      if (!root) return;
      V.$$('img[data-blob]', root).forEach(async img => {
        const u = await V.blobURL(img.dataset.blob);
        if (u) { img.src = u; img.classList.remove('loading'); }
      });
    }, 30);
  }

  V.on('model-edit', el => {
    const m = V.state.models.find(x => x.id === el.dataset.id);
    document.querySelector('#modal').classList.add('hidden');
    document.querySelector('#modal').innerHTML = '';
    modelForm(m);
  });

  /* ---------------- 部署清单导出 ---------------- */
  function manifestText(m) {
    const L = [];
    const now = new Date();
    L.push(`# 模型部署清单 · ${m.name}`);
    L.push('');
    L.push(`- 生成时间：${U.fmtDate(now.getTime())}`);
    L.push(`- 平台：${m.platform || '—'}`);
    L.push(`- 基座：${m.base || '—'}`);
    L.push(`- 版本：${m.version || '—'}`);
    if (m.endpoint) L.push(`- ComfyUI 地址：${m.endpoint}`);
    if (m.installPath) L.push(`- 主目录：${m.installPath}`);
    if (m.desc) L.push(`- 说明：${m.desc}`);
    L.push('');

    const groups = {};
    (m.files || []).forEach(f => (groups[f.kind] = groups[f.kind] || []).push(f));
    if (!Object.keys(groups).length) {
      L.push('_（还没有登记部署文件）_');
    } else {
      Object.entries(groups).forEach(([kind, arr]) => {
        L.push(`## ${kindOf(kind).label}`);
        L.push('');
        arr.forEach(f => {
          L.push(`### ${f.filename || '(未命名)'}`);
          if (f.size) L.push(`- 体积：${f.size}`);
          if (f.url) L.push(`- 下载：${f.url}`);
          L.push(`- 放置：${kindOf(kind).dir || '（按实际配置）'}/`);
          if (f.sha256) L.push(`- SHA256：${f.sha256}`);
          L.push('');
        });
      });
    }

    const loras = (m.loraIds || []).map(x => V.state.loras.find(l => l.id === x)).filter(Boolean);
    if (loras.length) {
      L.push('## 关联 LoRA');
      L.push('');
      loras.forEach(l => {
        L.push(`- **${l.name}**${l.baseModel ? '（' + l.baseModel + '）' : ''}`);
        if (l.triggerWords) L.push(`  - 触发词：${l.triggerWords}`);
        if (l.downloadUrl) L.push(`  - 下载：${l.downloadUrl}`);
        L.push(`  - 放置：ComfyUI/models/loras/`);
      });
      L.push('');
    }

    const wfs = (m.workflowIds || []).map(x => V.state.workflows.find(w => w.id === x)).filter(Boolean);
    if (wfs.length) {
      L.push('## 可用工作流');
      L.push('');
      wfs.forEach(w => L.push(`- ${w.name}（${w.format || 'json'}${w.nodes ? ' · ' + w.nodes + ' 节点' : ''}）`));
      L.push('');
    }

    const dl = (m.files || []).filter(f => f.url);
    if (dl.length) {
      L.push('## 批量下载');
      L.push('');
      L.push('```bash');
      dl.forEach(f => L.push(`wget -c "${f.url}" -O "${f.filename || 'download.bin'}"`));
      L.push('```');
      L.push('');
      L.push('```bash');
      L.push('# aria2c 多线程版');
      dl.forEach(f => L.push(`aria2c -x8 -s8 -c "${f.url}" -o "${f.filename || 'download.bin'}"`));
      L.push('```');
    }
    return L.join('\n');
  }

  V.on('model-manifest', el => {
    const m = V.state.models.find(x => x.id === el.dataset.id);
    const text = manifestText(m);
    U.download(`${m.name.replace(/[\\/:*?"<>|]/g, '_')}-部署清单.md`, text, 'text/markdown;charset=utf-8');
    toast('清单已导出', 'ok');
  });

  function exportAllManifests() {
    const all = V.state.models.filter(m => m.type === 'local' || (m.files || []).length);
    if (!all.length) return toast('还没有可导出的本地模型', 'err');
    const text = all.map(manifestText).join('\n\n---\n\n');
    U.download(`部署清单-全部-${new Date().toISOString().slice(0, 10)}.md`, text, 'text/markdown;charset=utf-8');
    toast(`已导出 ${all.length} 个模型的清单`, 'ok');
  }

  V.on('open-url', el => window.open(el.dataset.openUrl, '_blank'));

  /* ============================================================
     LoRA
     ============================================================ */
  /* ---------------- LoRA：扫描引擎模型目录自动入库 ----------------
     引擎在跑时（serve.py 起着即可），把 ComfyUI models/loras 下的文件
     扫成 LoRA 卡片，按文件名去重；删除的自动条目记洞不复活。
     进页面静默扫一次，工具条按钮随时手动再扫。 */
  let loraScanned = false;
  async function scanEngineLoras(silent) {
    try {
      const scan = await Comfy.scanModels();
      const dir = scan.found && scan.found.loras;
      if (!dir) throw new Error('没找到 LoRA 目录');
      const list = await Comfy.listDir(dir);
      const files = (list.entries || []).filter(e => !e.dir && /\.(safetensors|ckpt|pt|pth|gguf)$/i.test(e.name));
      const st = await DB.getSettings().catch(() => ({}));
      const dismissed = new Set(st.autoLoraDismissed || []);
      const known = new Set(V.state.loras.map(l => String(l.fileName || '').replace(/\\/g, '/').split('/').pop()));
      let added = 0;
      for (const f of files) {
        if (known.has(f.name) || dismissed.has(f.name)) continue;
        await DB.put('loras', {
          id: U.uid('lora'),
          name: f.name.replace(/\.(safetensors|ckpt|pt|pth|gguf)$/i, ''),
          baseModel: '', fileName: f.name,
          downloadUrl: '', size: '', weight: '', triggerWords: '',
          note: '引擎目录自动扫描：' + dir,
          dir, auto: true, createdAt: Date.now()
        });
        known.add(f.name);
        added++;
      }
      if (added) { await V.reload(); V.renderNav(); if (!silent) V.render(); }
      if (!silent) toast(added ? `扫描完成：新增 ${added} 个 LoRA` : `扫描完成：目录里 ${files.length} 个都已入库`, 'ok');
      return added;
    } catch (e) {
      if (!silent) toast('扫描失败：' + e.message + '（需要本地引擎已配置并启动，见「本地配置」）', 'err');
      return null;
    }
  }
  V.on('lora-scan', () => scanEngineLoras(false));

  V.registerView('loras', {
    title: 'LoRA',
    sub: () => `${V.state.loras.length} 个 LoRA · 记录基座、触发词与下载链接`,
    actions: () => `<button class="btn" data-act="lora-scan" title="扫描 ComfyUI 的 models/loras 目录，自动入库">${icon('spark', 15)} 扫描引擎目录</button>
      <button class="btn primary" data-act="lora-new">${icon('plus', 15)} 添加 LoRA</button>`,
    render: async (c) => {
      if (!loraScanned) {
        loraScanned = true;
        scanEngineLoras(true).then(n => { if (n) V.render(); });
      }
      if (!V.state.loras.length) {
        c.innerHTML = `<div class="empty">${icon('layers', 40)}<b>还没有 LoRA</b>
          <p>把常用的风格 / 人物 LoRA 记进来：基座、触发词、下载链接、放置目录。<br>入库图片时会自动关联。</p></div>`;
        return;
      }
      c.innerHTML = `<div class="model-grid">${V.state.loras.map(l => {
        const used = V.state.images.filter(i => (i.loraIds || []).includes(l.id) || (i.loraNames || []).some(n => n && l.name && n.toLowerCase().includes(l.name.toLowerCase()))).length;
        return `<div class="model-card">
          <div class="model-card-head">
            <div class="model-card-icon" style="background:var(--rose-soft);color:var(--rose)">${icon('layers', 17)}</div>
            <div style="min-width:0">
              <h3>${esc(l.name)}</h3>
              <div class="sub">${esc(l.baseModel || '未标注基座')}${l.fileName ? ' · ' + esc(l.fileName) : ''}</div>
            </div>
            <div class="spacer"></div>
            <div style="display:flex;gap:4px">
              <button class="icon-btn" data-act="lora-edit" data-id="${l.id}" title="编辑">${icon('edit', 14)}</button>
              <button class="icon-btn" data-act="lora-del" data-id="${l.id}" title="删除">${icon('trash', 14)}</button>
            </div>
          </div>
          ${l.triggerWords ? `<div class="model-tags"><span class="badge mono">${esc(l.triggerWords)}</span></div>` : ''}
          ${l.note ? `<p class="desc">${esc(l.note)}</p>` : ''}
          <div class="model-meta">
            <span>用到 <b>${used}</b> 张</span>
            ${l.size ? `<span><b>${esc(l.size)}</b></span>` : ''}
            <div style="flex:1"></div>
            ${l.downloadUrl ? `<a href="${esc(l.downloadUrl)}" target="_blank" rel="noopener" style="font-size:11px">下载</a>` : ''}
          </div>
        </div>`;
      }).join('')}</div>`;
    }
  });

  V.on('lora-new', () => loraForm(null));
  V.on('lora-edit', el => loraForm(V.state.loras.find(l => l.id === el.dataset.id)));
  V.on('lora-del', async el => {
    const l = V.state.loras.find(x => x.id === el.dataset.id);
    const ok = await confirmDialog({ title: '删除 LoRA？', message: `「${l.name}」会从 LoRA 库移除，已入库图片里的名字保留。`, danger: true, okText: '删除' });
    if (!ok) return;
    await DB.del('loras', l.id);
    // 自动扫描进来的：记一笔，下次扫描不复活
    if (l && l.auto) {
      const st = await DB.getSettings().catch(() => ({}));
      const gone = Array.isArray(st.autoLoraDismissed) ? st.autoLoraDismissed : [];
      const key = String(l.fileName || l.name).replace(/\\/g, '/').split('/').pop();
      if (!gone.includes(key)) await DB.setSetting('autoLoraDismissed', [...gone, key]);
    }
    await V.reload(); V.renderNav(); V.render();
    toast('已删除', 'ok');
  });

  function loraForm(l) {
    const isNew = !l;
    l = l || {};
    openModal({
      title: isNew ? '添加 LoRA' : '编辑 LoRA',
      narrow: false,
      body: `<div class="form-grid">
        <div class="field full"><label>名称 *</label>
          <input type="text" id="l-name" value="${esc(l.name || '')}" placeholder="例如：krea2_photoreal_v3"></div>
        <div class="field"><label>基座模型</label>
          <input type="text" id="l-base" value="${esc(l.baseModel || '')}" placeholder="krea2 / SDXL / Flux.1"></div>
        <div class="field"><label>文件名</label>
          <input type="text" id="l-file" value="${esc(l.fileName || '')}" placeholder="xxx.safetensors"></div>
        <div class="field full"><label>下载链接</label>
          <input type="text" id="l-url" value="${esc(l.downloadUrl || '')}" placeholder="https://civitai.com/... 或 HuggingFace 直链"></div>
        <div class="field"><label>体积</label>
          <input type="text" id="l-size" value="${esc(l.size || '')}" placeholder="144 MB"></div>
        <div class="field"><label>建议权重</label>
          <input type="text" id="l-weight" value="${esc(l.weight || '')}" placeholder="0.7"></div>
        <div class="field full"><label>触发词</label>
          <input type="text" id="l-trigger" value="${esc(l.triggerWords || '')}" placeholder="ohwx style, soft light"></div>
        <div class="field full"><label>备注</label>
          <textarea id="l-note" style="min-height:60px">${esc(l.note || '')}</textarea></div>
      </div>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="l-save">保存</button>`,
      onMount: (box, close) => {
        box.querySelector('#l-save').onclick = async () => {
          const name = box.querySelector('#l-name').value.trim();
          if (!name) return toast('名称不能为空', 'err');
          const obj = {
            ...l, name,
            baseModel: box.querySelector('#l-base').value.trim(),
            fileName: box.querySelector('#l-file').value.trim(),
            downloadUrl: box.querySelector('#l-url').value.trim(),
            size: box.querySelector('#l-size').value.trim(),
            weight: box.querySelector('#l-weight').value.trim(),
            triggerWords: box.querySelector('#l-trigger').value.trim(),
            note: box.querySelector('#l-note').value.trim()
          };
          if (!obj.id) obj.id = U.uid('lora');
          obj.createdAt = obj.createdAt || Date.now();
          await DB.put('loras', obj);
          close();
          await V.reload(); V.renderNav(); V.render();
          toast('已保存', 'ok');
        };
      }
    });
  }

  /* ============================================================
     工作流
     ============================================================ */
  V.registerView('workflows', {
    title: '本地部署工作流',
    sub: () => `${V.state.workflows.length} 个工作流 · 上传 ComfyUI 导出的 JSON / PNG，导入后基座自动登记进云端模型页`,
    actions: () => `<button class="btn primary" data-act="wf-upload">${icon('upload', 15)} 上传工作流</button>`,
    render: async (c) => {
      if (!V.state.workflows.length) {
        c.innerHTML = `<div class="empty">${icon('flow', 40)}<b>还没有工作流</b>
          <p>在 ComfyUI 里「保存」或「导出 API 格式」，把 JSON 传上来。<br>带 workfow 的 PNG 也支持，会自动数出节点数。</p></div>`;
        return;
      }
      c.innerHTML = `<div class="model-grid">${V.state.workflows.map(w => {
        const m = V.state.models.find(x => x.id === w.modelId);
        const main = wfMainModel(w);
        return `<div class="model-card">
          <div class="model-card-head">
            <div class="model-card-icon" style="background:var(--panel-3);color:var(--text-2)">${icon('flow', 17)}</div>
            <div style="min-width:0">
              <h3>${esc(w.name)}</h3>
              <div class="sub">${esc(main || m?.name || '未关联模型')} · ${esc(w.format === 'ui-json' ? 'UI 格式' : w.format === 'api-json' ? 'API 格式' : (w.format || 'json'))}</div>
            </div>
            <div class="spacer"></div>
            <div style="display:flex;gap:4px">
              ${w.format === 'ui-json' ? `<button class="icon-btn" data-act="wf-convert" data-id="${w.id}" title="转成可提交的 API 格式">${icon('spark', 14)}</button>` : ''}
              <button class="icon-btn" data-act="wf-models" data-id="${w.id}" title="切换主模型 / CLIP / VAE / LoRA">${icon('cpu', 14)}</button>
              <button class="icon-btn" data-act="wf-download" data-id="${w.id}" title="下载">${icon('down', 14)}</button>
              <button class="icon-btn" data-act="wf-del" data-id="${w.id}" title="删除">${icon('trash', 14)}</button>
            </div>
          </div>
          ${w.note ? `<p class="desc">${esc(w.note).replace(/(https?:\/\/[^\s，。；]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</p>` : ''}
          <div class="model-meta">
            <span>节点 <b>${w.nodes || '—'}</b></span>
            <span><b>${U.fmtSize(w.size)}</b></span>
            <span>${U.relTime(w.createdAt)}</span>
          </div>
        </div>`;
      }).join('')}</div>`;
    }
  });

  V.on('wf-upload', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json,image/png';
    inp.multiple = true;
    inp.onchange = async () => {
      for (const f of Array.from(inp.files)) {
        await importWorkflowFile(f);
      }
      await V.reload(); V.renderNav(); V.render();
    };
    inp.click();
  });

  async function importWorkflowFile(f) {
    try {
      let content = '', nodes = 0, format = 'json';

      if (/\.json$/i.test(f.name)) {
        content = await f.text();
        try {
          const j = JSON.parse(content);
          nodes = Array.isArray(j.nodes) ? j.nodes.length : Object.keys(j).length;
        } catch { toast(`${f.name} 不是合法 JSON`, 'err'); return; }
      } else {
        format = 'png';
        const texts = await Parse.readPngText(await f.arrayBuffer());
        content = texts.workflow || texts.prompt || '';
        if (!content) { toast(`${f.name} 里没有工作流数据`, 'err'); return; }
        try {
          const j = JSON.parse(content);
          nodes = Array.isArray(j.nodes) ? j.nodes.length : Object.keys(j).length;
        } catch { }
      }

      const guessModel = V.state.models.find(m => m.type === 'local' && content.toLowerCase().includes(String(m.base || m.name).toLowerCase()));
      const wf = {
        id: U.uid('wf'),
        name: f.name.replace(/\.(json|png)$/i, ''),
        modelId: guessModel?.id || '',
        format,
        filename: f.name,
        size: f.size,
        nodes,
        content: content.slice(0, 2 * 1024 * 1024),
        note: '',
        createdAt: Date.now()
      };
      await DB.put('workflows', wf);
      toast(`已导入 ${wf.name}（${nodes} 节点）`, 'ok');
    } catch (e) {
      toast('导入失败：' + e.message, 'err');
    }
  }

  V.on('wf-convert', async el => {
    const w = V.state.workflows.find(x => x.id === el.dataset.id);
    if (!w) return;
    try {
      toast('正在读取 ComfyUI 节点定义…');
      const info = await Comfy.objectInfoCached();
      const r = Comfy.uiToApi(JSON.parse(w.content), info);
      const apiWf = {
        ...w,
        id: U.uid('wf'),
        name: w.name + ' · API',
        format: 'api-json',
        note: `由 UI 格式转换 · ${r.stats.nodes} 节点 / ${r.stats.links} 连线`,
        content: JSON.stringify(r.api),
        createdAt: Date.now()
      };
      await DB.put('workflows', apiWf);
      await V.reload();
      V.renderNav();
      V.render();
      toast(`转换完成：${r.stats.nodes} 节点${r.warnings.length ? '，' + r.warnings.length + ' 条警告' : ''}`, 'ok');
    } catch (e) {
      toast('转换失败：' + e.message, 'err');
    }
  });

  /* ---------------- 工作流：切换主模型 / CLIP / VAE / LoRA ---------------- */
  // 位置对应 ComfyUI 原生加载节点的模型字段；改完直接写回工作流 JSON，
  // 画布上的节点读的是同一条工作流记录（canvas.js 运行时按 workflowId 取），所以流也跟着变。
  const MODEL_SLOTS = [
    { node: 'UNETLoader', field: 'unet_name', label: '主模型 UNET', kind: '主模型' },
    { node: 'CheckpointLoaderSimple', field: 'ckpt_name', label: '主模型 Checkpoint', kind: '主模型' },
    { node: 'CheckpointLoader', field: 'ckpt_name', label: '主模型 Checkpoint', kind: '主模型' },
    { node: 'CLIPLoader', field: 'clip_name', label: 'CLIP / 文本编码器', kind: 'CLIP' },
    { node: 'DualCLIPLoader', field: 'clip_name1', label: 'CLIP 1', kind: 'CLIP' },
    { node: 'DualCLIPLoader', field: 'clip_name2', label: 'CLIP 2', kind: 'CLIP' },
    { node: 'VAELoader', field: 'vae_name', label: 'VAE', kind: 'VAE' },
    { node: 'LoraLoader', field: 'lora_name', label: 'LoRA', kind: 'LoRA' },
    { node: 'LoraLoaderModelOnly', field: 'lora_name', label: 'LoRA', kind: 'LoRA' },
  ];

  function wfApi(w) {
    try {
      const j = JSON.parse(w.content || '{}');
      if (j && j.nodes && Array.isArray(j.nodes)) return null;   // UI 格式，先转换
      return j && typeof j === 'object' ? j : null;
    } catch { return null; }
  }

  function wfMainModel(w) {
    const api = wfApi(w);
    if (!api) return '';
    for (const id of Object.keys(api)) {
      const n = api[id];
      if (!n || !n.inputs) continue;
      if (n.class_type === 'UNETLoader') return n.inputs.unet_name || '';
      if (n.class_type === 'CheckpointLoaderSimple' || n.class_type === 'CheckpointLoader') return n.inputs.ckpt_name || '';
    }
    return '';
  }

  // 取 ComfyUI 节点定义里的下拉候选（兼容 [[...]] 与 [[...], {...}] 两种写法）
  function comboList(info, ct, field) {
    const def = info && info[ct];
    const spec = (def && ((def.input && def.input.required) || {})[field]) ||
      (def && ((def.input && def.input.optional) || {})[field]);
    if (!spec) return [];
    let arr = Array.isArray(spec) ? spec[0] : spec;
    if (Array.isArray(arr) && arr.length && Array.isArray(arr[0])) arr = arr[0];
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
  }

  async function wfModelPicker(w) {
    const api = wfApi(w);
    if (!api) return toast('这是 UI 格式工作流，先点闪电图标转成 API 格式', 'err');

    let info = {};
    try { info = await Comfy.objectInfoCached(); }
    catch { toast('引擎没连上，只能手动填文件名（建议先启动引擎）', 'err'); }

    const rows = [];
    Object.keys(api).forEach(id => {
      const node = api[id];
      const ct = node && node.class_type;
      if (!ct || !node.inputs) return;
      MODEL_SLOTS.filter(sl => sl.node === ct).forEach(sl => {
        if (!Object.prototype.hasOwnProperty.call(node.inputs, sl.field)) return;
        rows.push({
          id, ct, field: sl.field, label: sl.label, kind: sl.kind,
          value: node.inputs[sl.field],
          options: comboList(info, ct, sl.field),
          strength: (typeof node.inputs.strength_model === 'number') ? 'strength_model'
            : (typeof node.inputs.strength_clip === 'number') ? 'strength_clip' : '',
          strengthVal: node.inputs.strength_model ?? node.inputs.strength_clip ?? ''
        });
      });
    });

    if (!rows.length) return toast('这个工作流里没有可切换的模型加载节点', 'err');

    const rowHTML = (r, i) => {
      const dl = `wfm-dl-${i}`;
      const missing = r.options.length && !r.options.includes(String(r.value));
      return `<div class="wfm-row">
        <div class="wfm-kind">${esc(r.kind)}</div>
        <div class="wfm-main">
          <input type="text" list="${dl}" data-wfm-i="${i}" value="${esc(String(r.value ?? ''))}"
                 placeholder="${r.options.length ? '选一个或直接填文件名' : '填模型文件名'}">
          <datalist id="${dl}">${r.options.map(o => `<option value="${esc(o)}"></option>`).join('')}</datalist>
          <div class="wfm-sub">${esc(r.label)} · 节点 #${esc(String(r.id))}
            ${missing ? '<em class="wfm-warn">当前值不在引擎列表里</em>' : ''}</div>
        </div>
        ${r.strength ? `<input type="text" class="wfm-strength" data-wfm-s="${i}" value="${esc(String(r.strengthVal))}" title="强度">` : '<div class="wfm-strength-empty"></div>'}
      </div>`;
    };

    openModal({
      title: '切换模型 · ' + w.name,
      sub: '改完画布上的这个工作流会跟着用新模型（不需要重新上传）',
      wide: true,
      body: `<div class="wfm-list">${rows.map(rowHTML).join('')}</div>
             ${!info || !Object.keys(info).length ? '<p class="hint" style="margin-top:10px">引擎未连接，候选列表为空，可以直接手填文件名。</p>' : `<p class="hint" style="margin-top:10px">候选来自当前引擎已识别的模型目录，共 ${rows.length} 处可切换。</p>`}`,
      footer: `<button class="btn" data-close>取消</button>
               <button class="btn primary" id="wfm-save">保存</button>`,
      onMount: (box, close) => {
        box.querySelector('#wfm-save').onclick = async () => {
          const next = JSON.parse(JSON.stringify(api));
          let changed = 0;
          rows.forEach((r, i) => {
            const inp = box.querySelector(`[data-wfm-i="${i}"]`);
            const st = box.querySelector(`[data-wfm-s="${i}"]`);
            const node = next[r.id];
            if (!node || !node.inputs) return;
            const v = (inp?.value || '').trim();
            if (v && v !== node.inputs[r.field]) { node.inputs[r.field] = v; changed++; }
            if (r.strength && st) {
              const n = parseFloat(st.value);
              if (!Number.isNaN(n) && n !== node.inputs[r.strength]) { node.inputs[r.strength] = n; changed++; }
            }
          });
          if (!changed) { close(); return toast('没有改动', ''); }
          const content = JSON.stringify(next);
          await DB.put('workflows', { ...w, content, size: content.length });
          await V.reload();
          close();
          toast('已切换，画布里的流下次生成就用新模型', 'ok');
          V.render();
        };
      }
    });
  }

  V.on('wf-models', async el => {
    const w = V.state.workflows.find(x => x.id === el.dataset.id);
    if (w) await wfModelPicker(w);
  });

  V.on('wf-download', async el => {
    const w = V.state.workflows.find(x => x.id === el.dataset.id);
    const ext = w.format === 'png' ? 'json' : 'json';
    U.download(w.name + '.' + ext, w.content || '', 'application/json;charset=utf-8');
  });

  V.on('wf-del', async el => {
    const w = V.state.workflows.find(x => x.id === el.dataset.id);
    const ok = await confirmDialog({ title: '删除工作流？', message: `「${w.name}」将被移除。`, danger: true, okText: '删除' });
    if (!ok) return;
    await DB.del('workflows', w.id);
    // 内置工作流：记一笔，升级补种时不再复活用户明确删掉的条目
    if (w && w.builtin) {
      const st = await DB.getSettings().catch(() => ({}));
      const gone = Array.isArray(st.wfBuiltinDismissed) ? st.wfBuiltinDismissed : [];
      if (!gone.includes(w.id)) await DB.setSetting('wfBuiltinDismissed', [...gone, w.id]);
    }
    await V.reload(); V.renderNav(); V.render();
    toast('已删除', 'ok');
  });

  /* ============================================================
     分类管理 —— 入口在图库工具条（原「管理 → 分类」独立页已并入）
     ============================================================ */
  function categoriesModal() {
    let box = null;
    const paint = () => {
      const rows = V.state.categories.map(cat => {
        const imgs = V.state.images.filter(i => i.categoryId === cat.id);
        const seq = Math.max(0, ...imgs.map(i => Number(String(i.id).split('-').pop()) || 0));
        return `<tr>
          <td><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:99px;background:${cat.color || 'var(--text-3)'};margin-right:8px"></span>${esc(cat.name)}</td>
          <td class="mono">${esc(cat.prefix)}-${U.pad(seq, 4)}</td>
          <td>${imgs.length}</td>
          <td><button class="btn sm ghost" data-cedit="${cat.id}">编辑</button>
              <button class="btn sm ghost" data-cdel="${cat.id}">删除</button></td>
        </tr>`;
      }).join('');
      box.querySelector('#cat-rows').innerHTML = rows;
    };
    const del = async (id) => {
      const cat = V.state.categories.find(c => c.id === id);
      const n = V.state.images.filter(i => i.categoryId === cat.id).length;
      if (V.state.categories.length <= 1) return toast('至少保留一个分类', 'err');
      const fallback = V.state.categories.find(c => c.id !== cat.id);
      const ok = await confirmDialog({
        title: '删除分类？',
        message: n ? `「${cat.name}」下还有 ${n} 张图，删除后这些图会移到「${fallback.name}」，图片本身不会丢。` : `「${cat.name}」将被删除。`,
        danger: true, okText: '删除'
      });
      if (!ok) return;
      for (const img of V.state.images.filter(i => i.categoryId === cat.id)) {
        img.categoryId = fallback.id;
        await DB.saveImage(img);
      }
      await DB.del('categories', cat.id);
      await V.reload();
      V.renderNav();
      paint();
      toast('已删除', 'ok');
    };
    openModal({
      title: '分类管理',
      sub: '编号按分类前缀自动续号，删除分类不会丢图（会挪到下一个分类）',
      body: `<table class="file-table" style="background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden">
          <thead><tr><th>分类</th><th style="width:160px">下一个编号</th><th style="width:80px">图片数</th><th style="width:140px">操作</th></tr></thead>
          <tbody id="cat-rows"></tbody>
        </table>
        <p class="hint" style="margin-top:12px">编号规则：<code class="mono">前缀-四位序号</code>，按分类独立计数，删除图片不回收编号。</p>`,
      footer: `<button class="btn" data-close>关闭</button>
               <div class="spacer"></div>
               <button class="btn primary" id="cat-newbtn">新建分类</button>`,
      onMount: (b) => {
        box = b;
        paint();
        b.querySelector('#cat-newbtn').onclick = () => catForm(null, paint);
        b.addEventListener('click', e => {
          const ed = e.target.closest('[data-cedit]');
          const de = e.target.closest('[data-cdel]');
          if (ed) catForm(V.state.categories.find(c => c.id === ed.dataset.cedit), paint);
          if (de) del(de.dataset.cdel);
        });
      }
    });
  }
  V.on('open-cats', () => categoriesModal());
  V.categoriesModal = categoriesModal;

  V.on('cat-new', () => catForm(null));

  function catForm(cat, onSaved) {
    const isNew = !cat;
    cat = cat || {};
    const colors = ['#c08a7d', '#b9775e', '#b99455', '#8a9464', '#8b9aa6', '#9c8aa5', '#a39b91', '#6f665c'];
    openModal({
      title: isNew ? '新建分类' : '编辑分类',
      narrow: true,
      body: `<div class="form-grid">
        <div class="field full"><label>分类名称 *</label>
          <input type="text" id="c-name" value="${esc(cat.name || '')}" placeholder="人像 / 服装 / 场景"></div>
        <div class="field"><label>编号前缀</label>
          <input type="text" id="c-prefix" value="${esc(cat.prefix || '')}" placeholder="POR" maxlength="5" style="text-transform:uppercase"></div>
        <div class="field"><label>颜色</label>
          <select id="c-color">${colors.map(c => `<option value="${c}" ${cat.color === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      </div>
      <p class="hint" style="margin-top:12px">前缀留空会自动用名称拼音首字母生成。生成编号形如 <code class="mono">POR-0001</code>。</p>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="c-save">保存</button>`,
      onMount: (box, close) => {
        box.querySelector('#c-save').onclick = async () => {
          const name = box.querySelector('#c-name').value.trim();
          if (!name) return toast('名称不能为空', 'err');
          let prefix = box.querySelector('#c-prefix').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (!prefix) prefix = name.slice(0, 3).toUpperCase();
          if (V.state.categories.some(c => c.prefix === prefix && c.id !== cat.id)) {
            return toast('前缀已被占用，换一个', 'err');
          }
          const obj = { ...cat, name, prefix, color: box.querySelector('#c-color').value, seq: cat.seq || 0 };
          if (!obj.id) obj.id = U.uid('cat');
          if (obj.order == null) obj.order = V.state.categories.length;
          obj.createdAt = obj.createdAt || Date.now();
          await DB.put('categories', obj);
          close();
          await V.reload(); V.renderNav(); V.render();
          if (typeof onSaved === 'function') onSaved();   // 分类管理弹窗开着时刷新表格
          toast('已保存', 'ok');
        };
      }
    });
  }

  /* ============================================================
     设置
     ============================================================ */
  const providerMark = p => (p.name || '?').slice(0, 2).toUpperCase();
  const providerNeedKey = p => AI.presetOf(p.key).needKey;

  function providerTag(p) {
    if (!providerNeedKey(p)) return `<span class="entity-tag ok">无需 Key</span>`;
    return p.apiKey
      ? `<span class="entity-tag ok">已配置</span>`
      : `<span class="entity-tag warn">缺 Key</span>`;
  }

  /* ============================================================
     本地配置：ComfyUI 引擎 + 模型目录
     （原来是「设置」页的第一段和画布「高级选项」弹窗，两处内容重了，合并到这里）
     ============================================================ */
  const MODEL_PATH_FIELDS = [
    { key: 'checkpoints', label: '底模（checkpoints）', hint: '.safetensors / .ckpt 完整模型' },
    { key: 'diffusion_models', label: '扩散模型（diffusion_models）', hint: 'Flux、Krea、Qwen 等分离式 UNET' },
    { key: 'clip', label: 'CLIP（clip）', hint: '文本编码器' },
    { key: 'text_encoders', label: '文本编码器（text_encoders）', hint: 'Flux 等新模型的 T5 / CLIP' },
    { key: 'vae', label: 'VAE', hint: '.safetensors' },
    { key: 'loras', label: 'LoRA（loras）', hint: 'LoRA 文件所在目录' },
  ];

  /** 模型路径那一坨（六类 + 自动识别提示），本地配置页用 */
  function modelPathsHTML(scan, configured) {
    const found = scan.found || {};
    const counts = scan.files || {};
    const partials = scan.partial || {};
    const valOf = k => configured[k] || found[k] || '';
    const isAuto = k => !!found[k] && (!configured[k] || configured[k] === found[k]);
    const keys = MODEL_PATH_FIELDS.map(f => f.key);
    const autoKeys = keys.filter(isAuto);
    // 手工配过、且和自动识别结果不一样的：这些是用户自己指定的目录，不能被当成「没找到」
    const setKeys = keys.filter(k => configured[k] && configured[k] !== found[k]);
    const rootsTxt = (scan.roots || []).map(r => r.label).join(' · ');
    // 提示里要指向 ComfyUI 自己的 models，不能把结尾的 /ComfyUI 剥掉 ——
    // 剥掉之后算出来是「上一级/models」，小白照着放会放到扫描根之外
    const ownModels = (scan.comfy_dir || 'ComfyUI').replace(/[\\/]+$/, '') + '/models';

    const field = f => `
      <div class="field">
        <label>${esc(f.label)}${isAuto(f.key)
        ? '<em class="auto-tag">自动识别</em>'
        : (configured[f.key] ? '<em class="auto-tag custom">手动指定</em>' : '')}</label>
        <input type="text" data-path="${f.key}" placeholder="留空 = 用自动识别到的目录"
               value="${esc(valOf(f.key))}">
        <span class="hint">${isAuto(f.key)
        ? `已找到 ${counts[f.key] || 0} 个模型${partials[f.key] ? `（另有 ${partials[f.key]} 个正在下载）` : ''} · ${esc(f.hint)}`
        : esc(f.hint)}</span>
      </div>`;

    return `
      <div class="adv-auto ${(autoKeys.length || setKeys.length) ? '' : 'none'}">
        ${autoKeys.length
        ? `✓ 已自动识别 ${autoKeys.length} 类模型目录${rootsTxt ? `（扫描：${esc(rootsTxt)}）` : ''}，直接点「保存路径」即可生效`
        : setKeys.length
          ? `已手动指定 ${setKeys.length} 类模型目录，引擎启动时会写进 <code>extra_model_paths.yaml</code>。想换回自动识别，把对应输入框清空再保存。`
          : `还没找到模型目录。把模型放进 <code>${esc(ownModels)}</code> 下的 checkpoints / diffusion_models / text_encoders / vae / loras，再刷新这一页就会自动认出来。`}
      </div>
      <div class="form-grid">${MODEL_PATH_FIELDS.map(field).join('')}</div>`;
  }

  V.registerView('local', {
    title: '本地配置',
    sub: 'ComfyUI 引擎与模型目录 —— 都跑在这台机器上',
    actions: () => '',
    render: async (c) => {
      let cfg = {};
      try { cfg = await Comfy.engineStatus(); } catch { cfg = {}; }
      let scan = { found: {}, files: {}, roots: [] };
      try { scan = (await Comfy.scanModels()) || scan; } catch { }

      // 纯静态托管（在线体验）时没有 serve.py：安装 / 启动 / 扫描都用不了，
      // 但「直连本机 ComfyUI 出图」照样可以，得说清楚，别让人以为整个页面坏了
      const hasSrv = typeof cfg.running === 'boolean';

      c.innerHTML = `
        <div style="max-width:820px">
          ${hasSrv ? '' : `<div class="page-note">
            <b>这个页面没有连到本地服务（serve.py）</b>
            <span>所以「安装 / 启动 / 重启引擎」「模型目录扫描」在这里用不了。图片库、画布、提示词都正常。
            想出图的话：先在本机用 <code>start.command</code> 启动 Loom，或直接开 ComfyUI，
            然后在下面把「服务地址」填成它的地址（默认 <code>127.0.0.1:8188</code>）—— 填对就能出图。</span>
          </div>`}
          <div class="section" style="margin-top:0" id="sec-comfy">
            <div class="section-title">ComfyUI（本地出图引擎）<span></span></div>
            <p class="hint" style="margin:0 0 11px">
              画布的「输出」节点把提示词和参考图写进工作流，交给本地引擎执行。
              ${hasSrv
                ? `<b>引擎由 Loom 托管：点「生成」时会自动拉起，不用你手动开 ComfyUI。</b>`
                : `这个页面连不上 serve.py，<b>没法替你启动引擎</b>：请先在本机把 ComfyUI 开起来，再填下面的地址。`}
            </p>

            ${hasSrv ? `<div class="install-box" id="inst-box">
              <div class="install-top">
                <div class="install-top-txt">
                  <b>还没有 ComfyUI？让 Loom 自己装</b>
                  <span>自动下载源码 → 建独立 Python 环境 → 装 PyTorch 和依赖 → 写好配置。
                  不碰系统 Python，装完下面目录会自动填好，直接点「启动引擎」。</span>
                </div>
                <button class="btn primary" data-act="engine-install">${icon('down', 14)} 下载并安装</button>
              </div>
              <div class="install-row">
                <label>安装位置</label>
                <input type="text" id="inst-target" placeholder="选一个空间够的目录，约需 15 GB" value="${esc(cfg.install?.default_target || '')}">
                <button class="btn" data-act="pick-target">选择目录…</button>
              </div>
              <div class="install-row">
                <label>选项</label>
                <select id="inst-torch">
                  <option value="auto">PyTorch：自动判断</option>
                  <option value="cpu">PyTorch：纯 CPU（小、慢）</option>
                  <option value="cu124">PyTorch：CUDA 12.4（旧卡手动选，torch 2.6）</option>
                  <option value="cu126">PyTorch：CUDA 12.6（NVIDIA 默认，推荐）</option>
                </select>
                <label class="install-check"><input type="checkbox" id="inst-mirror" checked> 用国内镜像加速</label>
              </div>
              <div class="install-panel" id="inst-panel" hidden>
                <div class="install-steps" id="inst-steps"></div>
                <div class="install-bar"><i id="inst-bar-fill"></i></div>
                <div class="install-msg" id="inst-msg"></div>
                <pre class="install-log" id="inst-log"></pre>
                <div class="install-foot">
                  <span class="hint" id="inst-hint"></span>
                  <div class="spacer"></div>
                  <button class="btn sm ghost" data-act="engine-install-cancel" id="inst-cancel">终止</button>
                </div>
              </div>
            </div>` : ''}

            <div class="form-grid">
              ${hasSrv ? `<div class="field"><label>引擎目录（ComfyUI 安装位置）</label>
                <input type="text" id="cf-dir" placeholder="~/ComfyUI 或 /path/to/ComfyUI" value="${esc(cfg.comfy_dir || '')}">
                <span class="hint">填 ComfyUI 根目录（含 main.py 的那个）。找不到会尝试自动探测常见位置。</span></div>` : ''}
              <div class="field"><label>端口</label>
                <input type="text" id="cf-port" value="${esc(String(cfg.port || 8188))}" placeholder="8188"></div>
              <div class="field"><label>服务地址（一般不用改）</label>
                <input type="text" id="cf-url" value="${esc(Comfy.base().replace(/^https?:\/\//, ''))}" placeholder="127.0.0.1:8188">
                <span class="hint">只填主机和端口即可，自动补 http://</span></div>
              <div class="field"><label>&nbsp;</label>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  ${hasSrv ? `<button class="btn primary" data-act="engine-start">${icon('spark', 14)} 启动引擎</button>` : ''}
                  <button class="btn" data-act="comfy-test">测试连接</button>
                  <button class="btn" data-act="comfy-save">保存地址</button>
                  ${hasSrv ? `<button class="btn" data-act="engine-restart">重启引擎</button>` : ''}
                </div></div>
            </div>
            <div id="comfy-stat" style="margin-top:9px;font-size:11.5px;color:var(--text-3)"></div>
          </div>

          ${hasSrv ? `<div class="section" id="sec-paths">
            <div class="section-title">模型目录<span></span></div>
            <p class="hint" style="margin:0 0 11px">
              默认就用 ComfyUI 自己的 <code>models/</code> —— 那里放对了什么都不用改。
              想把别的盘的模型也挂进来，就在下面填绝对路径，保存后 Loom 会写进
              <code>extra_model_paths.yaml</code>，<b>不用复制文件</b>。
            </p>
            <div id="mp-body">${modelPathsHTML(scan, cfg.paths || {})}</div>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <button class="btn primary" data-act="adv-save-paths">保存路径</button>
              <button class="btn" data-act="reload-local">重新扫描</button>
              <span class="hint" id="mp-stat">${cfg.running
        ? `<span style="color:var(--ok)">✓ 引擎运行中</span>（端口 ${esc(String(cfg.port || 8188))}）`
        : '引擎未运行 —— 点「生成」时会自动拉起'}</span>
            </div>
            ${cfg.log_tail ? `<details style="margin-top:12px"><summary class="hint" style="cursor:pointer">最近启动日志</summary>
              <pre style="white-space:pre-wrap;font-size:11px;color:var(--text-3);max-height:220px;overflow:auto">${esc(cfg.log_tail)}</pre></details>` : ''}
          </div>` : ''}
        </div>`;

      // 从别的页面切回来时，把还在跑的安装任务接上（进度、日志继续刷）
      try {
        const ist = await Comfy.installStatus();
        // 没有 serve.py 时拿到的是 {}：running 不是布尔、steps 为空。
        // 以前只判 ist.ok !== null，undefined 也算「有状态」，结果画出一个空面板。
        const real = ist && typeof ist.running === 'boolean' && Array.isArray(ist.steps);
        if (real && (ist.running || ist.ok !== null || ist.error)) {
          renderInstall(ist);
          if (ist.running) instStartPoll(); else instStopPoll();
        }
      } catch { /* serve.py 不在或旧版本，忽略 */ }
    }
  });

  V.on('adv-save-paths', async () => {
    const mapping = {};
    document.querySelectorAll('[data-path]').forEach(inp => {
      const v = inp.value.trim();
      if (v) mapping[inp.dataset.path] = v;
    });
    const stat = document.querySelector('#mp-stat');
    try {
      await Comfy.setEnginePaths(mapping);
      let running = false;
      try { running = !!(await Comfy.engineStatus()).running; } catch { }
      if (running) {
        if (stat) stat.innerHTML = '<span style="color:var(--text-2)">已保存，正在重启引擎…</span>';
        toast('已保存，正在重启引擎让路径生效…', 'ok');
        Comfy.restartEngine()
          .then(() => { toast('引擎已重启，模型路径生效', 'ok'); go('local'); })
          .catch((e) => toast('引擎重启失败：' + e.message, 'err'));
      } else {
        toast('路径已保存，下次启动引擎时生效', 'ok');
        go('local');
      }
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
    }
  });

  V.on('reload-local', () => go('local'));

  /* ============================================================
     AI / 智能体配置
     （原来是「设置」页里的两段，挪出来单独一页）
     ============================================================ */
  V.registerView('ai', {
    title: 'AI 智能体',
    sub: '决定「谁来帮你写提示词」—— 不配也能正常出图',
    actions: () => '',
    render: async (c) => {
      const providers = AI.providers();
      const agents = AI.agents();

      const providerRows = providers.map(p => `
        <div class="entity">
          <div class="entity-mark">${esc(providerMark(p))}</div>
          <div class="entity-main">
            <b>${esc(p.name)}</b>
            <small>${esc((p.baseUrl || '').replace(/^https?:\/\//, ''))}</small>
            <em>${esc((p.models || []).join(' · ') || '未指定模型')}</em>
          </div>
          ${providerTag(p)}
          <div class="entity-ops">
            <button class="icon-btn" data-act="provider-test" data-id="${p.id}" title="测试连接">${icon('check', 14)}</button>
            <button class="icon-btn" data-act="provider-edit" data-id="${p.id}" title="编辑">${icon('edit', 14)}</button>
            <button class="icon-btn" data-act="provider-del" data-id="${p.id}" title="删除">${icon('trash', 14)}</button>
          </div>
        </div>`).join('');

      const agentRows = agents.map(a => {
        const p = AI.providerById(a.providerId);
        const model = a.model || (p?.models || [])[0] || '未指定模型';
        return `<div class="entity">
          <div class="entity-mark">${esc((a.name || '?').slice(0, 1))}</div>
          <div class="entity-main">
            <b>${esc(a.name)}</b>
            <small>${esc(p?.name || '未指定服务商')} · ${esc(model)} · 温度 ${esc(String(a.temperature ?? 0.9))}</small>
            <em>${esc(a.brief || '')}</em>
          </div>
          <div class="entity-ops">
            <button class="icon-btn" data-act="agent-test" data-id="${a.id}" title="用这个智能体测一次">${icon('check', 14)}</button>
            <button class="icon-btn" data-act="agent-edit" data-id="${a.id}" title="编辑">${icon('edit', 14)}</button>
            <button class="icon-btn" data-act="agent-del" data-id="${a.id}" title="删除">${icon('trash', 14)}</button>
          </div>
        </div>`;
      }).join('');

      c.innerHTML = `
        <div style="max-width:820px">
          <div class="section" style="margin-top:0" id="sec-providers">
            <div class="section-title">AI 服务商<span></span></div>
            <p class="hint" style="margin:0 0 11px">
              接口端点，可以同时放多个：DeepSeek、智谱 GLM、本地 Ollama / LM Studio、OpenAI 或任意 OpenAI 兼容网关。
              谁便宜谁快就用谁，智能体再去挑。<b>不配也能用，图库和画布不依赖它。</b>
            </p>
            <div class="entity-list">${providerRows || '<div class="empty-mini">还没有服务商，点下面「添加服务商」</div>'}</div>
            <div style="margin-top:10px">
              <button class="btn sm" data-act="provider-new">${icon('plus', 13)} 添加服务商</button>
            </div>
          </div>

          <div class="section" id="sec-agents">
            <div class="section-title">智能体<span></span></div>
            <p class="hint" style="margin:0 0 11px">
              智能体 = 服务商 + 模型 + 一套人设（系统提示词 + 温度）。出图时在面板顶部选谁写。
            </p>
            <div class="entity-list">${agentRows || '<div class="empty-mini">还没有智能体，点下面「新建智能体」</div>'}</div>
            <div style="margin-top:10px">
              <button class="btn sm" data-act="agent-new">${icon('plus', 13)} 新建智能体</button>
            </div>
          </div>
        </div>`;
    }
  });

  V.registerView('settings', {
    title: '设置',
    sub: 'bug 反馈、数据备份、存储占用与关于 —— 引擎和 AI 各有单独一页',
    actions: () => '',
    render: async (c) => {
      c.innerHTML = `
        <div style="display:flex;gap:36px;align-items:flex-start;flex-wrap:wrap">
        <div style="max-width:820px;flex:1 1 620px;min-width:0">
          <div class="section">
            <div class="section-title">数据<span></span></div>
            <p class="hint" style="margin:0 0 10px">图片与元数据都存在这台机器的浏览器 IndexedDB 里。换设备或重装浏览器前记得导出。</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" data-act="set-export">${icon('down', 14)} 导出元数据 JSON</button>
              <button class="btn" data-act="set-import">${icon('upload', 14)} 导入 JSON</button>
              <button class="btn" data-act="ref-cache-clear">清理高清原图缓存</button>
              <button class="btn danger" data-act="set-wipe">清空全部数据</button>
            </div>
            <div style="margin-top:14px;font-size:12px;color:var(--text-2)">
              当前：<b style="color:var(--text)">${V.state.images.length}</b> 张图 ·
              <b style="color:var(--text)">${V.state.models.length}</b> 个模型 ·
              <b style="color:var(--text)">${V.state.loras.length}</b> 个 LoRA ·
              <b style="color:var(--text)">${V.state.workflows.length}</b> 个工作流 ·
              <b style="color:var(--text)">${AI.agents().length}</b> 个智能体
            </div>
            <div id="set-storage" style="margin-top:8px;font-size:12px;color:var(--text-3)"></div>
          </div>

          <div class="section">
            <div class="section-title">反馈<span></span></div>
            <p class="hint" style="margin:0;line-height:1.9">
              如遇到软件 bug，请及时反馈：<br>
              · 邮箱：<a href="mailto:517298997@qq.com">517298997@qq.com</a><br>
              · QQ：19744249（添加请备注来源）
            </p>
          </div>

          <div class="section">
            <div class="section-title">关于<span></span></div>
            <p class="hint" style="margin:0;line-height:1.9">
              Loom 织造所 v0.2 · 零依赖单页应用，数据全部本地。<br>
              PNG 内嵌参数（A1111 / ComfyUI / NovelAI）上传时自动解析；提示词采用版本链，AI 重写只追加新版本，不覆盖旧的。<br>
              所有文件在 <code>loom-vault/</code> 目录下，备份直接拷走整个文件夹即可。
            </p>
            <div class="about-links">
              <a href="https://github.com/Atom-kkk/loom-vault" target="_blank" rel="noopener">项目仓库</a>
              <a href="https://github.com/Atom-kkk" target="_blank" rel="noopener">GitHub 主页</a>
              <a href="https://www.iesdouyin.com/share/user/MS4wLjABAAAAQc4NN1_Ms30-2s2a5hjyZ2CweDIDkX2eSwaure41sOyXx7ogYtv8fmsKsAgB9lZv" target="_blank" rel="noopener">抖音主页</a>
            </div>
          </div>
        </div>

        <div style="flex:0 1 300px;position:sticky;top:18px">
          <div class="section">
            <div class="section-title">支持作者<span></span></div>
            <p class="hint" style="margin:0 0 12px;line-height:1.8">如果 Loom 让你的 AI 创作更顺畅、帮你省下了折腾环境的时间，欢迎请作者喝杯咖啡 —— 这是开源路上最温暖的动力。</p>
            <div style="display:flex;gap:10px">
              <figure style="flex:1;margin:0;text-align:center;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden">
                <div style="background:#07C160;color:#fff;font-size:12px;font-weight:600;padding:7px 0">微信支付</div>
                <img src="assets/donate-wechat.png" alt="微信支付收款码" style="width:100%;display:block;background:#fff">
                <figcaption style="font-size:11.5px;color:var(--text-2);padding:7px 0">扫码请作者喝咖啡</figcaption>
              </figure>
              <figure style="flex:1;margin:0;text-align:center;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden">
                <div style="background:#1677FF;color:#fff;font-size:12px;font-weight:600;padding:7px 0">支付宝</div>
                <img src="assets/donate-alipay.png" alt="支付宝收款码" style="width:100%;display:block;background:#fff">
                <figcaption style="font-size:11.5px;color:var(--text-2);padding:7px 0">扫码请作者喝咖啡</figcaption>
              </figure>
            </div>
            <p class="hint" style="margin:10px 0 0;font-size:11px">扫码即可 · 金额随意，没预算也没关系，用得开心就好</p>
          </div>
        </div>
        </div>`;

      const { used, quota } = await DB.usage();
      const el = c.querySelector('#set-storage');
      if (el) el.textContent = used
        ? `已占用 ${U.fmtSize(used)}${quota ? ' / 配额 ' + U.fmtSize(quota) : ''}`
        : '浏览器未提供存储配额信息';

    }
  });

  /* ============================================================
     ComfyUI
     ============================================================ */
  function comfyUrlFromInput() {
    let v = (document.querySelector('#cf-url')?.value || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//.test(v)) v = 'http://' + v;
    return v.replace(/\/+$/, '');
  }

  V.on('comfy-save', () => {
    const url = comfyUrlFromInput();
    if (!url) return toast('地址不能为空', 'err');
    Comfy.save({ baseUrl: url });
    toast('已保存', 'ok');
  });

  // 引擎目录 / 端口配置写入 serve.py
  V.on('engine-start', async (el) => {
    const dir = (document.querySelector('#cf-dir')?.value || '').trim();
    const port = (document.querySelector('#cf-port')?.value || '').trim();
    const url = comfyUrlFromInput();
    if (url) Comfy.save({ baseUrl: url });

    const stat = document.querySelector('#comfy-stat');
    if (dir) {
      try { await Comfy.setEngineConfig({ comfy_dir: dir, port: port || 8188 }); }
      catch (e) { toast(e.message, 'err'); }
    }
    if (stat) stat.innerHTML = '<span style="color:var(--text-2)">正在启动引擎…（首次较慢，请稍候）</span>';
    try {
      const r = await Comfy.ensureEngine(() => {});
      if (stat) stat.innerHTML = `<span style="color:var(--ok)">✓ 引擎就绪</span>（${esc(r.message || '')}）`;
      toast('本地引擎已启动', 'ok');
    } catch (e) {
      if (stat) stat.innerHTML = `<span style="color:var(--danger)">✕ ${esc(e.message)}</span>`;
      toast(e.message, 'err');
    }
  });

  /* ---------------- 一键安装 ComfyUI ---------------- */
  let instTimer = null;

  function instQ(id) { return document.querySelector('#' + id); }

  function instStopPoll() {
    if (instTimer) { clearInterval(instTimer); instTimer = null; }
  }

  function instStartPoll() {
    instStopPoll();
    instTimer = setInterval(() => { pollInstall(); }, 1200);
  }

  function renderInstall(st) {
    const panel = instQ('inst-panel');
    if (!panel) return false;
    panel.hidden = false;

    const steps = st.steps || [];
    const marks = { done: '✓', skip: '✓', fail: '✕', running: '•', cancel: '–', pending: '' };
    instQ('inst-steps').innerHTML = steps.map((s, i) => {
      const mk = s.state === 'pending' ? String(i + 1) : marks[s.state] || '';
      return `<span class="inst-step ${s.state}"><i>${mk}</i>${esc(s.label)}</span>`;
    }).join('<em class="inst-sep">›</em>');

    const done = steps.filter(s => s.state === 'done' || s.state === 'skip').length;
    const failed = steps.some(s => s.state === 'fail');
    const pct = st.ok ? 100 : Math.round((done / (steps.length || 1)) * 100);
    const fill = instQ('inst-bar-fill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.dataset.state = st.ok ? 'ok' : failed ? 'fail' : '';
    }

    const msg = instQ('inst-msg');
    if (msg) {
      if (st.running) {
        const cur = steps.find(s => s.state === 'running');
        msg.className = 'install-msg';
        msg.innerHTML = `<span class="spin"></span> ${esc(cur ? cur.label : '处理中')}… <em>已用 ${st.elapsed || 0}s</em>`;
      } else if (st.ok) {
        msg.className = 'install-msg ok';
        msg.innerHTML = `✓ 安装完成，用时 ${st.elapsed || 0}s。引擎目录已写入配置，可以点「启动引擎」了。`;
      } else if (st.canceled) {
        msg.className = 'install-msg';
        msg.innerHTML = `■ 已取消。已下载的源码/环境会保留，再点一次安装会接着用。`;
      } else if (st.error) {
        msg.className = 'install-msg fail';
        msg.innerHTML = `✕ ${esc(st.error)}`;
      } else {
        msg.className = 'install-msg';
        msg.textContent = '';
      }
    }

    const logEl = instQ('inst-log');
    if (logEl) {
      const lines = st.log || [];
      logEl.textContent = lines.join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }

    const cancel = instQ('inst-cancel');
    if (cancel) cancel.disabled = !st.running;
    return true;
  }

  async function pollInstall() {
    let st;
    try { st = await Comfy.installStatus(); } catch { return; }
    if (!renderInstall(st)) { instStopPoll(); return; }
    if (!st.running) {
      instStopPoll();
      if (st.ok) {
        const dir = instQ('cf-dir');
        if (dir && st.comfy_dir) dir.value = st.comfy_dir;
        const stat = instQ('comfy-stat');
        if (stat) stat.innerHTML = `<span style="color:var(--ok)">✓ 已装好</span> ${esc(st.comfy_dir || '')}`;
        toast('ComfyUI 安装完成', 'ok');
      } else if (st.error && !st.canceled) {
        toast('安装失败：' + st.error, 'err');
      }
    }
  }

  V.on('engine-install', async (el) => {
    const target = (instQ('inst-target')?.value || '').trim();
    if (!target) return toast('先选一个安装位置', 'err');
    const payload = {
      target_dir: target,
      torch: instQ('inst-torch')?.value || 'auto',
      mirror: !!instQ('inst-mirror')?.checked,
    };
    const stat = instQ('comfy-stat');
    if (stat) stat.textContent = '';
    el.disabled = true;
    try {
      const st = await Comfy.installStart(payload);
      renderInstall(st);
      instStartPoll();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      el.disabled = false;
    }
  });

  V.on('pick-target', async (el) => {
    const cur = (instQ('inst-target')?.value || '').trim();
    el.disabled = true;
    const old = el.textContent;
    el.textContent = '选择中…';
    try {
      const p = await Comfy.pickDir(cur, '选择 ComfyUI 安装位置');
      if (p) {
        instQ('inst-target').value = p;
        toast('已选：' + p, 'ok');
      }
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      el.disabled = false;
      el.textContent = old;
    }
  });

  V.on('engine-install-cancel', async () => {
    try {
      await Comfy.installCancel();
      toast('已发终止，稍等日志收尾', 'warn');
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  V.on('comfy-test', async (el) => {
    const url = comfyUrlFromInput();
    if (!url) return toast('先填地址', 'err');
    Comfy.save({ baseUrl: url });
    el.disabled = true;
    const old = el.textContent;
    el.textContent = '连接中…';
    const stat = document.querySelector('#comfy-stat');
    try {
      const r = await Comfy.ping();
      const dev = r?.devices?.[0]?.name || r?.system?.python_version || '';
      if (stat) stat.innerHTML = `<span style="color:var(--ok)">✓ 连接正常</span> ${esc(dev)}`;
      toast('ComfyUI 连接正常', 'ok');
    } catch (e) {
      if (stat) stat.innerHTML = `<span style="color:var(--danger)">✕ ${esc(e.message)}</span>`;
      toast(e.message, 'err');
    } finally {
      el.disabled = false;
      el.textContent = old;
    }
  });

  /* ============================================================
     服务商表单
     ============================================================ */
  function providerForm(p) {
    const isNew = !p;
    p = p || AI.defaultProvider('deepseek');
    let key = p.key || 'deepseek';

    openModal({
      title: isNew ? '添加服务商' : '编辑服务商',
      sub: '填接口地址和 Key；本地服务不需要 Key',
      wide: true,
      body: `
        <div class="field full" style="margin-bottom:14px">
          <label>类型</label>
          <div class="chips" id="pf-types">
            ${AI.PROVIDER_PRESETS.map(x => `<button type="button" class="chip ${key === x.key ? 'active' : ''}" data-k="${x.key}">${x.label}</button>`).join('')}
          </div>
          <span class="hint" id="pf-hint" style="margin-top:6px"></span>
        </div>
        <div class="form-grid">
          <div class="field"><label>名称 *</label>
            <input type="text" id="pf-name" value="${esc(p.name || '')}"></div>
          <div class="field"><label>API Key</label>
            <input type="password" id="pf-key" value="${esc(p.apiKey || '')}" placeholder="${AI.presetOf(key).needKey ? '粘贴 API Key' : '本地服务通常留空'}"></div>
          <div class="field full"><label>接口地址</label>
            <input type="text" id="pf-url" value="${esc(p.baseUrl || '')}" placeholder="https://api.deepseek.com">
            <span class="hint">填到 /v1 或根地址即可，会自动补 /chat/completions</span></div>
          <div class="field full"><label>模型（每行一个）</label>
            <textarea id="pf-models" style="min-height:88px;font-family:var(--mono);font-size:12px">${esc((p.models || []).join('\n'))}</textarea>
            <div style="display:flex;gap:6px;margin-top:6px">
              <button type="button" class="btn sm ghost" id="pf-fetch">从服务商拉取模型列表</button>
            </div></div>
        </div>`,
      footer: `<button class="btn" id="pf-test">测试连接</button>
               <div class="spacer"></div>
               <button class="btn" data-close>取消</button>
               <button class="btn primary" id="pf-save">保存</button>`,
      onMount: (box, close) => {
        const hint = box.querySelector('#pf-hint');
        const syncHint = () => {
          const preset = AI.presetOf(key);
          hint.textContent = preset.hint || '';
          box.querySelector('#pf-key').placeholder = preset.needKey ? '粘贴 API Key' : '本地服务通常留空';
        };
        syncHint();

        box.querySelectorAll('#pf-types .chip').forEach(chip => {
          chip.onclick = () => {
            const k = chip.dataset.k;
            const preset = AI.presetOf(k);
            const changed = k !== key;
            key = k;
            box.querySelectorAll('#pf-types .chip').forEach(x => x.classList.toggle('active', x === chip));
            if (changed) {
              box.querySelector('#pf-url').value = preset.baseUrl;
              box.querySelector('#pf-name').value = preset.label;
              box.querySelector('#pf-models').value = preset.models.join('\n');
            }
            syncHint();
          };
        });

        const draft = () => ({
          id: p.id || 'draft',
          key,
          name: box.querySelector('#pf-name').value.trim() || AI.presetOf(key).label,
          baseUrl: box.querySelector('#pf-url').value.trim(),
          apiKey: box.querySelector('#pf-key').value.trim(),
          models: box.querySelector('#pf-models').value.split('\n').map(s => s.trim()).filter(Boolean)
        });

        box.querySelector('#pf-fetch').onclick = async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true; btn.textContent = '拉取中…';
          try {
            const list = await AI.listModels(draft());
            if (!list.length) throw new Error('服务商返回空列表');
            box.querySelector('#pf-models').value = list.join('\n');
            toast(`拉到 ${list.length} 个模型`, 'ok');
          } catch (e) {
            toast(e.message, 'err');
          } finally {
            btn.disabled = false; btn.textContent = '从服务商拉取模型列表';
          }
        };

        box.querySelector('#pf-test').onclick = async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = '测试中…';
          try {
            const d = draft();
            if (!d.models.length) throw new Error('先填一个模型名再测试');
            const r = await AI.test(d, d.models[0]);
            toast('连接正常：' + r, 'ok');
          } catch (e) {
            toast(e.message, 'err');
          } finally {
            btn.disabled = false;
            btn.textContent = '测试连接';
          }
        };

        box.querySelector('#pf-save').onclick = async () => {
          const name = box.querySelector('#pf-name').value.trim();
          if (!name) return toast('名称不能为空', 'err');
          const models = box.querySelector('#pf-models').value.split('\n').map(s => s.trim()).filter(Boolean);
          if (!models.length) return toast('至少填一个模型名', 'err');
          const obj = {
            ...p,
            id: p.id || undefined,
            key, name, models,
            baseUrl: box.querySelector('#pf-url').value.trim(),
            apiKey: box.querySelector('#pf-key').value.trim()
          };
          if (!obj.id) obj.id = U.uid('prv');
          await AI.upsertProvider(obj);
          close();
          V.render();
          toast('服务商已保存', 'ok');
        };
      }
    });
  }

  V.on('provider-new', () => providerForm(null));
  V.on('provider-edit', el => providerForm(AI.providerById(el.dataset.id)));
  V.on('provider-del', async el => {
    const p = AI.providerById(el.dataset.id);
    if (AI.providers().length <= 1) return toast('至少保留一个服务商', 'err');
    const ok = await confirmDialog({
      title: '删除服务商？',
      message: `「${p.name}」会被移除；用它写的智能体会自动切到第一个服务商。`,
      danger: true, okText: '删除'
    });
    if (!ok) return;
    await AI.removeProvider(p.id);
    V.render();
    toast('已删除', 'ok');
  });
  V.on('provider-test', async el => {
    toast('正在测试…');
    try {
      const p = AI.providerById(el.dataset.id);
      const r = await AI.test(p.id, (p.models || [])[0]);
      toast(`${p.name} 连接正常：${r}`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  /* ============================================================
     智能体表单
     ============================================================ */
  function agentForm(a) {
    const isNew = !a;
    const firstProvider = AI.providers()[0];
    a = a || {
      name: '', brief: '',
      providerId: firstProvider?.id || '',
      model: firstProvider?.models?.[0] || '',
      temperature: 0.9,
      systemPrompt: AI.AGENT_PRESETS[0].systemPrompt
    };

    const providerOpts = AI.providers()
      .map(p => `<option value="${p.id}" ${a.providerId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

    openModal({
      title: isNew ? '新建智能体' : '编辑智能体',
      sub: '服务商决定用哪个接口，人设决定它怎么写提示词',
      wide: true,
      body: `
        <div class="field full" style="margin-bottom:14px">
          <label>从预设起步（可改）</label>
          <div class="chips" id="af-presets">
            ${AI.AGENT_PRESETS.map(x => `<button type="button" class="chip" data-k="${x.key}">${esc(x.name)}</button>`).join('')}
          </div>
          <span class="hint" style="margin-top:6px">点一下会把对应的人设、温度填进来，之后随便改。</span>
        </div>
        <div class="form-grid">
          <div class="field"><label>名称 *</label>
            <input type="text" id="af-name" value="${esc(a.name || '')}" placeholder="我的写实摄影助手"></div>
          <div class="field"><label>温度</label>
            <input type="text" id="af-temp" value="${esc(String(a.temperature ?? 0.9))}" placeholder="0.9">
            <span class="hint">低更稳定，高更发散</span></div>
          <div class="field full"><label>一句话简介</label>
            <input type="text" id="af-brief" value="${esc(a.brief || '')}" placeholder="强调镜头与胶片质感"></div>
          <div class="field"><label>服务商</label>
            <select id="af-provider">${providerOpts}</select></div>
          <div class="field"><label>模型</label>
            <input type="text" id="af-model" value="${esc(a.model || '')}" list="af-models" placeholder="留空用服务商默认">
            <datalist id="af-models"></datalist></div>
          <div class="field full"><label>系统提示词（人设）</label>
            <textarea id="af-sys" style="min-height:170px;font-family:var(--mono);font-size:12px">${esc(a.systemPrompt || '')}</textarea>
            <span class="hint">这段话决定它怎么写。想要「只出短提示词」「只写负面词」这类行为，改这里就行。</span></div>
        </div>`,
      footer: `<button class="btn" id="af-test">用这个智能体测一次</button>
               <div class="spacer"></div>
               <button class="btn" data-close>取消</button>
               <button class="btn primary" id="af-save">保存</button>`,
      onMount: (box, close) => {
        const modelInput = box.querySelector('#af-model');
        const list = box.querySelector('#af-models');
        const provSel = box.querySelector('#af-provider');

        const syncModels = () => {
          const p = AI.providerById(provSel.value);
          list.innerHTML = (p?.models || []).map(m => `<option value="${esc(m)}"></option>`).join('');
        };
        syncModels();
        provSel.onchange = syncModels;

        box.querySelectorAll('#af-presets .chip').forEach(chip => {
          chip.onclick = () => {
            const preset = AI.AGENT_PRESETS.find(x => x.key === chip.dataset.k);
            if (!preset) return;
            box.querySelector('#af-name').value = preset.name;
            box.querySelector('#af-brief').value = preset.brief;
            box.querySelector('#af-temp').value = preset.temperature;
            box.querySelector('#af-sys').value = preset.systemPrompt;
            box.querySelectorAll('#af-presets .chip').forEach(x => x.classList.toggle('active', x === chip));
          };
        });

        const collect = () => ({
          ...a,
          id: a.id || undefined,
          name: box.querySelector('#af-name').value.trim(),
          brief: box.querySelector('#af-brief').value.trim(),
          providerId: provSel.value,
          model: modelInput.value.trim(),
          temperature: Number(box.querySelector('#af-temp').value) || 0.9,
          systemPrompt: box.querySelector('#af-sys').value.trim()
        });

        box.querySelector('#af-test').onclick = async (ev) => {
          const btn = ev.currentTarget;
          const obj = collect();
          if (!obj.name) return toast('先填个名称', 'err');
          btn.disabled = true; btn.textContent = '测试中…';
          try {
            const r = await AI.test(obj.providerId, obj.model);
            toast('智能体可用：' + r, 'ok');
          } catch (e) {
            toast(e.message, 'err');
          } finally {
            btn.disabled = false; btn.textContent = '用这个智能体测一次';
          }
        };

        box.querySelector('#af-save').onclick = async () => {
          const obj = collect();
          if (!obj.name) return toast('名称不能为空', 'err');
          if (!obj.systemPrompt) return toast('系统提示词不能为空', 'err');
          if (!obj.id) obj.id = U.uid('agt');
          await AI.upsertAgent(obj);
          close();
          V.render();
          toast('智能体已保存', 'ok');
        };
      }
    });
  }

  V.on('agent-new', () => agentForm(null));
  V.on('agent-edit', el => agentForm(AI.agentById(el.dataset.id)));
  V.on('agent-del', async el => {
    const a = AI.agentById(el.dataset.id);
    if (AI.agents().length <= 1) return toast('至少保留一个智能体', 'err');
    const ok = await confirmDialog({
      title: '删除智能体？',
      message: `「${a.name}」会被移除，已经用它写过的提示词版本不受影响。`,
      danger: true, okText: '删除'
    });
    if (!ok) return;
    await AI.removeAgent(a.id);
    V.render();
    toast('已删除', 'ok');
  });
  V.on('agent-test', async el => {
    const a = AI.agentById(el.dataset.id);
    toast(`正在用「${a.name}」测试…`);
    try {
      const r = await AI.test(a.providerId, a.model);
      toast(`${a.name} 可用：${r}`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  /* ============================================================
     数据
     ============================================================ */
  V.on('ref-cache-clear', async () => {
    const n = window.REF?.clearHiCache ? await REF.clearHiCache() : 0;
    const m = window.LIB?.clearHiCache ? await LIB.clearHiCache() : 0;
    const total = n + m;
    toast(total ? `已清理 ${total} 张高清原图缓存，缩略图仍保留` : '没有需要清理的高清缓存', 'ok');
  });

  V.on('set-export', async () => {
    const payload = await DB.exportMeta();
    U.download(`织造所-元数据-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    toast('已导出（不含图片文件）', 'ok');
  });

  V.on('set-import', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        const payload = JSON.parse(await f.text());
        const report = await DB.importMeta(payload);
        await V.reload();
        await AI.load();
        V.renderNav();
        V.render();
        toast(`导入完成：${report.images} 图 / ${report.models} 模型 / ${report.loras} LoRA`, 'ok');
      } catch (e) {
        toast('导入失败：' + e.message, 'err');
      }
    };
    inp.click();
  });

  V.on('set-wipe', async () => {
    const ok = await confirmDialog({
      title: '清空全部数据？',
      message: '所有图片、模型、LoRA、工作流、提示词都会被永久删除，无法恢复。建议先导出备份。',
      danger: true, okText: '确认清空'
    });
    if (!ok) return;
    for (const s of ['images', 'blobs', 'models', 'loras', 'workflows', 'categories', 'meta']) {
      await DB.clear(s);
    }
    await DB.ensureSeed();
    await V.reload();
    V.renderNav();
    V.render();
    toast('已清空', 'ok');
  });
})();
