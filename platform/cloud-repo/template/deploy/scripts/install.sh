#!/usr/bin/env bash
# 首次安装（在服务器上、以 root 运行；代码已 git clone 到 /opt/kwl/app 并切到发布标签）。可重复执行（幂等）。
# 有域名：
#   sudo bash deploy/scripts/install.sh --cp-origin https://cp.kwl.example.com:8443 [--console-domain console.kwl.example.com] [--no-console]
# 只有公网 IPv4、没有域名（部署手册第 4 节“纯公网 IP”）：
#   sudo bash deploy/scripts/install.sh --public-ip 203.0.113.10 [--tls acme|demo-ca|manual]
#        [--acme-server <ACME 目录地址>] [--acme-ca-file <PEM>] [--trust-ca-file <PEM>] [--acme-email <邮箱>]
#        [--admin-email <首个系统管理员邮箱> --admin-name <姓名>] [--no-connect-address]
#   --tls acme（缺省）：Let's Encrypt 短期 IP 证书（约 6 天，自动续）；demo-ca：本机演示 CA（只给内部测试包）；manual：证书自己放
#   控制台、登录入口与平台运营接口对任意公网 IP 开放（D-218 取消运维网段）：--ops-cidr 已废弃，仍给出只提示“已忽略”
# 做的事：建系统用户 kwl 与目录、核对 Node 版本、npm ci（只建工作区链接，运行时无第三方依赖）、
#         打包控制台到 /var/www/kwl-console（保留已有 config.json）、装 systemd 单元与 nginx 配置。
#         纯公网 IP 时另外：把地址填进 /etc/kwl/{control-plane,gateway,search}.json 与控制台 config.json、签证书、装续期定时器、打印钉住值。
#         不生成服务密钥（cloud-init-secrets）、不启动服务。
set -euo pipefail
APP=/opt/kwl/app
CP_ORIGIN=""
CONSOLE_DOMAIN=""
WITH_CONSOLE=1
PUBLIC_IP=""
TLS_MODE=""
IPCFG_ARGS=()
TLS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --cp-origin) CP_ORIGIN="$2"; shift 2 ;;
    --console-domain) CONSOLE_DOMAIN="$2"; shift 2 ;;
    --no-console) WITH_CONSOLE=0; shift ;;
    --public-ip) PUBLIC_IP="$2"; shift 2 ;;
    --tls) TLS_MODE="$2"; shift 2 ;;
    # D-218：取消 IP 白名单准入（运维网段）——老命令里的 --ops-cidr 不报错，提示已忽略
    --ops-cidr) echo "提示：--ops-cidr 已废弃、已忽略（D-218：控制台与平台运营不再按来源 IP 准入，靠 TLS + 账号密码 + 角色权限 + 登录限流与锁定）"; shift 2 ;;
    --admin-email|--admin-name) IPCFG_ARGS+=("$1" "$2"); shift 2 ;;
    --no-connect-address) IPCFG_ARGS+=("$1"); shift ;;
    --acme-server|--acme-ca-file|--trust-ca-file) TLS_ARGS+=("$1" "$2"); shift 2 ;;
    --acme-email) TLS_ARGS+=(--email "$2"); shift 2 ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "请用 root（sudo）运行" >&2; exit 1; }
[ -f "$APP/scripts/cloud-serve.mjs" ] || { echo "$APP 里没有本仓库代码：先 git clone https://gitee.com/xcsi/kimi-work-legal-cloud.git $APP" >&2; exit 1; }
# shellcheck source=nginx-site.sh
. "$APP/deploy/scripts/nginx-site.sh"

# 1. Node ≥ 24.15
command -v node >/dev/null || { echo "没有 node：先按部署手册第 2 节装 Node.js 24.15 以上" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=15)?0:1)' || { echo "Node 版本 $(node -v) 太旧，需要 24.15 以上" >&2; exit 1; }

# 0. 纯公网 IP：地址就是控制台的“域名”，控制面在同一地址的 8443
if [ -n "$PUBLIC_IP" ]; then
  node -e 'process.exit(require("node:net").isIPv4(process.argv[1])?0:1)' "$PUBLIC_IP" || { echo "--public-ip 须为 IPv4 地址" >&2; exit 2; }
  [ -z "$CONSOLE_DOMAIN" ] || [ "$CONSOLE_DOMAIN" = "$PUBLIC_IP" ] || { echo "--public-ip 与 --console-domain 只给一个" >&2; exit 2; }
  CONSOLE_DOMAIN=$PUBLIC_IP
  [ -n "$CP_ORIGIN" ] || CP_ORIGIN="https://$PUBLIC_IP:8443"
  TLS_MODE=${TLS_MODE:-acme}
  case "$TLS_MODE" in acme|demo-ca|manual) ;; *) echo "--tls 须为 acme / demo-ca / manual" >&2; exit 2 ;; esac
  [ "$TLS_MODE" != demo-ca ] || echo "提示：--tls demo-ca 的证书由本机演示 CA 签发，只有内置了这个 CA 的内部测试包能连（偏离 D-212）；对外试点用 --tls acme"
fi

# 2. 用户与目录
id kwl >/dev/null 2>&1 || useradd --system --home /opt/kwl --shell /usr/sbin/nologin kwl
install -d -o root -g kwl -m 0750 /etc/kwl /etc/kwl/tls /etc/kwl/secrets
install -d -o root -g kwl -m 0755 /etc/kwl/public
install -d -o kwl -g kwl -m 0700 /var/lib/kwl
install -d -o root -g root -m 0700 /var/backups/kwl
# 已放好的服务私钥与密钥文件：属组 kwl、组可读（nginx 用的 console.key 只给 root）
for f in /etc/kwl/tls/*.key /etc/kwl/secrets/*; do [ -f "$f" ] || continue; case "$f" in */console.key) continue ;; esac; chgrp kwl "$f"; chmod 0440 "$f"; done
chown -R root:root "$APP"

# 3. 工作区链接（package-lock.json 锁定；--omit=dev 不装类型检查工具）
( cd "$APP" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )

# 4. systemd
install -m 0644 "$APP/deploy/systemd/kwl@.service" /etc/systemd/system/kwl@.service
systemctl daemon-reload

# 4.5 纯公网 IP：把地址填进各角色配置（已有配置只改与地址有关的几项）
if [ -n "$PUBLIC_IP" ]; then
  args=(--app "$APP" --etc /etc/kwl --public-ip "$PUBLIC_IP")
  [ "$WITH_CONSOLE" = 1 ] && install -d -m 0755 /var/www/kwl-console && args+=(--console-dir /var/www/kwl-console)
  node "$APP/deploy/scripts/ip-config.mjs" "${args[@]}" ${IPCFG_ARGS[@]+"${IPCFG_ARGS[@]}"}
  for r in control-plane gateway search; do chown root:kwl "/etc/kwl/$r.json"; chmod 0640 "/etc/kwl/$r.json"; done
fi

# 5. 控制台
if [ "$WITH_CONSOLE" = 1 ]; then
  [ -n "$CP_ORIGIN" ] || { echo "打包控制台需要 --cp-origin（控制面来源，如 https://cp.kwl.example.com:8443）；不装控制台加 --no-console" >&2; exit 2; }
  WEB=/var/www/kwl-console
  NEW="$WEB.new"
  rm -rf "$NEW"
  ( cd "$APP" && node scripts/build-console.mjs --out "$NEW" --control-plane "$CP_ORIGIN" )
  if [ -f "$WEB/config.json" ]; then cp -p "$WEB/config.json" "$NEW/config.json"; fi
  rm -rf "$WEB.old"; [ -d "$WEB" ] && mv "$WEB" "$WEB.old"; mv "$NEW" "$WEB"
  chown -R root:root "$WEB"; find "$WEB" -type d -exec chmod 0755 {} +; find "$WEB" -type f -exec chmod 0644 {} +
  [ -f "$WEB/config.json" ] || echo "提示：还没有 $WEB/config.json——按 deploy/console/config.example.json 写一份（control_plane_base 填 $CP_ORIGIN）"
  if command -v nginx >/dev/null; then
    if [ -n "$CONSOLE_DOMAIN" ]; then
      # 证书还没有时只装 80 端口那一份（证书验证 + 跳转），nginx -t 照样能过；证书到位后重跑本脚本换成完整站点
      kwl_nginx_site "$CONSOLE_DOMAIN" "$CP_ORIGIN" "$APP" || { echo "控制台没有上线" >&2; exit 1; }
      [ "$KWL_NGINX_SITE" = full ] || [ -n "$PUBLIC_IP" ] || echo "提示：证书 /etc/kwl/tls/console.crt 还没有，nginx 先只开 80 端口（证书验证用）。按部署手册第 4 节签好证书后重跑本脚本"
    fi
  else
    echo "提示：没装 nginx（apt-get install -y nginx），控制台静态页已在 $WEB"
  fi
fi

# 6. 纯公网 IP：证书（一把私钥、一张 IP 证书，四个端口共用）与续期定时器，再换成完整站点
if [ -n "$PUBLIC_IP" ] && [ "$TLS_MODE" != manual ]; then
  case "$TLS_MODE" in
    acme) bash "$APP/deploy/scripts/tls-ip.sh" acme --ip "$PUBLIC_IP" ${TLS_ARGS[@]+"${TLS_ARGS[@]}"} ;;
    demo-ca) bash "$APP/deploy/scripts/tls-ip.sh" demo-ca --ip "$PUBLIC_IP" ;;
  esac
  if [ "$WITH_CONSOLE" = 1 ] && command -v nginx >/dev/null; then
    kwl_nginx_site "$CONSOLE_DOMAIN" "$CP_ORIGIN" "$APP" || { echo "控制台没有上线" >&2; exit 1; }
  fi
fi
echo "安装完成：代码 $APP（$(cd "$APP" && git describe --tags --always 2>/dev/null || echo 非 git)），配置放 /etc/kwl/<角色>.json，密钥放 /etc/kwl/secrets/，数据 /var/lib/kwl。"
echo "下一步：按部署手册写配置与密钥，再 systemctl enable --now kwl@cp-signer kwl@control-plane kwl@gateway"
