#!/usr/bin/env bash
# 日常部署 —— root 或 dcdice 都能跑（脚本自动判断）：
#   root   : scp -i KEY bot-deploy.tar.gz root@HOST:/tmp/ && ssh root@HOST 'bash /opt/dcdice-bot/scripts/deploy-remote.sh /tmp/bot-deploy.tar.gz'
#   dcdice : scp -i KEY bot-deploy.tar.gz dcdice@HOST:~/ && ssh dcdice@HOST 'bash /opt/dcdice-bot/scripts/deploy-remote.sh'
#
# 做的事：解包 → 修正属主/.env 权限 → 装依赖 → 校验命令清单 → 重启服务 → 打印状态。
# 注意：**bot 进程始终以 dcdice 运行**（systemd 单元 User=dcdice），部署者是谁不影响。
# 一次性建用户/装 Node/写单元请用 scripts/provision-remote.sh（那次必须 root）。
set -euo pipefail

ARCHIVE="${1:-$HOME/bot-deploy.tar.gz}"
APP_DIR="/opt/dcdice-bot"
SERVICE="dcdice-bot"
RUN_USER="dcdice"
NODE_DIR="/opt/nodejs"
export PATH="$NODE_DIR/bin:$PATH"

IS_ROOT=0
[ "$(id -u)" = "0" ] && IS_ROOT=1
echo "== 部署者：$(id -un)@$(hostname)  node=$(node -v)  (root=$IS_ROOT)"
test -f "$ARCHIVE" || { echo "找不到归档 $ARCHIVE"; exit 1; }

echo "== 解包到 $APP_DIR"
tar -xzf "$ARCHIVE" -C "$APP_DIR"
[ -f "$APP_DIR/.env" ] && chmod 600 "$APP_DIR/.env"
mkdir -p "$APP_DIR/data"
if [ "$IS_ROOT" = "1" ]; then
  chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
fi

echo "== 装依赖（as $RUN_USER）"
runuser -u "$RUN_USER" -- bash -lc "export PATH='$NODE_DIR/bin:\$PATH'; cd '$APP_DIR' && npm install --ignore-scripts --no-audit --no-fund"

echo "== 校验命令清单（与 docs/discord-commands.json 一致 + 通过 Discord 校验规则）"
runuser -u "$RUN_USER" -- bash -lc "export PATH='$NODE_DIR/bin:\$PATH'; cd '$APP_DIR' && node scripts/check-manifest.ts"

if [ "${REGISTER_COMMANDS:-0}" = "1" ]; then
  echo "== 注册 slash 命令"
  runuser -u "$RUN_USER" -- bash -lc "export PATH='$NODE_DIR/bin:\$PATH'; cd '$APP_DIR' && node --env-file-if-exists=.env src/bot/deploy.ts"
fi

echo "== 重启服务"
if [ "$IS_ROOT" = "1" ]; then
  systemctl restart "$SERVICE"
  sleep 6
  systemctl status "$SERVICE" --no-pager | head -n 10 || true
  echo "--- 最近日志 ---"
  journalctl -u "$SERVICE" -n 15 --no-pager || true
else
  sudo systemctl restart "$SERVICE"
  sleep 6
  systemctl status "$SERVICE" --no-pager | head -n 10 || true
  echo "--- 最近日志 ---"
  sudo journalctl -u "$SERVICE" -n 15 --no-pager || true
fi
