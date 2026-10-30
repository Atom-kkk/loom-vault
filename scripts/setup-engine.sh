#!/bin/bash
# ============================================================
# Loom 织造所 · 本地引擎一键安装脚本（macOS / Linux）
# 别人 clone 项目后，跑一次这个脚本，自动装好 ComfyUI 引擎，
# 之后打开 Loom 就能直接出图，不用手动折腾 ComfyUI。
#
# 用法：
#   ./scripts/setup-engine.sh
#
# 会做什么：
#   1. 检查 Python3（没有就提示先装）
#   2. 用 pip 装 comfy-cli（ComfyUI 官方命令行工具）
#   3. comfy install --fast-deps 把引擎装到 engine/（含 Python + PyTorch）
#   4. 自动探测引擎目录，写进 .engine.json，Loom 下次启动自动连上
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."          # 切到项目根目录
ROOT="$(pwd)"
ENGINE_DIR="$ROOT/engine"
PYTHON="${PYTHON:-python3}"

info()  { printf "\033[36m[Loom]\033[0m %s\n" "$*"; }
ok()    { printf "\033[32m[Loom]\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m[Loom]\033[0m %s\n" "$*"; }
die()   { printf "\033[31m[Loom]\033[0m %s\n" "$*"; exit 1; }

info "Loom 织造所 · 本地引擎安装器"
info "工作目录：$ROOT"

# ---- 1. 检查 Python ----
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  die "没找到 Python3。请先安装：https://www.python.org/downloads/ （macOS 也可用 brew install python3）"
fi
ok "Python：$("$PYTHON" --version 2>&1)"

# ---- 2. 检查/安装 comfy-cli ----
if ! command -v comfy >/dev/null 2>&1; then
  info "未检测到 comfy-cli，正在安装（ComfyUI 官方命令行工具）…"
  "$PYTHON" -m pip install --user comfy-cli || die "comfy-cli 安装失败，请手动执行：pip install comfy-cli"
  # pip --user 装的命令可能在 ~/.local/bin 或 ~/Library/Python/*/bin
  export PATH="$PATH:$HOME/.local/bin"
  for d in "$HOME"/Library/Python/*/bin; do export PATH="$PATH:$d"; done
fi
command -v comfy >/dev/null 2>&1 || die "comfy 命令仍不可用，请手动装：pip install comfy-cli，并把它加入 PATH"
ok "comfy-cli：$(comfy --version 2>&1 | head -1 || echo '已安装')"

# ---- 3. 安装引擎 ----
if [ -f "$ENGINE_DIR/main.py" ] || [ -f "$ENGINE_DIR/ComfyUI/main.py" ]; then
  warn "检测到 engine/ 已有引擎，跳过安装（想重装请先删掉 engine/ 目录）"
else
  info "开始安装 ComfyUI 引擎到 engine/（首次需下载几个 GB，约 10~30 分钟，请耐心等待）…"
  mkdir -p "$ENGINE_DIR"
  comfy --workspace="$ENGINE_DIR" install --fast-deps || die "引擎安装失败，请重试或手动执行：comfy install"
  ok "引擎安装完成"
fi

# ---- 4. 定位 main.py 并写配置 ----
MAIN=""
for p in "$ENGINE_DIR/main.py" "$ENGINE_DIR/ComfyUI/main.py"; do
  [ -f "$p" ] && MAIN="$p" && break
done
if [ -z "$MAIN" ]; then
  # 兜底：全目录搜 main.py
  MAIN="$(find "$ENGINE_DIR" -maxdepth 3 -name main.py 2>/dev/null | head -1 || true)"
fi
if [ -z "$MAIN" ]; then
  warn "没找到 main.py，引擎可能装到了别处。请手动在 Loom 设置里填 ComfyUI 目录。"
else
  COMFY_DIR="$(dirname "$MAIN")"
  info "找到引擎目录：$COMFY_DIR"
  # 写 .engine.json（Loom 的 serve.py 读这个配置）
  cat > "$ROOT/.engine.json" <<JSON
{
  "comfy_dir": "$COMFY_DIR",
  "port": 8188
}
JSON
  ok "已写入 .engine.json，Loom 下次启动会自动连上这个引擎"
fi

echo
ok "全部完成！现在双击 start.command（或 python3 serve.py）打开 Loom，点「生成」即可自动拉起引擎出图。"
info "提示：出图还需要模型文件，放到 ComfyUI 的 models/ 目录，或在 Loom「画布 → 高级选项」里指定路径。"
