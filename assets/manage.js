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
    title: '模型库',
    sub: () => `${V.state.models.length} 个模型 · 云端 API 与本地 ComfyUI 部署都记在这里`,
    actions: () => `
      <button class="btn" data-act="model-export-all">${icon('down', 15)} 导出全部清单</button>
      <button class="btn primary" data-act="model-new">${icon('plus', 15)} 添加模型</button>`,
    render: async (c) => {
      const tab = V.state.filter.modelTab || 'all';
      const list = V.state.models.filter(m => tab === 'all' || m.type === tab);
      c.innerHTML = `
        <div class="chips" style="margin-bottom:16px">
          <button class="chip ${tab === 'all' ? 'active' : ''}" data-act="model-tab" data-tab="all">全部 <span class="n">${V.state.models.length}</span></button>
          <button class="chip ${tab === 'cloud' ? 'active' : ''}" data-act="model-tab" data-tab="cloud">云端 <span class="n">${V.state.models.filter(m => m.type === 'cloud').length}</span></button>
          <button class="chip ${tab === 'local' ? 'active' : ''}" data-act="model-tab" data-tab="local">本地 <span class="n">${V.state.models.filter(m => m.type === 'local').length}</span></button>
        </div>
        ${list.length ? `<div class="model-grid">${list.map(modelCard).join('')}</div>`
          : `<div class="empty">${icon('cpu', 40)}<b>还没有模型</b><p>点右上角「添加模型」，把常用的云端模型和本地 ComfyUI 部署都登记进来。</p></div>`}`;
    }
  });

  V.on('model-tab', el => { V.state.filter.modelTab = el.dataset.tab; V.render(); });
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
      sub: '云端模型记访问方式；本地模型记 ComfyUI 地址、基座与全部部署文件',
      wide: true,
      body: `
        <div class="form-grid">
          <div class="field"><label>模型名称 *</label>
            <input type="text" id="m-name" value="${esc(m.name || '')}" placeholder="krea2 / GPT Image 2.5 / Flux.1 dev"></div>
          <div class="field"><label>类型</label>
            <div class="seg" id="m-type">
              <button data-t="cloud" class="${m.type !== 'local' ? 'active' : ''}">云端 API</button>
              <button data-t="local" class="${m.type === 'local' ? 'active' : ''}">本地部署</button>
            </div>
          </div>
          <div class="field"><label>平台 / 服务商</label>
            <input type="text" id="m-platform" value="${esc(m.platform || '')}" placeholder="OpenAI / ComfyUI / 即梦 / 自建">
          </div>
          <div class="field"><label>基座 / 系列</label>
            <input type="text" id="m-base" value="${esc(m.base || '')}" placeholder="krea2 / SDXL / Flux.1 / gpt-image"></div>
          <div class="field"><label>版本</label>
            <input type="text" id="m-version" value="${esc(m.version || '')}" placeholder="v1.0 / fp16"></div>
          <div class="field"><label>访问方式（云端）</label>
            <input type="text" id="m-access" value="${esc(m.access || '')}" placeholder="网页 / API / 本地接口"></div>
          <div class="field full"><label>说明</label>
            <textarea id="m-desc" style="min-height:60px">${esc(m.desc || '')}</textarea></div>

          <div class="field full local-only"><label>ComfyUI 服务地址</label>
            <input type="text" id="m-endpoint" value="${esc(m.endpoint || '')}" placeholder="http://127.0.0.1:8188">
            <span class="hint">本地跑 ComfyUI 时默认 8188；填了以后可以在这里一键打开。</span></div>
          <div class="field full local-only"><label>模型放置根目录</label>
            <input type="text" id="m-install" value="${esc(m.installPath || '')}" placeholder="ComfyUI/models/checkpoints"></div>
        </div>

        <div class="section local-only">
          <div class="section-title">部署文件清单<span></span></div>
          <p class="hint" style="margin:0 0 9px">主模型、LoRA、VAE、CLIP、ControlNet…… 每个文件一行，填下载链接。导出时会生成完整的部署清单和下载脚本。</p>
          <div id="m-files">${(m.files || []).map(fileRow).join('')}</div>
          <button class="btn sm" id="m-add-file">${icon('plus', 13)} 添加文件</button>
        </div>`,
      footer: `${!isNew ? `<button class="btn danger" id="m-del">${icon('trash', 14)} 删除</button>` : ''}
               <div class="spacer"></div>
               <button class="btn" data-close>取消</button>
               <button class="btn primary" id="m-save">保存</button>`,
      onMount: (box, close) => {
        let type = m.type || 'local';
        const syncType = () => {
          box.querySelectorAll('.local-only').forEach(e => e.style.display = type === 'local' ? '' : 'none');
        };
        box.querySelectorAll('#m-type button').forEach(b => {
          b.onclick = () => {
            type = b.dataset.t;
            box.querySelectorAll('#m-type button').forEach(x => x.classList.toggle('active', x === b));
            syncType();
          };
        });
        syncType();

        const filesWrap = box.querySelector('#m-files');
        bindFileRows(filesWrap, box.querySelector('#m-add-file'));

        box.querySelector('#m-save').onclick = async () => {
          const name = box.querySelector('#m-name').value.trim();
          if (!name) return toast('模型名称不能为空', 'err');
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
            files: type === 'local' ? readFileRows(filesWrap) : (m.files || []),
            updatedAt: Date.now()
          };
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
  V.registerView('loras', {
    title: 'LoRA',
    sub: () => `${V.state.loras.length} 个 LoRA · 记录基座、触发词与下载链接`,
    actions: () => `<button class="btn primary" data-act="lora-new">${icon('plus', 15)} 添加 LoRA</button>`,
    render: async (c) => {
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
    title: '工作流',
    sub: () => `${V.state.workflows.length} 个工作流 · 上传 ComfyUI 导出的 JSON / PNG`,
    actions: () => `<button class="btn primary" data-act="wf-upload">${icon('upload', 15)} 上传工作流</button>`,
    render: async (c) => {
      if (!V.state.workflows.length) {
        c.innerHTML = `<div class="empty">${icon('flow', 40)}<b>还没有工作流</b>
          <p>在 ComfyUI 里「保存」或「导出 API 格式」，把 JSON 传上来。<br>带 workfow 的 PNG 也支持，会自动数出节点数。</p></div>`;
        return;
      }
      c.innerHTML = `<div class="model-grid">${V.state.workflows.map(w => {
        const m = V.state.models.find(x => x.id === w.modelId);
        return `<div class="model-card">
          <div class="model-card-head">
            <div class="model-card-icon" style="background:var(--panel-3);color:var(--text-2)">${icon('flow', 17)}</div>
            <div style="min-width:0">
              <h3>${esc(w.name)}</h3>
              <div class="sub">${esc(m?.name || '未关联模型')} · ${esc(w.format === 'ui-json' ? 'UI 格式' : w.format === 'api-json' ? 'API 格式' : (w.format || 'json'))}</div>
            </div>
            <div class="spacer"></div>
            <div style="display:flex;gap:4px">
              ${w.format === 'ui-json' ? `<button class="icon-btn" data-act="wf-convert" data-id="${w.id}" title="转成可提交的 API 格式">${icon('spark', 14)}</button>` : ''}
              <button class="icon-btn" data-act="wf-download" data-id="${w.id}" title="下载">${icon('down', 14)}</button>
              <button class="icon-btn" data-act="wf-del" data-id="${w.id}" title="删除">${icon('trash', 14)}</button>
            </div>
          </div>
          ${w.note ? `<p class="desc">${esc(w.note)}</p>` : ''}
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
    await V.reload(); V.renderNav(); V.render();
    toast('已删除', 'ok');
  });

  /* ============================================================
     分类
     ============================================================ */
  V.registerView('categories', {
    title: '分类',
    sub: () => `${V.state.categories.length} 个分类 · 编号按分类前缀自动续号`,
    actions: () => `<button class="btn primary" data-act="cat-new">${icon('plus', 15)} 新建分类</button>`,
    render: async (c) => {
      const rows = V.state.categories.map(cat => {
        const n = V.state.images.filter(i => i.categoryId === cat.id).length;
        const seq = Math.max(0, ...V.state.images.filter(i => i.categoryId === cat.id)
          .map(i => Number(String(i.id).split('-').pop()) || 0));
        return `<tr>
          <td><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:99px;background:${cat.color || 'var(--text-3)'};margin-right:8px"></span>${esc(cat.name)}</td>
          <td class="mono">${esc(cat.prefix)}-${U.pad(seq, 4)}</td>
          <td>${n}</td>
          <td><button class="btn sm ghost" data-act="cat-edit" data-id="${cat.id}">编辑</button>
              <button class="btn sm ghost" data-act="cat-del" data-id="${cat.id}">删除</button></td>
        </tr>`;
      }).join('');
      c.innerHTML = `<table class="file-table" style="background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden">
        <thead><tr><th>分类</th><th style="width:160px">下一个编号</th><th style="width:80px">图片数</th><th style="width:140px">操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="hint" style="margin-top:12px">编号规则：<code class="mono">前缀-四位序号</code>，按分类独立计数，删除图片不回收编号。</p>`;
    }
  });

  V.on('cat-new', () => catForm(null));
  V.on('cat-edit', el => catForm(V.state.categories.find(c => c.id === el.dataset.id)));
  V.on('cat-del', async el => {
    const cat = V.state.categories.find(c => c.id === el.dataset.id);
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
    await V.reload(); V.renderNav(); V.render();
    toast('已删除', 'ok');
  });

  function catForm(cat) {
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

  V.registerView('settings', {
    title: '设置',
    sub: 'AI 服务商与智能体、数据备份与本地存储',
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
          <div class="section" style="margin-top:0" id="sec-comfy">
            <div class="section-title">ComfyUI（本地出图）<span></span></div>
            <p class="hint" style="margin:0 0 11px">
              画布的「生成」节点把提示词和参考图写进工作流，提交给这个地址执行。
              需要 ComfyUI 允许跨域：启动时加 <code>--enable-cors-header</code>。
            </p>
            <div class="form-grid">
              <div class="field"><label>服务地址</label>
                <input type="text" id="cf-url" value="${esc(Comfy.base().replace(/^https?:\/\//, ''))}" placeholder="127.0.0.1:8188">
                <span class="hint">只填主机和端口即可，自动补 http://</span></div>
              <div class="field"><label>&nbsp;</label>
                <div style="display:flex;gap:8px">
                  <button class="btn" data-act="comfy-test">测试连接</button>
                  <button class="btn primary" data-act="comfy-save">保存</button>
                </div></div>
            </div>
            <div id="comfy-stat" style="margin-top:9px;font-size:11.5px;color:var(--text-3)"></div>
          </div>

          <div class="section" id="sec-providers">
            <div class="section-title">AI 服务商<span></span></div>
            <p class="hint" style="margin:0 0 11px">
              接口端点，可以同时放多个：DeepSeek、智谱 GLM、本地 Ollama / LM Studio、OpenAI 或任意 OpenAI 兼容网关。
              谁便宜谁快就用谁，智能体再去挑。
            </p>
            <div class="entity-list">${providerRows}</div>
            <div style="margin-top:10px">
              <button class="btn sm" data-act="provider-new">${icon('plus', 13)} 添加服务商</button>
            </div>
          </div>

          <div class="section" id="sec-agents">
            <div class="section-title">智能体<span></span></div>
            <p class="hint" style="margin:0 0 11px">
              智能体 = 服务商 + 模型 + 一套人设（系统提示词 + 温度）。出图时在面板顶部选谁写。
            </p>
            <div class="entity-list">${agentRows}</div>
            <div style="margin-top:10px">
              <button class="btn sm" data-act="agent-new">${icon('plus', 13)} 新建智能体</button>
            </div>
          </div>

          <div class="section">
            <div class="section-title">数据<span></span></div>
            <p class="hint" style="margin:0 0 10px">图片与元数据都存在这台机器的浏览器 IndexedDB 里。换设备或重装浏览器前记得导出。</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" data-act="set-export">${icon('down', 14)} 导出元数据 JSON</button>
              <button class="btn" data-act="set-import">${icon('upload', 14)} 导入 JSON</button>
              <button class="btn danger" data-act="set-wipe">清空全部数据</button>
            </div>
            <div style="margin-top:14px;font-size:12px;color:var(--text-2)">
              当前：<b style="color:var(--text)">${V.state.images.length}</b> 张图 ·
              <b style="color:var(--text)">${V.state.models.length}</b> 个模型 ·
              <b style="color:var(--text)">${V.state.loras.length}</b> 个 LoRA ·
              <b style="color:var(--text)">${V.state.workflows.length}</b> 个工作流 ·
              <b style="color:var(--text)">${agents.length}</b> 个智能体
            </div>
            <div id="set-storage" style="margin-top:8px;font-size:12px;color:var(--text-3)"></div>
          </div>

          <div class="section">
            <div class="section-title">关于<span></span></div>
            <p class="hint" style="margin:0;line-height:1.9">
              Loom 织造所 v2.1 · 零依赖单页应用，数据全部本地。<br>
              PNG 内嵌参数（A1111 / ComfyUI / NovelAI）上传时自动解析；提示词采用版本链，AI 重写只追加新版本，不覆盖旧的。<br>
              所有文件在 <code>loom-vault/</code> 目录下，备份直接拷走整个文件夹即可。
            </p>
            <div class="about-links">
              <a href="https://github.com/Atom-kkk/loom-vault" target="_blank" rel="noopener">项目仓库</a>
              <a href="https://github.com/Atom-kkk" target="_blank" rel="noopener">GitHub 主页</a>
              <a href="https://www.iesdouyin.com/share/user/MS4wLjABAAAAQc4NN1_Ms30-2s2a5hjyZ2CweDIDkX2eSwaure41sOyXx7ogYtv8fmsKsAgB9lZv" target="_blank" rel="noopener">抖音主页</a>
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
