#!/usr/bin/env bash
# 一次性 provisioning —— **需要 root**，只在首次搭环境时跑：
#   ssh root@HOST 'bash /tmp/provision-remote.sh'
#
# 做的事：建专用用户 dcdice → 装共享 Node（/opt/nodejs）→ 写 systemd 单元 →
# 给 dcdice 配 SSH 公钥 + 只允许管理本服务的定向 sudo。
# 之后日常部署请用 scripts/deploy-remote.sh（以 dcdice 运行，无需 root）。
set -euo pipefail

APP_DIR="/opt/dcdice-bot"
SERVICE="dcdice-bot"
RUN_USER="dcdice"
NODE_DIR="/opt/nodejs"
NODE_VERSION="v24.12.0"

echo "== Node 运行时"
if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" -v | sed 's/^v//' | cut -d. -f1)" -ge 22 ]; then
  echo "$NODE_DIR 已有 $("$NODE_DIR/bin/node" -v)"
else
  echo "安装 Node $NODE_VERSION 到 $NODE_DIR（用 Node 原生 TS，需要 >= 22.18）"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/node.tar.gz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/node.tar.gz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  chmod -R a+rX "$NODE_DIR"
  ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
  ln -sf "$NODE_DIR/bin/npm" /usr/local/bin/npm
  ln -sf "$NODE_DIR/bin/npx" /usr/local/bin/npx
fi
NODE_BIN="$NODE_DIR/bin/node"

echo "== 用户 $RUN_USER"
if id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "已存在"
else
  useradd --create-home --home-dir "$APP_DIR" --shell /bin/bash "$RUN_USER"
fi
mkdir -p "$APP_DIR/data"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

echo "== systemd 单元（bot 以 $RUN_USER 运行，绝不用 root）"
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=dcdice Discord CoC dice bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PATH=$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN src/bot/main.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE"

echo "== dcdice 的 SSH 公钥（沿用 root 的 authorized_keys）"
mkdir -p "$APP_DIR/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "$APP_DIR/.ssh/authorized_keys"
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR/.ssh"
chmod 700 "$APP_DIR/.ssh"
[ -f "$APP_DIR/.ssh/authorized_keys" ] && chmod 600 "$APP_DIR/.ssh/authorized_keys"

echo "== 定向 sudo（只允许管理本服务，不给通用 root）"
cat > /etc/sudoers.d/dcdice-bot <<'SUDO'
dcdice ALL=(root) NOPASSWD: /usr/bin/systemctl start dcdice-bot, /usr/bin/systemctl stop dcdice-bot, /usr/bin/systemctl restart dcdice-bot, /usr/bin/systemctl status dcdice-bot, /usr/bin/journalctl -u dcdice-bot, /usr/bin/journalctl -u dcdice-bot *
SUDO
chmod 440 /etc/sudoers.d/dcdice-bot
visudo -c | tail -2

echo "== 完成。日常部署：bash scripts/deploy-remote.sh（以 $RUN_USER 运行）"
