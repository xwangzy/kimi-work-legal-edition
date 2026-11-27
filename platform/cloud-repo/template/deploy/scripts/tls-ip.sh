#!/usr/bin/env bash
# 纯公网 IP 部署（没有域名、只有一个公网 IPv4）的对外服务证书。控制台 443、控制面 8443、网关 8444、检索 8445 共用
# 一把 P-256 私钥和一张带 IP SAN 的证书；客户端钉住这把私钥的公钥（SPKI），外加一把离线备用密钥的公钥，共两把。
# 第 73 批（v1.8.0）：共享中继 8446 直接用控制面那一份（/etc/kwl/relay.json 的 tls 指向 cp.crt / cp.key），钉住值相同；续期时一起热换。
#
#   sudo bash deploy/scripts/tls-ip.sh acme    --ip <IPv4> [--acme-server <ACME 目录地址>] [--acme-ca-file <PEM>] [--trust-ca-file <PEM>] [--email <邮箱>]
#        公共 CA（缺省 Let's Encrypt 正式环境）签 6 天左右的短期 IP 证书（shortlived 配置，HTTP-01 验证走 80 端口）；装续期定时器。
#        --acme-ca-file：ACME 服务端自己的 HTTPS 证书要额外信任的 CA（只用于演练：Pebble）；
#        --trust-ca-file：服务之间（网关、检索 → 控制面）要额外信任的签发 CA（只用于演练：Pebble 的根证书）。
#   sudo bash deploy/scripts/tls-ip.sh demo-ca --ip <IPv4> [--rotate-ca]
#        演示 CA：本机建一个只能签这个 IP 的演示用 CA（名称约束），签一年期证书。只给内部测试包用（客户端 cloud_ca_file，偏离 D-212）。
#   sudo bash deploy/scripts/tls-ip.sh renew [--force]   定时器调用：acme 模式到期过半才真续（lego 判断）；demo-ca 模式剩不到 30 天时重签。
#        --force：立刻续一张（演练、或怀疑证书有问题时；占 Let's Encrypt 限额：同一 IP 每 7 天 5 张）
#   sudo bash deploy/scripts/tls-ip.sh deploy    续期钩子（lego 调用；也可手工执行）：核对公钥没变 → 装证书 → reload 各服务与 nginx
#   sudo bash deploy/scripts/tls-ip.sh pins      打印两把钉住值，并把交给客户端团队的材料放到 /etc/kwl/public/client-inputs/
#
# 钉住值不变的保证：私钥只生成一次（/etc/kwl/tls/ip/server.key，已有就绝不覆盖），每次签发都用这把私钥（lego --private-key + --reuse-key）；
# deploy 再核一次“新证书的公钥 = 这把私钥的公钥”，不等就拒绝安装。要换密钥只能换成备用密钥（部署手册 4.5）。
set -euo pipefail
APP=${KWL_APP:-/opt/kwl/app}
ETC=/etc/kwl
TLS=$ETC/tls
IPDIR=$TLS/ip                              # 当前私钥（唯一主本）与证书：root 0700
ENVF=$ETC/tls-ip.env                       # 模式与 ACME 参数，续期时读
ACME_PATH=/var/lib/kwl-acme                # lego 的账户与证书：root 0700
BACKUP_DIR=/root/kwl-offline/tls-backup    # 备用私钥：拷到离线介质后从服务器删除
BACKUP_PUB=$ETC/public/tls-backup.pub.pem  # 备用公钥（第二把钉住）
DEMO_CA=$ETC/demo-ca                       # 演示 CA：root 0700，私钥 0600
CERT_NAME=kwl-ip
LE_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory
# lego（ACME 客户端，单个静态二进制）：固定版本与官方发布的 sha256（https://github.com/go-acme/lego/releases/tag/v5.6.0 的 checksums.txt）
LEGO_VERSION=5.6.0
LEGO_SHA256_amd64=f02fc11b6f56b97e387fa7caa0268f86f5a336953b22458e6430e4651fea439a
LEGO_SHA256_arm64=34d87a6552d69390c4a4560237045c47713a8e148d899e16db0e97040894ed1f
LEGO=/usr/local/lib/kwl/lego-$LEGO_VERSION/lego

say() { echo "[tls-ip] $*"; }
die() { echo "[tls-ip] ✖ $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "请用 root（sudo）运行"
umask 077

is_ipv4() { node -e 'process.exit(require("node:net").isIPv4(process.argv[1])?0:1)' "$1" 2>/dev/null; }
# 钉住值：sha256/<SPKI DER 的 SHA-256 的 base64>（与客户端 make-release-config 同一算法）
pin_of_key()  { openssl pkey -in "$1" -pubout -outform der | openssl dgst -sha256 -binary | base64; }
pin_of_pub()  { openssl pkey -pubin -in "$1" -outform der | openssl dgst -sha256 -binary | base64; }
pin_of_cert() { openssl x509 -in "$1" -noout -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64; }

load_env() { [ -f "$ENVF" ] || die "$ENVF 不在：先执行 tls-ip.sh acme 或 demo-ca"; # shellcheck disable=SC1090
  . "$ENVF"; }
save_env() { # 变量名=值，逐行；值用 printf %q 转义
  local tmp; tmp=$(mktemp "$ENVF.XXXX")
  { echo "# tls-ip.sh 写的，续期定时器读；改模式请重跑 tls-ip.sh acme / demo-ca"
    for kv in "$@"; do printf '%s=%q\n' "${kv%%=*}" "${kv#*=}"; done; } > "$tmp"
  chmod 0600 "$tmp"; mv "$tmp" "$ENVF"
}

ensure_key() {
  install -d -o root -g root -m 0700 "$IPDIR"
  if [ ! -f "$IPDIR/server.key" ]; then
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$IPDIR/server.key"
    say "新生成服务私钥 $IPDIR/server.key（只此一份；以后续期都复用它，钉住值不变）"
  fi
  chmod 0600 "$IPDIR/server.key"
}

ensure_backup() {
  install -d -m 0755 "$ETC/public"
  if [ -f "$BACKUP_PUB" ]; then return; fi
  install -d -o root -g root -m 0700 "$BACKUP_DIR"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$BACKUP_DIR/server.backup.key"
  openssl pkey -in "$BACKUP_DIR/server.backup.key" -pubout -out "$BACKUP_PUB"
  chmod 0644 "$BACKUP_PUB"
  say "新生成备用密钥：私钥 $BACKUP_DIR/server.backup.key ——拷到离线介质（U 盘 / 密钥管理系统）后，从服务器删除：shred -u $BACKUP_DIR/server.backup.key"
}

# 服务之间额外信任的 CA（演示 CA、演练用 Pebble 根）：与内部 CA 合并成一个文件，经 systemd 附加配置交给 NODE_EXTRA_CA_CERTS。
# 不往 internal-ca.crt 里追加——签名服务拿它验客户端证书，混进别的 CA 会放宽 mTLS。
write_extra_trust() {
  local extra="${1:-}" bundle=$TLS/node-extra-ca.pem dropin=/etc/systemd/system/kwl@.service.d/kwl-extra-ca.conf
  if [ -z "$extra" ]; then
    if [ -f "$dropin" ]; then rm -f "$dropin" "$bundle"; systemctl daemon-reload; say "已去掉服务间额外信任（公共 CA 证书不需要）"; fi
    return
  fi
  local tmp; tmp=$(mktemp "$bundle.XXXX")
  { [ -f "$TLS/internal-ca.crt" ] && cat "$TLS/internal-ca.crt"; cat "$extra"; } > "$tmp"
  chmod 0644 "$tmp"; mv "$tmp" "$bundle"
  install -d -m 0755 "$(dirname "$dropin")"
  printf '%s\n' "# tls-ip.sh 写的：服务之间（网关、检索 → 控制面）认“内部 CA + $(basename "$extra")”。改回公共 CA 证书时 tls-ip.sh acme 会删掉本文件" \
    "[Service]" "Environment=NODE_EXTRA_CA_CERTS=$bundle" > "$dropin.tmp"
  chmod 0644 "$dropin.tmp"; mv "$dropin.tmp" "$dropin"
  systemctl daemon-reload
}

# 第 63 批（线上事故 2026-11-25）：这台机器已改成域名部署（装着带 DNS 名的证书）时，纯 IP 部署留下的续期任务不得覆盖它——
# 否则域名证书与私钥被 IP 证书换掉，按域名连接、钉住域名证书公钥的客户端全部连不上。改成域名部署后应停用定时器并移走 tls-ip.env。
refuse_if_domain_deployment() {
  [ -f "$TLS/cp.crt" ] || return 0
  if openssl x509 -in "$TLS/cp.crt" -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:"; then
    die "当前装的是域名证书（$(openssl x509 -in "$TLS/cp.crt" -noout -ext subjectAltName 2>/dev/null | grep -o 'DNS:[^,]*' | head -1)），本机已是域名部署：拒绝用 IP 证书覆盖。请停用续期：systemctl disable --now kwl-cert-renew.timer && mv $ETC/tls-ip.env $ETC/tls-ip.env.disabled"
  fi
}

# 装证书：同一张证书与私钥装成四个名字（配置与域名模式相同，以后换域名只换文件）。先核对证书公钥 = 当前私钥公钥。
install_cert() {
  local chain="$1" kp cp
  refuse_if_domain_deployment
  kp=$(pin_of_key "$IPDIR/server.key"); cp=$(pin_of_cert "$chain")
  [ "$kp" = "$cp" ] || die "新证书的公钥（sha256/$cp）不是当前私钥（sha256/$kp）：拒绝安装，否则已装好的客户端全部连不上。检查 lego 是否换了密钥"
  install -m 0644 "$chain" "$IPDIR/server.crt"
  for n in cp gw search; do
    install -m 0644 "$chain" "$TLS/$n.crt"
    install -o root -g kwl -m 0440 "$IPDIR/server.key" "$TLS/$n.key"
  done
  install -m 0644 "$chain" "$TLS/console.crt"
  install -o root -g root -m 0400 "$IPDIR/server.key" "$TLS/console.key"
  say "证书已装到 $TLS/{cp,gw,search,console}.crt（到 $(openssl x509 -in "$chain" -noout -enddate | cut -d= -f2)）"
}

# 热换：控制面、网关、检索、中继 reload（SIGHUP 重读证书，不断连接）；单元还没有 ExecReload 时退回重启。nginx 检查配置后 reload。
reload_all() {
  for r in control-plane gateway search relay; do
    systemctl is-active --quiet "kwl@$r" || continue
    systemctl reload "kwl@$r" 2>/dev/null || systemctl try-restart "kwl@$r"
    say "kwl@$r 已换用新证书"
  done
  if systemctl is-active --quiet nginx; then nginx -t -q && systemctl reload nginx && say "nginx 已换用新证书"; fi
}

need_lego() {
  [ -x "$LEGO" ] && return
  local arch sum dir
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "不支持的架构 $(uname -m)" ;; esac
  sum=$([ "$arch" = amd64 ] && echo "$LEGO_SHA256_amd64" || echo "$LEGO_SHA256_arm64")
  dir=$(mktemp -d)
  say "下载 lego v$LEGO_VERSION（$arch）并核对 sha256"
  curl -fsSL --proto '=https' -o "$dir/lego.tar.gz" "https://github.com/go-acme/lego/releases/download/v$LEGO_VERSION/lego_v${LEGO_VERSION}_linux_$arch.tar.gz"
  echo "$sum  $dir/lego.tar.gz" | sha256sum -c --quiet - || { rm -rf "$dir"; die "lego 安装包 sha256 不符，停止"; }
  tar -xzf "$dir/lego.tar.gz" -C "$dir" lego
  install -d -m 0755 "$(dirname "$LEGO")"
  install -m 0755 "$dir/lego" "$LEGO"
  rm -rf "$dir"
}

# 跑一次 lego run（首次签发与续期同一条命令；没到续期时间就什么都不做）。续了才调 deploy 钩子。
lego_run() {
  local first="${1:-}" challenge=() extra=()
  install -d -o root -g root -m 0700 "$ACME_PATH"
  # HTTP-01：nginx 在跑就把验证文件写进它的 webroot（站点里放行了 /.well-known/acme-challenge/）；否则 lego 自己临时监听 80
  # 验证文件要让 nginx（www-data）读得到：目录 0755，lego 在 umask 022 下跑（本脚本其余部分是 077）
  if systemctl is-active --quiet nginx; then install -d -m 0755 /var/www/letsencrypt /var/www/letsencrypt/.well-known /var/www/letsencrypt/.well-known/acme-challenge; challenge=(--http --http.webroot /var/www/letsencrypt)
  else challenge=(--http --http.address :80); fi
  [ -n "${KWL_ACME_EMAIL:-}" ] && extra+=(--email "$KWL_ACME_EMAIL")
  [ "$first" = force ] && extra+=(--renew-force)
  # 定时器自带随机延迟，lego 不再随机睡；ARI（续期时间建议）缺省开着，按 CA 建议的时间续且不占限额
  ( umask 022; LEGO_CA_CERTIFICATES="${KWL_ACME_CA_FILE:-}" "$LEGO" run \
    --server "$KWL_ACME_SERVER" --accept-tos --path "$ACME_PATH" --cert.name "$CERT_NAME" \
    --domains "$KWL_PUBLIC_IP" --profile shortlived --key-type EC256 \
    --private-key "$IPDIR/server.key" --reuse-key --no-random-sleep \
    "${challenge[@]}" "${extra[@]}" \
    --deploy-hook "/usr/bin/bash $APP/deploy/scripts/tls-ip.sh deploy" --deploy-hook-timeout 3m )
}

install_timer() {
  install -m 0644 "$APP/deploy/systemd/kwl-cert-renew.service" "$APP/deploy/systemd/kwl-cert-renew.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now kwl-cert-renew.timer >/dev/null
  say "续期定时器已启用：systemctl list-timers kwl-cert-renew.timer"
}

parse_common() {
  IP=""; ACME_SERVER=$LE_DIRECTORY; ACME_CA_FILE=""; TRUST_CA_FILE=""; EMAIL=""; ROTATE_CA=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ip) IP="$2"; shift 2 ;;
      --acme-server) ACME_SERVER="$2"; shift 2 ;;
      --acme-ca-file) ACME_CA_FILE="$2"; shift 2 ;;
      --trust-ca-file) TRUST_CA_FILE="$2"; shift 2 ;;
      --email) EMAIL="$2"; shift 2 ;;
      --rotate-ca) ROTATE_CA=1; shift ;;
      *) die "不认识的参数：$1" ;;
    esac
  done
  is_ipv4 "$IP" || die "--ip 须为 IPv4 地址"
}

cmd_acme() {
  parse_common "$@"
  [[ "$ACME_SERVER" == https://* ]] || die "--acme-server 须为 https 地址"
  for f in "$ACME_CA_FILE" "$TRUST_CA_FILE"; do [ -z "$f" ] || [ -f "$f" ] || die "$f 不在"; done
  ensure_key; ensure_backup; need_lego
  [ -n "$ACME_CA_FILE" ] && install -m 0644 "$ACME_CA_FILE" "$IPDIR/acme-server-ca.pem" && ACME_CA_FILE=$IPDIR/acme-server-ca.pem
  if [ -n "$TRUST_CA_FILE" ]; then install -m 0644 "$TRUST_CA_FILE" "$IPDIR/trust-ca.pem"; TRUST_CA_FILE=$IPDIR/trust-ca.pem; fi
  save_env KWL_TLS_MODE=acme KWL_PUBLIC_IP="$IP" KWL_ACME_SERVER="$ACME_SERVER" KWL_ACME_CA_FILE="$ACME_CA_FILE" KWL_TRUST_CA_FILE="$TRUST_CA_FILE" KWL_ACME_EMAIL="$EMAIL"
  load_env
  write_extra_trust "$TRUST_CA_FILE"
  [ "$ACME_SERVER" = "$LE_DIRECTORY" ] || say "提示：ACME 服务端是 $ACME_SERVER（不是 Let's Encrypt 正式环境），签出的证书客户端不认，只用于演练"
  say "向 $ACME_SERVER 申请 $IP 的短期证书（shortlived，HTTP-01 验证：CA 会连 http://$IP/.well-known/acme-challenge/…，80 端口须对公网放行）"
  lego_run first
  [ -f "$IPDIR/server.crt" ] || die "lego 没有签下证书（见上面的报错）。常见原因：80 端口没对公网放行、IP 不是本机公网地址、限额（同一 IP 每 7 天 5 张）"
  install_timer
  cmd_pins
}

cmd_demo_ca() {
  parse_common "$@"
  ensure_key; ensure_backup
  install -d -o root -g root -m 0700 "$DEMO_CA"
  if [ -f "$DEMO_CA/demo-ca.key" ] && [ "$(cat "$DEMO_CA/ip" 2>/dev/null)" != "$IP" ]; then
    [ "$ROTATE_CA" = 1 ] || die "演示 CA 是为 $(cat "$DEMO_CA/ip" 2>/dev/null || echo 别的地址) 建的（名称约束只许签那个 IP）。换 IP 要换 CA、客户端要重新出包：加 --rotate-ca"
    mv "$DEMO_CA" "$DEMO_CA.old-$(date +%Y%m%d%H%M%S)"; install -d -o root -g root -m 0700 "$DEMO_CA"
  fi
  if [ ! -f "$DEMO_CA/demo-ca.key" ]; then
    # 名称约束：这个 CA 只能签 $IP 一个地址的证书；DNS 名只许 .invalid（保留的不可解析后缀），私钥泄露也签不出别的地址或真实域名
    openssl req -x509 -new -utf8 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
      -keyout "$DEMO_CA/demo-ca.key" -out "$DEMO_CA/demo-ca.crt" -days 825 \
      -subj "/O=KWL 演示用（非生产）/CN=KWL Demo CA 演示用 $IP" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "nameConstraints=critical,permitted;IP:$IP/255.255.255.255,permitted;DNS:demo.invalid" \
      -addext "subjectKeyIdentifier=hash"
    echo "$IP" > "$DEMO_CA/ip"
    chmod 0600 "$DEMO_CA/demo-ca.key"
    say "新建演示 CA：$DEMO_CA/demo-ca.crt（私钥 $DEMO_CA/demo-ca.key 0600，只在本机）"
  fi
  local d; d=$(mktemp -d)
  # CN 故意不写成 IP 或域名的样子（带空格）：OpenSSL 会把“像主机名”的 CN 也拿去比名称约束
  openssl req -new -utf8 -key "$IPDIR/server.key" -subj "/O=KWL 演示用（非生产）/CN=KWL demo server $IP" -out "$d/server.csr"
  printf '%s\n' "subjectAltName=IP:$IP" "extendedKeyUsage=serverAuth" "keyUsage=critical,digitalSignature" \
    "basicConstraints=critical,CA:FALSE" "authorityKeyIdentifier=keyid" "subjectKeyIdentifier=hash" > "$d/ext"
  openssl x509 -req -in "$d/server.csr" -CA "$DEMO_CA/demo-ca.crt" -CAkey "$DEMO_CA/demo-ca.key" -CAcreateserial \
    -days 365 -sha256 -extfile "$d/ext" -out "$d/server.crt" 2>/dev/null
  openssl verify -CAfile "$DEMO_CA/demo-ca.crt" "$d/server.crt" >/dev/null || die "演示 CA 签出的证书自检不过"
  install_cert "$d/server.crt"
  rm -rf "$d"
  install -m 0644 "$DEMO_CA/demo-ca.crt" "$ETC/public/demo-ca.crt"
  save_env KWL_TLS_MODE=demo-ca KWL_PUBLIC_IP="$IP"
  write_extra_trust "$DEMO_CA/demo-ca.crt"
  # 换了信任文件要重启才生效（NODE_EXTRA_CA_CERTS 只在进程启动时读）
  for r in control-plane gateway search relay; do systemctl try-restart "kwl@$r" 2>/dev/null || true; done
  if systemctl is-active --quiet nginx; then nginx -t -q && systemctl reload nginx; fi
  install_timer
  cmd_pins
}

cmd_deploy() {
  load_env
  local chain=""
  # lego 调用时给出证书路径（LEGO_CERT_PATH）；手工执行时用 lego 存放处的那一份
  for c in "${LEGO_CERT_PATH:-}" "$ACME_PATH/certificates/$CERT_NAME.crt"; do [ -n "$c" ] && [ -f "$c" ] && { chain=$c; break; }; done
  [ -n "$chain" ] || die "找不到 lego 签下的证书（$ACME_PATH/certificates/$CERT_NAME.crt）"
  install_cert "$chain"
  write_extra_trust "${KWL_TRUST_CA_FILE:-}"
  reload_all
}

cmd_renew() {
  local force=""; [ "${1:-}" = --force ] && force=force
  load_env
  refuse_if_domain_deployment
  case "$KWL_TLS_MODE" in
    acme) need_lego; lego_run "$force" ;;
    demo-ca)
      if [ -z "$force" ] && openssl x509 -in "$TLS/cp.crt" -noout -checkend $((30 * 86400)) >/dev/null; then say "演示证书还有 30 天以上，不续"; else cmd_demo_ca --ip "$KWL_PUBLIC_IP"; return; fi ;;
    *) die "未知模式 $KWL_TLS_MODE" ;;
  esac
  # 兜底：装着的证书 24 小时内到期就报失败（定时器单元记为 failed，监控能看到）
  openssl x509 -in "$TLS/cp.crt" -noout -checkend 86400 >/dev/null || die "正在用的证书 24 小时内到期，续期一直没成功：journalctl -u kwl-cert-renew -n 100"
}

# 两把钉住值，以及交给客户端团队的材料（不含任何私钥）
cmd_pins() {
  load_env
  local cur bak out=$ETC/public/client-inputs mode=$KWL_TLS_MODE ip=$KWL_PUBLIC_IP
  cur=$(pin_of_key "$IPDIR/server.key"); bak=$(pin_of_pub "$BACKUP_PUB")
  [ -f "$TLS/cp.crt" ] && [ "$(pin_of_cert "$TLS/cp.crt")" != "$cur" ] && say "⚠ 装着的证书公钥与当前私钥不符，先执行 tls-ip.sh deploy"
  install -d -m 0755 "$out"
  install -m 0644 "$BACKUP_PUB" "$out/tls-backup.pub.pem"
  for f in cp-public-keys.json seat-public-keys.json; do [ -f "$ETC/public/$f" ] && install -m 0644 "$ETC/public/$f" "$out/$f"; done
  local ca_line="" test_build=false relay_line="" relay_pin="" rport=""
  if [ "$mode" = demo-ca ]; then install -m 0644 "$ETC/public/demo-ca.crt" "$out/demo-ca.crt"; ca_line='  "cloud_ca_file": "demo-ca.crt",'; test_build=true; fi
  # 共享中继（v1.8.0）：配了 relay.json 才写进说明文件；与控制面同一张证书，钉住值相同
  if [ -f "$ETC/relay.json" ]; then
    rport=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).listen?.port??8446))' "$ETC/relay.json" 2>/dev/null || echo 8446)
    relay_line="  \"relay_base\": \"https://$ip:$rport\","
    relay_pin=", \"relay\": [\"sha256/$cur\"]"
  fi
  cat > "$out/client-release-spec.json" <<SPEC
{
  "\$comment": "纯公网 IP 部署（$mode）交给客户端团队的说明文件：在本目录执行 make-release-config --spec client-release-spec.json（相对路径按当前目录）。各服务（含共享中继）共用一张证书，钉住值相同。$([ "$mode" = demo-ca ] && echo "演示 CA 只许内部测试包（D-212）。")",
  "control_plane_base": "https://$ip:8443",
  "gateway_base": "https://$ip:8444/v1",
  "search_base": "https://$ip:8445/v1/search",
$relay_line
$ca_line
  "backup_pins": ["tls-backup.pub.pem"],
  "pins": { "control_plane": ["sha256/$cur"], "gateway": ["sha256/$cur"], "search": ["sha256/$cur"]$relay_pin },
  "cp_public_keys_file": "cp-public-keys.json",
  "seat_public_keys_file": "seat-public-keys.json",
  "test_build": $test_build
}
SPEC
  sed -i '/^$/d' "$out/client-release-spec.json"
  printf 'control_plane https://%s:8443  sha256/%s  sha256/%s\ngateway       https://%s:8444  sha256/%s  sha256/%s\nsearch        https://%s:8445  sha256/%s  sha256/%s\n' \
    "$ip" "$cur" "$bak" "$ip" "$cur" "$bak" "$ip" "$cur" "$bak" > "$out/pins.txt"
  [ -z "$rport" ] || printf 'relay         https://%s:%s  sha256/%s  sha256/%s\n' "$ip" "$rport" "$cur" "$bak" >> "$out/pins.txt"
  chmod 0644 "$out/client-release-spec.json" "$out/pins.txt"
  say "模式 $mode，地址 $ip。钉住值（控制面、网关、检索$([ -n "$rport" ] && echo "、中继")相同）："
  say "  当前  sha256/$cur"
  say "  备份  sha256/$bak"
  say "交给客户端团队的材料：$out/（说明文件、公钥表、备用公钥$([ "$mode" = demo-ca ] && echo "、演示 CA 证书")；不含私钥）"
  [ -f "$BACKUP_DIR/server.backup.key" ] && say "⚠ 备用私钥还在服务器上：$BACKUP_DIR/server.backup.key——拷到离线介质后 shred -u 删除"
  return 0
}

cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
  acme) cmd_acme "$@" ;;
  demo-ca) cmd_demo_ca "$@" ;;
  renew) cmd_renew "$@" ;;
  deploy) cmd_deploy ;;
  pins) cmd_pins ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
