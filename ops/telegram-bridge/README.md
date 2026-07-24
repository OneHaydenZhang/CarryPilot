# Telegram ⇄ Claude Code 桥接

在 GCP 服务器上跑一个零依赖 Node 服务：Telegram 消息 → `claude -p`（headless，`--continue` 延续会话）→ 输出回传。长轮询，无需开防火墙端口。

## 服务器部署步骤

```bash
# 1. env 文件（敏感信息只在服务器，永不入库）
cat > ~/tg-bridge.env <<'EOF'
TELEGRAM_BOT_TOKEN=<BotFather 给的 token>
TELEGRAM_ALLOWED_CHAT_ID=<你的 chat id，先留空跑一次让 bot 告诉你>
PROJECT_DIR=/home/<user>/KuroAI-INJ
CLAUDE_BIN=/home/<user>/.local/bin/claude
EOF
chmod 600 ~/tg-bridge.env

# 2. systemd 服务（%i = 服务器用户名）
sudo cp ~/KuroAI-INJ/ops/telegram-bridge/claude-tg.service /etc/systemd/system/claude-tg@.service
sudo systemctl daemon-reload
sudo systemctl enable --now claude-tg@<user>

# 3. 查看日志
journalctl -u claude-tg@<user> -f
```

## 使用

- 直接发消息 = 给 Claude 的 prompt（在项目目录执行，可要求它开发/运行/查询）
- `/new` — 开新会话（丢弃上下文）
- `/status` — bridge 状态

## 安全要点

- **白名单**：只响应 `TELEGRAM_ALLOWED_CHAT_ID`；未配置时 bot 会回你 chat id 用于配置，配置后其他人消息一律忽略
- claude 以 `bypassPermissions` 运行（遥控开发的必要条件）——服务器上不要放超出策略资金上限的私钥
- token / chat id 只存在服务器 `~/tg-bridge.env`（600 权限），仓库公开但不含任何敏感信息
