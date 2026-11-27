#!/usr/bin/env bash
# 开通共享中继（同事之间同步；第 73 批 v1.8.0，D-309）：第五个标准服务 kwl@relay，端口 8446，与控制面同一张证书（钉住集相同）。
# 新部署在第 7 节启动之后、已有部署在升级到 v1.8.0 之后各执行一次；可重复执行（幂等）。
#   sudo bash deploy/scripts/relay-setup.sh [--port 8446] [--cp-url https://<控制面对外主机>:8443] [--no-ufw]
# 做的事：写 /etc/kwl/relay.json（relay-config.mjs：证书、服务间凭据、数据目录取控制面的，控制面地址取网关的）→ 补中继受众席位公钥表
#        → ufw 在用时放行端口（云安全组要自己放行）→ systemctl enable --now kwl@relay → 核对 /readyz 与证书 → 打印交给客户端团队的
#        relay_base 与钉住值；纯公网 IP 部署另重新生成 /etc/kwl/public/client-inputs/（带上中继）。
# 不做的：不改控制面、网关、检索；不签发新证书（复用控制面的）；不开通任何律所——律所还要由管理员在客户端“设置 → 团队”开通“同事之间同步”。
set -euo pipefail
APP=${KWL_APP:-/opt/kwl/app}
ETC=/etc/kwl
UFW=1
CFG_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port|--cp-url) CFG_ARGS+=("$1" "$2"); shift 2 ;;
    --no-ufw) UFW=0; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "请用 root（sudo）运行" >&2; exit 1; }
say() { echo "[relay-setup] $*"; }

# 1. 配置与中继受众席位公钥（失败即停，原因见 relay-config 的输出）
out=$(node "$APP/deploy/scripts/relay-config.mjs" --app "$APP" --etc "$ETC" ${CFG_ARGS[@]+"${CFG_ARGS[@]}"}) || exit $?
printf '%s\n' "$out" | grep -v '^relay_base=' || true
RELAY_BASE=$(printf '%s\n' "$out" | sed -n 's/^relay_base=//p' | tail -1)
chown root:kwl "$ETC/relay.json"; chmod 0640 "$ETC/relay.json"
SEAT=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).seat_keys_file))' "$ETC/relay.json")
[ -f "$SEAT" ] && chmod 0644 "$SEAT"
PORT=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).listen.port))' "$ETC/relay.json")

# 2. 防火墙：本机 ufw 在用就放行；云安全组只能在云平台上放行
if [ "$UFW" = 1 ] && command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow "$PORT/tcp" >/dev/null && say "ufw 已放行 $PORT/tcp"
fi
say "云主机的安全组也要放行 $PORT/tcp（对所有来源，与 8443/8444/8445 相同）"

# 3. 起服务（单元模板 kwl@.service 已装；没装时先装）
[ -f /etc/systemd/system/kwl@.service ] || { install -m 0644 "$APP/deploy/systemd/kwl@.service" /etc/systemd/system/kwl@.service; systemctl daemon-reload; }
systemctl enable kwl@relay >/dev/null 2>&1
# 已在跑时也重启一次：读到刚写的配置
systemctl restart kwl@relay
ok=0
for _ in $(seq 1 15); do
  code=$(curl -sSk --max-time 3 -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/readyz" 2>/dev/null || echo 000)
  [ "$code" = 200 ] && { ok=1; break; }
  sleep 1
done
if [ "$ok" != 1 ]; then
  echo "[relay-setup] ✖ kwl@relay 没有就绪（readyz $code）：journalctl -u kwl@relay -n 80 --no-pager" >&2
  echo "[relay-setup]   常见原因：控制面不可达或签名不符（首次取不到吊销集即拒绝启动）；seat_keys_file 里放了别的受众的公钥；证书文件 kwl 读不到" >&2
  exit 1
fi
say "kwl@relay 已就绪（https 0.0.0.0:$PORT，/readyz 200）"

# 4. 钉住值：中继与控制面同一张证书 → 钉住集相同
pin_of_cert() { openssl x509 -in "$1" -noout -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64; }
RCERT=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tls.cert_file))' "$ETC/relay.json")
CCERT=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tls?.cert_file??""))' "$ETC/control-plane.json")
RPIN=$(pin_of_cert "$RCERT")
if [ -n "$CCERT" ] && [ -f "$CCERT" ] && [ "$(pin_of_cert "$CCERT")" != "$RPIN" ]; then
  say "⚠ 中继证书公钥与控制面不同：客户端的 relay_pins 不能照抄控制面的，要单独给（含备用钉住）"
fi
if [ -f "$ETC/tls-ip.env" ]; then
  bash "$APP/deploy/scripts/tls-ip.sh" pins >/dev/null && say "纯公网 IP 部署：/etc/kwl/public/client-inputs/ 已重新生成（说明文件带上 relay_base 与中继钉住值）"
fi
say "交给客户端团队（写进 client-release-spec 后重新出包，或分发带中继地址的签名地址配置 / release.json）："
say "  relay_base         $RELAY_BASE"
say "  relay 当前钉住值    sha256/$RPIN（与控制面相同；备用钉住也照控制面的 control_plane_backup_pins 给 relay_backup_pins）"
say "律所开通：管理员在客户端“设置 → 团队 → 团队策略”开通“同事之间同步”（团队版一人签、律所版两人签；最长 30 天，到期前续期）"
