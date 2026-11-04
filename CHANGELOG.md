# 更新日志

本项目所有值得注意的改动都会记录在此。

## [0.2.4] - 2026-11-04

### 修复（CI 可观测性）

- CI 构建失败时把 `build.log` 尾部和错误摘要写进 annotation / Step Summary，
  便于直接看到 electron-builder 或 stage-web 的真实报错

## [0.2.3] - 2026-11-04

### 修复（CI Electron 二进制）

- `npm ci` 的 electron postinstall 在镜像超时时会静默失败，导致 CI 打包阶段找不到 Electron；
  新增 `Ensure Electron binary` 步骤，缺失时显式重跑 `electron/install.js` 并再次校验
- Build 步骤补上 `ELECTRON_MIRROR`，避免 electron-builder 回退到慢速下载

## [0.2.2] - 2026-11-04

### 修复（CI 打包）

- `electron-builder` 显式加 `--publish never`，产物交给后面的 `action-gh-release` 发布，
  避免它在 tag 构建时自己尝试发布而失败
- `stage-web.mjs` 按 runner 平台检查 runtime：Windows 只要求 `python-win`，macOS 只要求 `python`，
  不再用 macOS 的路径卡住 Windows 构建

## [0.2.1] - 2026-11-04

### 修复（桌面打包 / CI）

- CI 检出后缺少 `desktop/runtime`（被 .gitignore 排除），`stage-web.mjs` 直接拒绝打包；
  现在按 runner 架构从 python-build-standalone 下载对应 standalone Python（macOS arm64 / x64、Windows x64）
- Windows 打包显式指定 `--win --x64`，避免在 Apple Silicon runner 上默认产出 arm64 包
- `stage-web.mjs` 兼容 Windows standalone Python 的根目录 `python.exe` 布局
- Pages 部署前校验覆盖六个参考库

## [0.2.0] - 2026-11-04

### 新增（三个姊妹素材库接入参考图库）

- 新增三个参考库入口：**动画服装**（1320 套 / 8 类）、**角色组装**（1027 张 / 发型·服装·姿势）、
  **姿势深度**（1439 张 depth / 288 组 / 5 视角）
- 三个库都支持搜索、分类筛选、灯箱翻页、下载、存入图库、AI 写成提示词；
  动画服装和姿势深度可直接「用作服装 / 用作姿势」进组合台
- 角色组装支持「只看主发型」（隐藏发色变体）与姿势「插画 / 线稿」切换
- 画布「加参考图」弹窗同步接入六个库
- 新增 `scripts/fetch_libraries.py`：拉取/转换三个库的元数据与缩略图，生成 `reference/data-extra.js`
- 设置页「清理高清原图缓存」同时清理新库缓存

### 变更（云端预置更新到 2026.11 阵容 / 设置页精简）

- 云端模型预置换新（预置清单版本 v2，老库自动换卡）：OpenAI GPT-Image 2.5（Sunburst/Flare）、
  智谱 GLM-Image、阿里 Wan2.7-Image Pro、火山 Seedream 5.0 Pro（4.x 官方即将下线）、
  Google Nano Banana 2.1（走 Gemini OpenAI 兼容层）、BFL FLUX 3 Image Klein、SiliconFlow Kolors 2.1
- chat 形态兼容多段 content（视觉模型把图片放在 image_url 段的情况）
- 设置页移除硬件配置表（保留在 README），联系方式改为 bug 反馈一句话

> 版本号自 v0.1.0 重新起算（此前 2.x 为内部迭代号，不算正式版）；
> 0.x 阶段的 GitHub Release 一律标记为 pre-release。

### 新增（内置更新）

- 桌面版连接 GitHub Releases 自动更新：启动 5 秒后每天静默检查一次（帮助菜单可手动查），
  发现新版弹窗确认 → 下载（任务栏 / 程序坞原生进度条）→ 打开安装器引导安装；
  直连 GitHub 失败自动切 gh-proxy 镜像，检查结果每天最多落盘一次，失败不轰炸网络
- CI 在打 `v*` 标签时把 dmg / zip / exe 自动发布到 GitHub Release（permissions 提到 write），
  与内置更新器形成闭环；electron-updater 因为要求签名和 latest.yml 不适合本项目，改为自研轻量实现
- `desktop/updater.js` 进入 asar 打包清单

### 变更（导航重排 / 命名）

- 侧栏分组「本地资产」→「**模型**」；「模型库」→「**云端模型**」（页面标题同步，
  说明改为「云端 API 在这里配置；本地模型随工作流导入自动登记」）；「工作流」→
  「**本地部署工作流**」；画布里的相关提示文案同步
- **下线「LoRA」页**与「**提示词片段**」页的导航入口（代码与已有数据保留，
  导出 / 导入不受影响）；分类管理此前已并入图库
- DeepSeek 服务商预设只保留 `deepseek-flash`（旧的 chat / reasoner 已弃用）
- 文档同步：README 标语与特性列表、画布手册侧栏图、小白教程第 6 章

### 新增（云端出图：不装引擎也能画）

- **模型库「云端 API」完整配置**：预设目录一键填好（GPT Image 1 / DALL·E 3 / 智谱 CogView-4 /
  阿里通义万相 2.5 / 火山 Seedream 4.0 / Google Imagen 4 / BFL FLUX 1.1 Pro / SiliconFlow Kolors /
  中转站），加 API Key 与模型名即可；「测试连接」探 /models 验配置。Key 只存本机。
- **调用形态（assets/cloud.js 新模块）**：
  - `images` —— OpenAI 兼容 `/v1/images/generations`（覆盖绝大多数中转站；GPT Image 系带参考图时
    自动走 `/images/edits` 图生图）
  - `chat` —— 部分中转把生图模型包成对话接口，从回复里抠 markdown 图片链接 / base64
  - `dashscope` —— 万相异步任务（提交 → 轮询 task_id）；`bfl` —— Flux 异步任务；`google` —— Imagen :predict
  - 浏览器直连被 CORS 挡住时自动回落本地服务代理（`/comfy?u=`，转发 Authorization）
- **画布输出节点支持绑定云端模型**：「绑定出图方式」弹窗分两段（☁ 云端模型 / 本地工作流）；
  云端结果照常入图库并按模型名自动关联模型卡；多数云端不吃负向词与参考图，画布如实提示。

### 新增（资产自动维护：导入即登记）

- **模型库自动登记**：导入工作流（或启动时补登记内置工作流）时，把里面 UNET /
  Checkpoint 加载器引用的基座文件自动登记成本地模型，按文件名去重并把工作流挂到
  模型卡上 —— 本地模型从此不用手动加。删除自动条目记入 `autoModelDismissed`，
  之后的导入 / 启动不会复活
- **LoRA 自动扫描**：LoRA 页进页面静默扫一次引擎的 `models/loras` 目录（`/scan-models`
  找目录 + `/listdir` 列文件），扫成卡片按文件名去重；工具条加「扫描引擎目录」手动
  随时再扫。删除自动条目同理记 `autoLoraDismissed`
- **分类管理并入图库**：图库工具条新增「分类管理」按钮（弹窗内可增删改，表格实时
  刷新），原「管理 → 分类」独立页下线，侧栏更干净
- **侧栏顺序**：创作组提到图库组前面，创作是高频入口

### 新增（画布）

- **缩放百分比支持自定义输入**：点 HUD 上的百分比弹出小面板 —— 数字输入（回车应用 /
  Esc 取消 / 点外面收起）+ 预设档 50/100/150/200 + 适应窗口；超出 20–240% 钳到边界
  并留在面板里。以视口中心为锚（滚轮仍以光标为锚）
- 「给节点选一张图」补上姿势参考档（多选弹窗有、单选一直漏了），姿势与 faces 同用
  tall 网格

### 新增（内置工作流 ×2，来自 B 站的 古手梨花sama）

- **Qwen-Image 2.1 单图/多图编辑总控**（10 个可选参考图位，图 1 固定为编辑目标）与
  **MOSS-Image SFT 一键加速**（开关切 8 步 DMD / 50 步原始）。导出时转成 API 格式入库：
  剔除 rgthree 标签 / 对比器等展示节点，`SaveImageAdvanced` 换成核心 `SaveImage`（API 输入名不稳），
  Windows 反斜杠路径规范化，seed 置 -1 由 comfy.js 提交时随机
- 槽位协议两个扩展（`comfy.js`）：
  - **同节点身兼多槽**：标题只标得出一个，但 `TextEncodeQwenImage21` 把 prompt 和 negative_prompt
    放在同一个节点、KSampler 把 seed/steps/cfg/denoise 挤在一起 —— 输入名恰好是保留名且值为标量
    （非连线）就一并认领，标题标注永远优先
  - **未接图的 ref 槽位按 bypass 语义剔除**：删掉对应 LoadImage 并清掉指向它的输入连线。
    单图编辑时其余 9 个图位不再拿占位文件名去提交报「value not in list」；这些可选输入
    （`shape: 7`）删了才合法，和作者在 ComfyUI 里把 LoadImage 静音是同一件事
- 播种走版本门槛（builtinWfVersion = 6）：新用户三套全播，老库升级自动补种新条目；
  删除内置工作流时记进 `wfBuiltinDismissed`，升级补种不复活用户明确删掉的
- 测试：`tests/js/builtin.test.js` 覆盖播种 / 补种 / 删除不复活 / 两套工作流的槽位与提交改写

### 新增（桌面版内置 Python）

- 安装包内嵌 python-build-standalone 3.12（arm64）：main.js 优先用它跑 serve.py，
  双击即用，不依赖用户装过 Python；首次启动复制到 userData（.app 包内只读）
- 修掉打包映射断点：extraResources 把 `runtime/python` 直连到 `resources/python`
  （之前 staging 会把它带进 resources/web/python，main.js 找不到，静默退回系统 Python）；
  stage-web 检测不到内置 Python 时直接拒绝打包，不再静默降级

### 新增（设置页 / 文档 / AI）

- 设置页新增「硬件配置参考」：四档配置表（入门 / 基础 / 推荐 / 旗舰 × Windows / Mac）、
  40/50 系显卡推荐、实测数据与 bug 反馈渠道；README 同步一节
- DeepSeek 默认模型改为 `deepseek-flash`（旧 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07 弃用），
  旧配置迁移的兜底同步
- README 修正：参考库缩略图（4345 张）已随仓库分发，删掉「克隆后需单独拉一次」的过时说明；
  `.gitignore` 补上 desktop 构建产物（node_modules / dist / staging / runtime）

### 新增（桌面版 macOS / Windows）

Electron 壳，双击即用，不再需要开终端、记端口。

- `desktop/main.js`：找空闲端口 → 探测 Python（`py -3` / `python` / `python3`，要求 3.10+）
  → `serve.py <端口> --no-open` → 端口通了才 loadURL
- 网页资源复制到用户目录（`.app` 包内只读，而 serve.py 要写 `.engine.json`）；
  升级时按版本号重同步，但保留用户已有的 `.engine.json`
- 退出时连带收掉 serve.py 拉起的 ComfyUI；被强杀留下的孤儿服务按 pidfile 在下次启动时清理
  （杀之前先用 `ps` / `Get-CimInstance` 确认命令行里是 serve.py，防 pid 复用误杀）
- 没装 Python / 起不来时开说明页并给出下载地址与日志片段，不白屏
- 菜单加了「打开数据目录」「在线体验」「项目主页」；站外链接交给系统浏览器
- `.github/workflows/desktop.yml`：macOS 与 Windows 各一台构建机，产出 dmg / zip / exe 到 Artifacts
- `desktop/build/icon.png` 由 `scripts/make_icons.py` 的同一套绘制逻辑渲染到 1024px

实测（macOS arm64）：`npm start` 与打包后的 `Loom.app` 均能拉起服务并完整渲染
（15 个导航项、参考库 1407/1499/1439、资源徽章正常）；arm64 / x64 各出一份 dmg，约 160 MB。

### 新增（在线体验 / 纯静态托管）

前端本来就不依赖后端，但 `ensureEngine()` 硬要问 `serve.py`，
所以页面一旦托管在别处，哪怕本机 ComfyUI 好端端开着，也会被「本地引擎启动失败」挡住。现在分三层：

- `hasBackend()`：用 `/engine/status` 返回里有没有 `running: boolean` 判断后端在不在（静态托管下是 `{}`）
- `ensureEngine()`：有后端照旧（能自动拉起）；没后端就直接探 ComfyUI 地址，探到就返回
  `{ running: true, external: true }` 继续出图；探不到才报错，且报的是「这个页面没连到本地服务」而不是「启动失败」
- 「本地配置」页：无后端时顶部显示说明条，隐藏装不了的安装框、引擎目录、启动/重启、模型目录，
  只留「服务地址 / 测试连接 / 保存地址」

顺带修掉一个连带 bug：安装状态接回时只判 `ist.ok !== null`，而 `undefined` 也满足这个条件，
于是无后端时会画出一个空的安装面板（还带着「终止」按钮）。现在要求 `running` 是布尔且 `steps` 是数组。

README 新增「在线体验」一节，写清静态托管下哪些能用、哪些不能，以及两个现实限制
（浏览器 Private Network Access 收紧、ComfyUI 无鉴权且 `ACAO: *` 的暴露风险）。

### 修复（参考图假连线 / 日志乱码 / 路径提示 / toast 遮挡）

一轮完整自查发现的四个问题，都不影响启动，但都会让人当场卡住或误解：

- **参考图会连出一根传不进去的线**
  底栏「参考图」把图接到输出节点是不看工作流的。内置的 KREA2 是纯文生图（没有 `LoadImage`），
  连线照画，点生成才报「这个工作流没有 ref_image_xx 槽位」—— 线都画出来了却说没接上。
  现在 `autoWire()` 先问 `canTakeRef()`（`slots.imageSlots > 0`）：不支持就**不连线**，
  并当场说明原因（没图位 / 没绑工作流 / 还没有输出节点三种）。图照样留在画布上，可以自行接。
- **引擎日志带 ANSI 转义，页面上显示成 `[32m[INFO][0m`**
  ComfyUI 往终端写颜色码，`_log_tail()` 原样返回，前端是当纯文本塞进 `<pre>` 的。
  启动失败的原因也是从日志里截的，乱码会一路跑到弹窗里。现在在 `Engine._strip_ansi()` 里统一剥掉，
  `
` 也去掉（进度条那种行会回到行首覆盖）；`Installer._emit()` 同样处理 pip / git 的输出。
- **模型目录提示指向了错误的位置**
  `ownModels` 的正则多剥了一层 `/ComfyUI`，算出来是「ComfyUI 的上一级/models」。
  照着放会放到自动扫描根之外，然后提示「没找到」。现在指向 `<comfy_dir>/models`。
- **画布的 toast 压住底部快捷键提示**
  两者都在底部居中/靠右，出现长提示时叠在一起看不清。画布存在时 `#toasts` 抬到 `bottom: 76px`
  （`body:has(.cv-host)`；不支持的浏览器退化成原位置，不影响功能）。

顺带补的稳健性改动：

- **`zoom` 加特性检测**：`applyTransform()` 先问 `CSS.supports('zoom','2')`，不支持就退回
  `transform: scale()`（屏幕空间公式一致，拖拽 / 框选 / 小地图都不用改）。Firefox 126 以前的版本不再错位。

### 新增（管理页拆分 / 画布快捷入口 / 参考图库导入 / 画布清晰度）

- **「管理」拆成四页**，按「改什么去哪页」分开：
  | 页面 | 原来在哪 | 现在管什么 |
  |---|---|---|
  | **本地配置**（新） | 设置页第一段 + 画布「高级选项」弹窗 | ComfyUI 安装 / 目录 / 端口 / 启动重启 / 模型目录 |
  | **AI 智能体**（新） | 设置页第二、三段 | AI 服务商 + 智能体 |
  | **分类** | 不变 | 图片分类与前缀 |
  | **设置** | 瘦身 | 只剩数据备份、存储占用、关于 |
  - 画布顶栏的「高级选项」不再弹窗，直接跳「本地配置」（两处内容本来就重了）
  - 模型路径支持三态显示：**自动识别** / **手动指定** / 还没找到 —— 之前「手动配过但和自动识别不一致」会被误报成「没找到模型目录」
- **画布底栏三个快捷按钮**：`提示词` / `参考图` / `出图`
  - 提示词：缺哪个补哪个（没正向给正向，有正向没负向给负向）
  - 出图：自动绑内置工作流，**并把画布上还没连线的提示词自动接过来**
  - 新节点按类型算落点：提示词往下叠（+210px）、输出节点排到提示词右侧、参考图再排到输出节点右侧
  - 从零到能生成 = 点两次「提示词」+ 点一次「出图」，连线全自动
- **参考图库一键导入**：底栏「参考图」打开多选弹窗
  - 五个来源：我的图库 / 服饰 1407 / 人脸 1499 / 姿势 1439 / 本地文件
  - 支持编号前缀与关键词搜索，**换关键词不清空已选**
  - 一次最多 60 张，选完成排铺到输出节点右边并自动连线
  - 图片节点宽度 260 → 200（参考库都是竖图，260 会撑到三百多高）
- **画布缩放改用 CSS `zoom`**（原来是 `transform: scale`）
  - 根因：transform 会把整个画布层按当前倍率栅格化成位图再拉伸，放大到 200% 以上文字边缘出现灰晕
  - zoom 是真实布局缩放，按缩放后的字号重新渲染，**放多大都锐利**
  - `applyTransform()` 里写入 `left = x / k`（zoom 也会放大元素自身的 left/top 偏移）
  - 实测：滚轮缩放锚点偏差 0.5px、拖拽平移与节点拖拽偏移均正确，框选/小地图/fitView 不受影响

### 测试

- `tests/py` 59 项、`tests/js` 53 项，全绿
- 15 个视图遍历 0 异常（新增 local / ai 两页）

### 修复（参考图库满屏破图）

- **404 也被缓存了 7 天**：`serve.py` 的 `end_headers()` 不判状态码，给所有响应都打 `Cache-Control: max-age=604800`。
  参考缩略图还没下载完时打开过图库，浏览器就把那些 404 记了 7 天；等图都在了，它还是拿缓存里那个 404，
  **刷新也不管用**（缓存没过期）。表现就是「一部分缩略图怎么都不显示」，且不同人坏的不是同一批。
  - 现在只有 `200` / `304` 才长缓存，其余一律 `no-store`
  - 新增 `send_response()` 记录状态码，供 `end_headers()` 判断
  - 参考图 URL 统一加 `?v=3`（`reference.js` 的 `THUMB_VER`）—— 让**已经被缓存 404 的浏览器**自动换新地址，用户不用手动清缓存
- **服务器是 HTTP/1.0，每张缩略图新建一条 TCP 连接**：图库一屏 120 张、往下滚还继续加载，
  几百条短连接会把本机临时端口用光，同样表现成「一部分图加载不出来」。
  `Handler.protocol_version` 改成 `HTTP/1.1`，连接可复用；顺带加 `timeout = 30` 防僵尸连接。

### 界面优化（输出节点）

- **控件不再贴边**：`.cv-size` / `.cv-batch` / `.cv-slots` 之前没有左右留白，控件直接顶在卡片边框上；
  现在统一 11px，与工作流名、状态行、按钮完全对齐
- **节点加宽**：输出节点 320 → 356px，简化节点 300 → 330px —— 320 放不下「尺寸 + 比例 + 张数 + 固定种子」
- **错误态只留一个按钮**：之前「生成」和「重试」上下叠着，两个都像主按钮；
  现在错误时主按钮直接变成「重试」（`runGen` 本来就是读当前参数重跑，功能等价）
- 错误文案最多显示 3 行（`-webkit-line-clamp`），长报错不再把卡片撑变形
- 工作流名 / 模型名两个标签重新分配弹性：左边优先，右边限宽 58%，不再出现「KREA2_C…」

### 测试

- `tests/py` 52 → 59：新增缓存头回归（图片 200/304 长缓存、404/500 不缓存、代码文件不缓存、`send_response` 记录状态码）与 HTTP/1.1 断言
- `tests/js` 53 项不变

### 新增（出图尺寸 / 模型默认路径 / 零基础教程 / 全界面截图）

- **出图尺寸随手改（图片与视频通用）**：输出节点上新增 `尺寸 [宽] × [高] [比例▾]`
  - 只在该工作流声明了尺寸槽位时出现 —— 改了不生效的按钮，比没有按钮更误导人
  - 自动吸附 64 的倍数（latent 只要求 8，但部分视频模型要求 64）；范围 64~4096；失焦时才吸附，不边打字边改写
  - 预设 1:1 / 3:2 / 2:3 / 4:3 / 3:4 / 16:9 / 9:16，外加两个视频常用档（1280×704 / 704×1280）
  - **新增 `size` 合体槽位**：宽高长在同一个节点里（`EmptyLatentImage` / `EmptyLatentVideo`）时，标一个 `size` 顶两个，解析时拆成 `width` + `height` 两条，写入路径完全复用
  - 视频工作流额外多一行「时长」（0.5~60 秒）
  - 用户没改过就用工作流原本的宽高，不会因为点了一下节点就重置
- **模型目录默认指向 ComfyUI 自带的 `models/`**：`_model_roots()` 调换优先级 —— 自带 models 在前、安装目录旁的共享 models 在后；同分时才看顺序，有内容的一律优先。理由：ComfyUI 本身只认这里，放别处要靠 `extra_model_paths.yaml` 挂载，多一层就多一个出错点
- **内置工作流补 `size` 标注**：`156`（EmptyLatentImage）标为 `size`，播种时即打上标注（不再等下一次迁移），`WF_VERSION` 4 → 5
- **《小白图文教程》**（`小白图文教程.md`，1150+ 行）：从「下载压缩包」讲到「第一张图进图库」，中间装了引擎、放了模型、认识界面、调了尺寸、排了错
  - 每一步都写「你应该看到什么」和「没看到怎么办」
  - 覆盖 macOS 与 Windows 双路径，含 Python 缺失、权限不足、`file://` 打不开等新手高频坑
  - 附录：文件存放一览图、三个易混概念对照、20 项「一遍通」勾选清单
- **全界面截图 24 张**（`docs/screenshots/`）：图库空态 / 导入弹窗 / 图库 / 灯箱 / 空画布 / 三件套 / 输出节点特写 / 三个参考图库 / 组合台 / 片段库 / 模型库 / LoRA / 工作流 / 分类 / 设置三段 / 资源面板 / 简易节点包 / 导入工作流 / 遮罩编辑器 / 深色主题
- **`scripts/make_shots.mjs`**：用 Node 自带的 `fetch` + `WebSocket` 驱动本机 Chrome 的 DevTools 协议自动截图，**不装 playwright / puppeteer**
  - `SHOTS=ref node scripts/make_shots.mjs` 可按名字分批跑（参考图库一页 120 张、滚动自动加载，连截三张会顶爆渲染进程）

### 测试（出图尺寸 / 模型路径）

- `tests/py` 50 → 52：新增「同分时取 ComfyUI 自带 models」「roots 顺序把自带 models 排第一」
- `tests/js` 44 → 53：新增分辨率槽位（`width`/`height`/`duration` 带出当前值、只写传进来的那个、空值不写、没槽位不报错）与 `size` 合体槽位（拆成两项、写同一节点两个 input、只给宽度时高度留原值、节点无宽高时给警告、老写法兼容）

### 新增（资源监控 / 预计时间）

- **顶栏资源徽章**：右侧常驻一枚胶囊，实时显示「运行中 1（排队 3）· 显存 94%」；引擎没起时显示「引擎未启动」。点击展开面板，点外部或按 `Esc` 收起
- **资源面板**：
  - 任务队列：运行中 / 排队中数量、本任务已用时间
  - 显卡：型号、GPU 负载（`nvidia-smi`，没有就显示 `—`）、显存占用条（≥80% 转黄、≥92% 转红）、`15 GB / 16 GB`
  - 系统内存：RAM 占用条与用量、CPU 占用与核数
  - 版本：ComfyUI / PyTorch 版本、引擎进程内存与运行时长
  - 「卸载模型并释放显存」：`POST /free`（`unload_models` + `free_memory`），按钮自带「正在释放 / 已释放」反馈
- **新增接口 `/engine/sys`**：由 `serve.py` 采集 ComfyUI 自己不会说的部分 —— CPU 占用、引擎进程 RSS 与运行时长、NVIDIA 利用率
  - `ps` 被系统策略挡住时退回 `os.getloadavg()` 估算；Windows 走 PowerShell `Win32_Processor` / `Get-Process`
  - 进程 pid 不盲信 `.engine.json`：优先取真正占着端口的那个，手动启动的 ComfyUI 也能测到
  - 结果带 2 秒缓存（`ps` 约 30ms、PowerShell 800ms+，不能每次轮询都跑）
- **生成节点的「已用 / 预计」**：状态行变成 `第 1/3 张 · 生成中 8/20 · 已用 00:07 · 剩余约 00:24`
  - 有 WebSocket 步进进度 → 按每步秒数的指数滑动平均外推，批量会把后面未跑的张数算进去
  - 没有进度（MPS / 单步长采样 / WS 连不上）→ 用同工作流 + 同批量的历史中位耗时倒推，超时显示「快好了」
  - 历史存 `localStorage` 的 `vault.gen.dur`，每类保留最近 6 次；`etaText()` 是纯函数，可单测
  - 计时器每秒只改状态行文字，不重建节点（保住输入焦点与滚动位置）；`gen` 字段不写进 IndexedDB，避免刷新后接着上次算「已用」
- 面板打开 1.5 秒轮询、收起 8 秒、页面切后台暂停

### 测试（资源监控 / 预计时间）

- `tests/py` 31 → 50 项：新增 `_parse_etime` 各格式、`_proc_usage`（POSIX / Windows / 进程已退出）、`_cpu_percent`（核数换算、夹紧 100、拿不到返回 None、loadavg 兜底）、`_gpu_util`、`sys()` 的 pid 归属与缓存
- `tests/js` 24 → 44 项：新增 `fmtClock` / `fmtLoose` / `fmtBytes` / `durKey` / `durRecord` / `durAvg` / `durLast`，以及 `etaText` 的九种场景（无进度、按步外推、批量、历史倒推、超时不吐负数、时钟回拨）

### 新增（槽位协议 / 批量 / 遮罩 / 画布交互 / 测试）

- **工作流槽位协议**：在 ComfyUI 里把节点标题（`_meta.title`）改成 `prompt` / `seed` / `ref_image_01` / `ref_mask` / `first_frame` 等保留名，织造所就按「槽位」认角色，不再靠节点类型 + id 顺序猜
  - 能力由标注自动推导：文生图 / 图生图（N 图位）/ 遮罩重绘 / 首尾帧 / 视频
  - `parseSlots()` 纯函数、大小写与空格宽容、参考图按编号数值排序、重复标注与无输入节点都会给出警告
  - 没标注的工作流自动退回旧规则，并在卡片上标「按类型猜 · 未标注」
  - UI 格式转 API 时节点标题会写进 `_meta.title`，在 ComfyUI 里标好就能一路带过来
- **批量生成**：生成节点可出 1~8 张（串行），卡片显示「第 2/4 张 · 生成中 4/10」；可勾「固定种子」让一批用同一颗种子
- **图片组节点**：多张结果收进一个组（大图 + 缩略图条 + `2 / 5` 计数），点缩略图换主图、「展开」看全部、「拆开」变独立节点
- **失败重试**：生成失败时卡片出现「重试」，沿用上次的提示词与参数，不用重填
- **遮罩重绘（inpaint）**：图片/参考图节点带画笔编辑器（笔刷、橡皮、清空、反选），按原图尺寸导出「白=重绘」掩码，生成时上传并填进 `ref_mask` 槽位；工作流没有该槽位时明确提示而不是静默忽略
- **画布交互**：右下角小地图（点击/拖动导航、选中节点描边）、`Shift` 拖拽框选、`Shift` 点选多选、拖一个带动整组、`⌘A` 全选、`⌘C/⌘V` 复制粘贴（含内部连线）、`⌘D` 再制
- **自动化测试**：`tests/js`（node:test + vm 沙箱，24 项）覆盖槽位解析、applyInputs 两条路径、插件种子兜底、UI→API 转换；`tests/py`（31 项）覆盖模型扫描、`extra_model_paths.yaml`、端口→进程识别（含 Windows 分支）、restart 安全判据、安装器契约。`./scripts/test.sh` 一条命令跑完

### 修复
- 生成节点明明绑了工作流却显示「未绑定工作流」：`wfName` 为空时按 `workflowId` 现查名字
- 小地图压住画布底部提示文字；张数行在窄节点上被挤到边缘

### 新增

- **图形界面一键装 ComfyUI**：设置页顶部新增安装卡片，点「下载并安装」即自动完成源码获取 → 建独立 venv → 装 PyTorch → 装依赖 → 写 `.engine.json`
  - **Windows 可自选安装位置**：调用 PowerShell `FolderBrowserDialog` 弹原生文件夹选择框，可直接装到 `D:\AI\ComfyUI`；macOS 走 `osascript`，Linux 走 zenity/kdialog
  - 六步进度条 + 实时日志（pip 的 `\r` 进度条也能滚动）、可「终止」、可续装
  - PyTorch 可选自动 / CPU / CUDA 12.4 / CUDA 12.6
  - 源码获取双通道：`git clone` 超时（240s）或失败自动改用 codeload 压缩包
  - pip 镜像缺包（清华源滞后于新发布的大包）自动退回官方 PyPI 重试
  - 新增接口：`/engine/install/start`、`/engine/install/status`、`/engine/install/cancel`、`/engine/pick-dir`
- **一键装引擎**：`scripts/setup-engine.sh`（Mac/Linux）与 `scripts/setup-engine.bat`（Windows），别人 clone 后跑一次，自动装好 ComfyUI 引擎（含 Python + PyTorch），无需手动折腾
- serve.py 自动探测 `engine/` 目录作为引擎位置（setup 脚本装完即自动连上）
- `scripts/fetch_reference_gcore.py`：固定走 gcore.jsdelivr.net 拉参考缩略图，绕过系统代理（原脚本的 cdn/fastly 节点会 301 到不可达的 raw.githubusercontent.com）

### 新增（模型路径）
- **模型目录自动识别**：新增 `/engine/scan-models`，扫描 `<安装根>/models`、`ComfyUI/models`、`~/ComfyUI/models`、`~/ComfyUI-Shared/models`，按类型映射（checkpoints / diffusion_models / loras / vae / clip / text_encoders / controlnet / embeddings …），同类型取「有内容且模型最多」的那个
- 「高级选项 · 模型路径」打开即自动预填，标「自动识别」并显示可用模型数与正在下载数；保存后自动重启引擎生效
- 引擎冷启动时自动把识别到的目录挂进 `extra_model_paths.yaml`（跳过 ComfyUI 自带 models，避免列表重复）

### 新增（工作流换模型）
- **工作流卡片上直接换模型**：卡片新增「切换模型」按钮，弹窗列出该工作流里所有模型加载节点——主模型（UNETLoader / CheckpointLoader）、CLIP（CLIPLoader / DualCLIPLoader 双槽）、VAE、每个 LoRA（含强度可改）
- 候选值来自当前 ComfyUI 引擎真实可用的模型列表（读 `/object_info` 的 combo），用 `input + datalist` 实现「可下拉可手填」；当前值不在列表会标黄提示
- 保存即写回工作流 JSON，画布上的节点运行时按 workflowId 读取同一条记录，**下次生成自动用新模型，不用重新上传工作流**
- 卡片副标题改为显示当前主模型文件名（原来只显示「未关联模型」）

### 新增（刷新后接回任务）
- **提交时记录 promptId**，页面刷新/关掉再回来，画布会自动把引擎里还在跑的任务接回来：轮询 `/queue` 判断是否还在跑、`/history/<id>` 取结果，拿到图后照常入库并生成结果节点，状态里标「刷新后接回」
- 接不回来时（被中断 / 引擎重启过 / 已超时）节点会显示「上次任务没接上：原因」，不会一直卡在「生成中」
- 刷新不再丢图：以前 `runGen` 的 await 随刷新一起死掉，图只落在 `ComfyUI/output/` 不进图库

### 新增（引擎出图导入）
- 画布工具栏新增「引擎出图」：列出 ComfyUI `output/` 里的图，支持单张/全部导入图库，PNG 内嵌参数自动解析
- 后端 `/engine/outputs` 返回出图目录清单（名称/体积/时间），最新在前

### 修复（全面体检）
- **长任务被 6 分钟上限判死（严重）**：`MAX_WAIT` 只有 6 分钟，而 16 GB 机器上一张 Krea2 要 25~27 分钟，于是每次都在第 6 分钟抛「执行结束但没有输出图片」——图其实已生成。上限改为 60 分钟
- **接回时图片根本没下载（严重）**：`waitFor` 把 history 里的「文件名/子目录」元数据直接当结果返回，入库时 blob 是 undefined → 控制台「入库失败 TypeError: Cannot read properties of undefined (reading 'type')」，节点永远停在「完成但没有拿到图片」。现在和 `run()` 一样先下载成 blob
- **取消后要干等 60 分钟**：WS 没处理 `execution_interrupted`，取消后 `run()` 一直挂着。现已处理，点取消立即结束
- **等待完成但 outputs 晚落盘**：`waitEntry` 一见 `status.completed` 就返回，拿到空 outputs 后误报「没有输出图片」。现在多等一拍，WS 分支也改为落回轮询而不是直接抛错
- **接回失败时状态不落盘**：`finishGen` 拿不到图时提前 return，`promptId` 清空没写进 IndexedDB，刷新后又变回「正在生成」。已补 `queueSave()`
- **Windows 上「重启引擎」静默失效**：原实现只认 `lsof`/`ps`（Windows 没有这两个命令），查不到占用端口的 pid 就什么都不做，`start()` 又因为端口在监听而返回「已在运行」。现在 Windows 走 `Get-NetTCPConnection -State Listen`（失败退回 `netstat -ano`），进程校验走 `Get-CimInstance Win32_Process` / `tasklist`
- **引擎卡死时无法重启**：`ps` 认不出进程就拒绝动手，可「卡在加载模型」恰恰是最需要重启的时候。现在只要**启动时记录的 pid 仍是该端口的监听者**就确认是自己的引擎，允许重启
- **本机探测会走系统代理**：设了 `http_proxy` 又没排除 127.0.0.1 时，`/system_stats` 探测失败会导致「引擎明明活着却说没启动」。所有回环请求改为显式绕开代理
- **画布数据缺字段会整页崩**：存档里少了 `view` 时 `renderAll` 抛 `Cannot read properties of undefined (reading 'x')`，整个画布视图白屏。现在渲染前补齐 `nodes/edges/view`
- 「取消」的提示改为与实际行为一致：中断只在步与步之间生效，重模型可能要等几分钟
- **节点会僵在「生成中」**：刷新/断线时 `runGen` 被掐断，节点状态却留在 running，于是按钮一直显示「生成中…133s」，其实引擎里啥都没跑。现在画布加载时会问引擎队列，没活干就把这类节点复位成「上次的生成已中断（点生成重来）」
- **看不到步进进度**：浏览器直连 8188 会被 Origin 校验拦（403），只能走 serve.py 反代，而 WebSocket 走不了 → 进度只剩「生成中 233s」。引擎启动参数加上 `--enable-cors-header`，浏览器可直连、ws 通了，进度恢复成「2/10」
- **长任务被 6 分钟掐断（严重）**：`MAX_WAIT` 只有 6 分钟，而 16 GB 机器上一张 1216×832 的 Krea2 要 25~27 分钟，于是每次都在第 6 分钟抛「执行结束但没有输出图片」——图其实已经生成好了，却显示失败。上限改为 60 分钟
- **history 落盘竞态**：`waitEntry` 一看到 `status.completed` 就返回，但 `outputs` 有时晚一拍才写，导致「完成但没图」。现在会多等几轮；WS 分支也不再急着报错，继续走轮询
- 等待超时时保留 `promptId`（不再清空），刷新页面能自动接回还在跑的任务
- **「取消」按钮之前根本没生效**：上一版只生成了补丁文件、没有写回 `assets/canvas.js`，代码里其实没有按钮。现在生成中会真的出现「取消」，点击 = `POST /interrupt`（停当前）+ `POST /queue {clear:true}`（清排队）
- 内置工作流的 `filename_prefix` 写的是 A1111 的 `%date:yyyyMMddhhmmss%`，ComfyUI 不认，出图文件名会变成 `Krea2-%date:yyyyMMddhhmmss%_00001_.png`。改成 `Krea2`，老库里的工作流也会自动迁移（WF_VERSION 3）
- **「重启引擎」可能误杀别的进程（严重）**：旧实现直接 `os.kill(.engine.json 里记的 pid)`，一旦这个 pid 被系统复用，杀掉的可能是任意程序——实测把 serve.py 自己都杀了。现在改为：先用 `lsof` 找出**真正占着引擎端口**的 pid，再用 `/system_stats`（或 `ps` 命令行）确认它确实是 ComfyUI 才动手；认不出来就明确拒绝并提示，不再盲杀。终止用 SIGTERM，等 20 秒不退才 SIGKILL
- **内置默认工作流依赖第三方插件**：`KREA2 CC 人像` 原先用 rgthree 的 `Seed (rgthree)` 节点串 KSampler.seed，没装插件的人点「生成」直接 400 `missing_node_type`。v2 改成原生 `seed: -1`，由 `comfy.js` 提交前随机成整数；老用户库里已播种的那份会由 `builtin.js::migrate()` 自动改写（只拆 rgthree，不动用户改过的提示词）
- **ComfyUI 校验错误不再抛英文 JSON**：`/prompt` 400 现在翻成中文——缺插件节点会点名节点、模型不在列表会提示「没下载完 / 目录没挂上」
- **`extra_model_paths.yaml` 格式错误**：原来把所有 section 又套了一层 `loom_shared:`，ComfyUI 读到嵌套字典直接崩（`AttributeError: 'dict' object has no attribute 'split'`）。改为按 base_path 分组合并成顶层 section
- 扫描计数只认 `.safetensors/.ckpt/.pt/...`，不会再被 ComfyUI 空目录里的 `put_xxx_here` 占位文件误导；同时识别 `.qkdownloading/.part/.crdownload` 等下载中文件
- `Engine._find_python` 补齐 Windows 路径（`venv/Scripts/python.exe`、`python_embeded/python.exe`），原来只找 `bin/python3`，Windows 上会误用 serve.py 自己的解释器导致缺 torch
- **Python 版本门禁**：ComfyUI 要求 3.10+，原来直接用 serve.py 自己的解释器建 venv（macOS 上常是 3.9），引擎一启动就 `TypeError: unsupported operand type(s) for |`。现在会扫描本机 3.10+ 解释器（含 `py` 启动器、Homebrew、python.org 安装位置），必要时自动 `brew install python@3.12`；旧 venv 改名 `venv-old` 留档后重建
- **子进程不再继承 PYTHONPATH/PYTHONHOME**：建 venv、装依赖、起 ComfyUI 都会剥离，避免新环境误加载宿主 `sitecustomize` 导致后续步骤无声卡死
- 「启动引擎」等待上限 90s → 180s（首次冷启动要加载 torch 与节点，90s 不够）
- 安装卡片的进度面板 `[hidden]` 被 `display:flex` 覆盖，收起不生效（已修）

## [v1.0.0] - 2026-10-30

首个正式版本。

### 新增

- **图库**：拖入即存，自动解析 A1111 / ComfyUI 内嵌的提示词、种子、步数、LoRA 等参数
- **无限画布**：节点式连线出图，正向提示词 + 负向提示词 + 参考图（1~N）→ 输出，三/多节点形式
- **本地引擎**：自动拉起 / 复用本地 ComfyUI，画布「高级选项」里统一配置模型 / LoRA / VAE 路径（写入 `extra_model_paths.yaml`）
- **参考图库**：内置 2900+ 张服饰 / 人脸参考，按需加载高清原图
- **提示词版本链**：改一版存一版，永不覆盖，随时回退对比
- **本地资产**：模型、LoRA、工作流集中管理与导入
- **简易节点包**：导入工作流即打包，一键复用
- **节点自由拉伸**：右下角手柄，左右上下任意缩放
- MIT 开源许可

### 修复

- UI → API 工作流转换：旁路节点直通、widget 输入被链接时的正确处理
- ComfyUI 跨域 403：serve.py 本地反代自动降级
- 引擎启动使用 ComfyUI 自带 Python 环境

### 使用

- Mac：双击 `start.command`
- Windows：双击 `start.bat`
- 手动：`python3 serve.py`（默认 8787）

---

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
