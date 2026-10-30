#!/bin/bash
# AI 织造所 · Mac / Linux 启动器（双击运行）
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py
else
  echo "需要先安装 Python 3：https://www.python.org/downloads/"
  read -r -p "按回车退出…" _
fi
