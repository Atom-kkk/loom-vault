# 更新日志

本项目所有值得注意的改动都会记录在此。

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
