#!/usr/bin/env bash
# 首次安装（在服务器上、以 root 运行；代码已 git clone 到 /opt/kwl/app 并切到发布标签）。可重复执行（幂等）。
#   sudo bash deploy/scripts/install.sh --cp-origin https://cp.kwl.example.com:8443 [--console-domain console.kwl.example.com] [--no-console]
# 做的事：建系统用户 kwl 与目录、核对 Node 版本、npm ci（只建工作区链接，运行时无第三方依赖）、
#         打包控制台到 /var/www/kwl-console（保留已有 config.json）、装 systemd 单元与 nginx 配置。不生成密钥、不启动服务。
set -euo pipefail
APP=/opt/kwl/app
CP_ORIGIN=""
CONSOLE_DOMAIN=""
WITH_CONSOLE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --cp-origin) CP_ORIGIN="$2"; shift 2 ;;
    --console-domain) CONSOLE_DOMAIN="$2"; shift 2 ;;
    --no-console) WITH_CONSOLE=0; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "请用 root（sudo）运行" >&2; exit 1; }
[ -f "$APP/scripts/cloud-serve.mjs" ] || { echo "$APP 里没有本仓库代码：先 git clone https://gitee.com/xcsi/kimi-work-legal-cloud.git $APP" >&2; exit 1; }

# 1. Node ≥ 24.15
command -v node >/dev/null || { echo "没有 node：先按部署手册第 2 节装 Node.js 24.15 以上" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=15)?0:1)' || { echo "Node 版本 $(node -v) 太旧，需要 24.15 以上" >&2; exit 1; }

# 2. 用户与目录
id kwl >/dev/null 2>&1 || useradd --system --home /opt/kwl --shell /usr/sbin/nologin kwl
install -d -o root -g kwl -m 0750 /etc/kwl /etc/kwl/tls /etc/kwl/secrets
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
    install -d /etc/nginx/snippets /var/www/letsencrypt
    sed "s#https://cp.kwl.example.com:8443#$CP_ORIGIN#g" "$APP/deploy/nginx/kwl-console-headers.conf" > /etc/nginx/snippets/kwl-console-headers.conf
    if [ -n "$CONSOLE_DOMAIN" ]; then
      sed "s#console.kwl.example.com#$CONSOLE_DOMAIN#g" "$APP/deploy/nginx/kwl-console.conf" > /etc/nginx/sites-available/kwl-console.conf
      ln -sf /etc/nginx/sites-available/kwl-console.conf /etc/nginx/sites-enabled/kwl-console.conf
      rm -f /etc/nginx/sites-enabled/default
      if [ -f /etc/kwl/tls/console.crt ]; then
        nginx -t || { echo "nginx 配置检查没过（见上面的报错），控制台没有上线" >&2; exit 1; }
        systemctl reload nginx
      else
        echo "提示：证书 /etc/kwl/tls/console.crt 还没有，装好证书后 nginx -t && systemctl reload nginx"
      fi
    fi
  else
    echo "提示：没装 nginx（apt-get install -y nginx），控制台静态页已在 $WEB"
  fi
fi
echo "安装完成：代码 $APP（$(cd "$APP" && git describe --tags --always 2>/dev/null || echo 非 git)），配置放 /etc/kwl/<角色>.json，密钥放 /etc/kwl/secrets/，数据 /var/lib/kwl。"
echo "下一步：按部署手册写配置与密钥，再 systemctl enable --now kwl@cp-signer kwl@control-plane kwl@gateway"
