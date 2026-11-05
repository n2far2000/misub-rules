#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 n2far2000 <n2far2000@users.noreply.github.com>
#
# 首次把本项目推送到 GitHub。
#
# 用法：
#   bash push.sh <owner>/<repo> [分支名]
#
# 例：
#   bash push.sh edward/misub-rules
#
# 前置条件：
#   1. 已经在 GitHub 网页上建好空仓库（不要勾选 README / .gitignore）
#   2. 本机已配置好 git 凭据（HTTPS 用 PAT，或 SSH）
#
# 注意：如果 <repo> 是私有仓库，jsDelivr 无法提供 CDN 链接
#       —— jsDelivr 只能服务公开仓库。私有仓库请改用 raw 地址或自建 Worker 反代。

set -euo pipefail

REPO="${1:-}"
BRANCH="${2:-main}"

if [ -z "$REPO" ]; then
  echo "用法: bash push.sh <owner>/<repo> [分支名]" >&2
  exit 2
fi

cd "$(dirname "$0")"

if [ ! -d .git ]; then
  git init -q -b "$BRANCH"
fi

git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "chore: init subboost-misub generator"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "https://github.com/${REPO}.git"
else
  git remote add origin "https://github.com/${REPO}.git"
fi

git branch -M "$BRANCH"
git push -u origin "$BRANCH"

echo
echo "已推送到 https://github.com/${REPO}"
echo
echo "下一步："
echo "  1. 打开仓库 Settings -> Actions -> General，确认 Workflow permissions 为"
echo "     Read and write permissions（工作流要向 dist 分支推送）"
echo "  2. 打开 Actions 页，手动 Run workflow 跑一次，验证首次发布"
echo "  3. 确认 dist 分支已生成后，把 README 里的 OWNER/REPO 换成 ${REPO}"
