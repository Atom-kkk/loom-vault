#!/usr/bin/env bash
# 一条命令跑完所有自动化测试（无第三方依赖）
#   ./scripts/test.sh            跑全部
#   ./scripts/test.sh py         只跑 Python
#   ./scripts/test.sh js         只跑 JS
set -u
cd "$(dirname "$0")/.." || exit 1

target="${1:-all}"
fail=0

if [ "$target" = "all" ] || [ "$target" = "py" ]; then
  echo "── Python（serve.py） ──────────────────────────────"
  if command -v pytest >/dev/null 2>&1; then
    pytest tests/py -q || fail=1
  else
    python3 -m unittest discover -s tests/py || fail=1
  fi
fi

if [ "$target" = "all" ] || [ "$target" = "js" ]; then
  echo
  echo "── JavaScript（assets/*.js） ──────────────────────"
  if ! command -v node >/dev/null 2>&1; then
    echo "跳过：没装 node（只测 Python 就够了，JS 测试需要 node 18+）"
  else
    node --test tests/js/*.test.js || fail=1
  fi
fi

echo
if [ "$fail" = "0" ]; then
  echo "✅ 全部通过"
else
  echo "❌ 有测试失败，见上面的输出"
fi
exit "$fail"
