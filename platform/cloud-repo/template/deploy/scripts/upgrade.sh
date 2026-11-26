#!/usr/bin/env bash
# 升级到某个发布标签：先备份 → 切代码 → npm ci → 换控制台 → 按顺序重启并逐个健康检查。任何一步失败即停，并打印回滚命令。
#   sudo bash deploy/scripts/upgrade.sh <标签或提交> [--cp-origin https://cp.kwl.example.com:8443]
set -euo pipefail
# 脚本中途会 git checkout 换掉本文件，而 bash 是边读边执行的：先把自己拷到临时文件再从那里执行
if [ -z "${KWL_SCRIPT_COPY:-}" ]; then
  tmp=$(mktemp /tmp/kwl-$(basename "$0").XXXXXX)
  cp "$0" "$tmp"
  KWL_SCRIPT_COPY=1 exec bash "$tmp" "$@"
fi
# 不改 /etc/kwl/*.json：D-218 废弃的 ops.allow_cidrs、console.staff_mfa 新版见到只提示“已忽略”、照常启动；
# 升级时故意留着——只回滚代码（rollback.sh 不带 --restore）回到第 52 批及以前时，旧版控制面没有 allow_cidrs 会拒绝启动。
# 确认不再回滚后，跑一次 ip-config.mjs（部署手册 4.7 换地址同一命令；有域名的部署手工删）即删掉这两项，见运维手册 5.1。
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
# systemd 单元与 nginx 配置随版本更新（域名或公网 IP、控制面来源取自现有配置）
install -m 0644 deploy/systemd/kwl@.service /etc/systemd/system/kwl@.service
# 纯公网 IP 部署（有 /etc/kwl/tls-ip.env）：续期定时器单元也随版本更新
if [ -f /etc/kwl/tls-ip.env ]; then install -m 0644 deploy/systemd/kwl-cert-renew.service deploy/systemd/kwl-cert-renew.timer /etc/systemd/system/; fi
# 第 63 批（线上事故 2026-11-25）：装着域名证书却还留着纯 IP 部署的续期配置——停用续期定时器（否则它会用 IP 证书覆盖域名证书，客户端全部连不上）
if [ -f /etc/kwl/tls-ip.env ] && [ -f /etc/kwl/tls/cp.crt ] && openssl x509 -in /etc/kwl/tls/cp.crt -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:"; then
  systemctl disable --now kwl-cert-renew.timer 2>/dev/null || true
  echo "⚠ 本机是域名部署却留着纯 IP 部署的续期配置：已停用 kwl-cert-renew.timer；请把 /etc/kwl/tls-ip.env 移走（运维手册“排障”）"
fi
# 第 66 批（v1.3.0，D-292）：签名服务补“账号设备签发钥”（个人账号换电脑直接登录用）；已有则不动，幂等
# 第 71 批（v1.6.0）：线上 1.5.0 实测 /v1/meta 没有 device_auto_enroll——补钥失败原来只打一句、照常继续，个人账号换电脑于是退化成“等另一台电脑批准”，
# 试用 1 台的账号移除旧电脑后无人可批（死路）。改为：补钥失败记下，升级末尾核对 /v1/meta，没有开通就醒目报错并以退出码 3 结束（服务已照常运行，按提示补上后重跑核对即可）
CA_FAILED=0
if [ -f /etc/kwl/cp-signer.json ]; then
  node scripts/add-account-device-ca.mjs --config /etc/kwl/cp-signer.json --secrets /etc/kwl/secrets || { CA_FAILED=1; echo "✖ 补账号设备签发钥失败（见上一行原因）：升级末尾会再核对一次"; }
  [ -f /etc/kwl/secrets/account-device-ca.pem ] && { chgrp kwl /etc/kwl/secrets/account-device-ca.pem; chmod 0440 /etc/kwl/secrets/account-device-ca.pem; }
fi
systemctl daemon-reload
if [ -f /etc/nginx/sites-available/kwl-console.conf ] && command -v nginx >/dev/null; then
  DOMAIN=$(awk '/server_name/ {gsub(";",""); print $2; exit}' /etc/nginx/sites-available/kwl-console.conf)
  # shellcheck source=nginx-site.sh
  . deploy/scripts/nginx-site.sh
  kwl_nginx_site "$DOMAIN" "$CP_ORIGIN" "$APP" || { echo "nginx 配置检查没过；回滚：sudo bash $APP/deploy/scripts/rollback.sh"; exit 1; }
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
bash deploy/scripts/verify-capabilities.sh || {
  echo "✖✖ 升级已完成、服务正常运行，但“个人账号新电脑直接登录”没有开通（/v1/meta 缺 device_auto_enroll）：个人账号换电脑会退化成等批准。"
  echo "   处理：按运维手册“补账号设备签发钥”一节执行 node scripts/add-account-device-ca.mjs，再 sudo systemctl restart kwl@cp-signer kwl@control-plane，最后 sudo bash deploy/scripts/verify-capabilities.sh"
  [ "$CA_FAILED" = 1 ] && echo "   （本次补钥步骤就已失败，原因见上文）"
  exit 3
}
