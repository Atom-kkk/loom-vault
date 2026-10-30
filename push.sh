#!/bin/bash
# 建好 GitHub 空仓库后，双击这个脚本即可推送
cd "$(dirname "$0")" || exit 1

REPO="git@github.com:Atom-kkk/loom-vault.git"

git remote get-url origin >/dev/null 2>&1 \
  && git remote set-url origin "$REPO" \
  || git remote add origin "$REPO"

echo "推送到 $REPO …"
git push -u origin main

echo
echo "完成。如果报 Repository not found，说明仓库还没在 GitHub 上创建："
echo "  打开 https://github.com/new?name=loom-vault  建一个空的（不要勾 README）"
echo "  然后重新运行本脚本。"
read -r -p "按回车关闭…" _
