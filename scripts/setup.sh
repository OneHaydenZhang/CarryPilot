#!/usr/bin/env bash
# 一键恢复本仓库依赖（新机器 / clean clone 后运行）。
# 原则：一切安装收敛在项目维度，不污染全局环境。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/2 Injective MCP Server (vendor/, gitignored 所以 clone 后需重建)"
if [ ! -d vendor/injective-mcp-server ]; then
  git clone --depth 1 https://github.com/InjectiveLabs/mcp-server vendor/injective-mcp-server
fi
(cd vendor/injective-mcp-server && npm install && npm run build)

echo "==> 2/2 项目依赖（含 devDependency 的 @injectivelabs/ainj，经 npx ainj 使用）"
npm install

echo "说明："
echo "- Injective agent skills 已随仓库提交在 .claude/skills/，无需安装"
echo "- MCP 配置在 .mcp.json（项目维度），重启 Claude Code 生效"
echo "- 复制 .env.example → .env 并填入密钥"
