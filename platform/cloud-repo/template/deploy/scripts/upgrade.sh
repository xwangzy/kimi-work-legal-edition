#!/usr/bin/env bash
# 升级到某个发布标签：先备份 → 切代码 → npm ci → 换控制台 → 按顺序重启并逐个健康检查。任何一步失败即停，并打印回滚命令。
#   sudo bash deploy/scripts/upgrade.sh <标签或提交> [--cp-origin https://cp.kwl.example.com:8443]
set -euo pipefail
APP=/opt/kwl/app
TARGET=${1:?用法：upgrade.sh <标签或提交> [--cp-origin <控制面来源>]}
shift
CP_ORIGIN=""
[ "${1:-}" = --cp-origin ] && CP_ORIGIN="$2"
cd "$APP"
PREV=$(git rev-parse HEAD)
install -d -m 0700 /var/lib/kwl-upgrade
echo "$PREV" > /var/lib/kwl-upgrade/previous
echo "当前 $(git describe --tags --always) → 目标 $TARGET"
bash deploy/scripts/backup.sh
git fetch --tags --quiet origin || echo "提示：取不到远端（离线升级？），只用本地已有的提交"
git -c advice.detachedHead=false checkout --quiet "$TARGET"
node scripts/verify-source.mjs >/dev/null || { echo "共享契约包与发布记录不一致，停止"; git checkout --quiet "$PREV"; exit 1; }
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
if [ -d /var/www/kwl-console ]; then
  [ -n "$CP_ORIGIN" ] || CP_ORIGIN=$(node -e 'process.stdout.write(new URL(JSON.parse(require("fs").readFileSync("/var/www/kwl-console/config.json","utf8")).control_plane_base).origin)')
  rm -rf /var/www/kwl-console.new
  node scripts/build-console.mjs --out /var/www/kwl-console.new --control-plane "$CP_ORIGIN"
  cp -p /var/www/kwl-console/config.json /var/www/kwl-console.new/config.json
  rm -rf /var/www/kwl-console.old; mv /var/www/kwl-console /var/www/kwl-console.old; mv /var/www/kwl-console.new /var/www/kwl-console
  chmod -R a+rX /var/www/kwl-console
fi
# systemd 单元与 nginx 配置随版本更新（域名与控制面来源取自现有配置）
install -m 0644 deploy/systemd/kwl@.service /etc/systemd/system/kwl@.service && systemctl daemon-reload
if [ -f /etc/nginx/sites-available/kwl-console.conf ] && command -v nginx >/dev/null; then
  DOMAIN=$(awk '/server_name/ {gsub(";",""); print $2; exit}' /etc/nginx/sites-available/kwl-console.conf)
  sed "s#https://cp.kwl.example.com:8443#$CP_ORIGIN#g" deploy/nginx/kwl-console-headers.conf > /etc/nginx/snippets/kwl-console-headers.conf
  sed "s#console.kwl.example.com#$DOMAIN#g" deploy/nginx/kwl-console.conf > /etc/nginx/sites-available/kwl-console.conf
  nginx -t || { echo "nginx 配置检查没过；回滚：sudo bash $APP/deploy/scripts/rollback.sh"; exit 1; }
  systemctl reload nginx
fi
for role in cp-signer control-plane gateway search dist support notify relay; do
  systemctl is-enabled --quiet "kwl@$role" 2>/dev/null || continue
  echo "重启 kwl@$role"
  systemctl restart "kwl@$role"
  sleep 2
  if ! systemctl is-active --quiet "kwl@$role"; then
    echo "✖ kwl@$role 没起来：journalctl -u kwl@$role -n 80"
    echo "回滚：sudo bash $APP/deploy/scripts/rollback.sh"
    exit 1
  fi
done
bash deploy/scripts/healthcheck.sh || { echo "健康检查没过。回滚：sudo bash $APP/deploy/scripts/rollback.sh"; exit 1; }
echo "升级完成：$(git describe --tags --always)。上一版本 ${PREV:0:12} 记在 /var/lib/kwl-upgrade/previous"
