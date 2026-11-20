# 控制台 nginx 站点的渲染与启用（install.sh、upgrade.sh 共用；用 source 引入，不单独执行）。
#   kwl_nginx_site <server_name> <控制面来源> <代码目录>
# - server_name：控制台域名，或纯公网 IP 部署时的 IP（nginx 按 Host 头匹配，IP 字面量可以直接写）；
# - 证书 /etc/kwl/tls/console.crt 与 console.key 都在时装完整站点（80 跳转 + 443），否则只装 80 端口那一份
#   （HTTP-01 验证 + 跳转）：首次签证书不再因“站点要证书、证书要站点”卡死；
# - 本机没开 IPv6 时去掉 listen [::]:… 几行（否则 nginx -t 报 Address family not supported by protocol）。
# 成功后把实际装上的是哪一份写到全局变量 KWL_NGINX_SITE（full / http-only）。
kwl_nginx_site() {
  local name="$1" cp="$2" app="$3" tmpl rendered
  [ -n "$name" ] && [ -n "$cp" ] || { echo "kwl_nginx_site：缺 server_name 或控制面来源" >&2; return 2; }
  install -d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled /var/www/letsencrypt
  sed "s#https://cp.kwl.example.com:8443#$cp#g" "$app/deploy/nginx/kwl-console-headers.conf" > /etc/nginx/snippets/kwl-console-headers.conf
  if [ -f /etc/kwl/tls/console.crt ] && [ -f /etc/kwl/tls/console.key ]; then tmpl=kwl-console.conf; KWL_NGINX_SITE=full; else tmpl=kwl-console-http.conf; KWL_NGINX_SITE=http-only; fi
  rendered=$(sed "s#console.kwl.example.com#$name#g" "$app/deploy/nginx/$tmpl")
  # /proc 下的文件 stat 大小恒为 0，不能用 [ -s ]：读内容判断本机有没有 IPv6 地址
  if ! grep -q . /proc/net/if_inet6 2>/dev/null; then rendered=$(printf '%s\n' "$rendered" | grep -v 'listen \[::\]'); fi
  printf '%s\n' "$rendered" > /etc/nginx/sites-available/kwl-console.conf
  ln -sf /etc/nginx/sites-available/kwl-console.conf /etc/nginx/sites-enabled/kwl-console.conf
  rm -f /etc/nginx/sites-enabled/default
  nginx -t || { echo "nginx 配置检查没过（见上面的报错）" >&2; return 1; }
  if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl enable --now nginx; fi
}
