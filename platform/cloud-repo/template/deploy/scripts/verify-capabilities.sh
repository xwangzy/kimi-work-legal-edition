#!/usr/bin/env bash
# 第 71 批（v1.6.0）：升级后核对云端公布的关键能力（本机回环访问控制面 /v1/meta）。缺了就非零退出并写明缺什么。
# 第 72 批（v1.7.0）：另核 workspaces、team_invites、team_member_auto_enroll、onboarding_state、catalog_epoch、device_share_confirm。
# 第 73 批（v1.8.0）：另核 team_roster，以及共享中继 kwl@relay（第五个标准服务）：已配置、已启用、/readyz 200、证书与控制面同一把公钥。
#   sudo bash deploy/scripts/verify-capabilities.sh [--no-relay]
#   --no-relay：本部署有意不开同事之间同步（不跑中继）时跳过中继核对
set -uo pipefail
NO_RELAY=0
[ "${1:-}" = --no-relay ] && NO_RELAY=1
cfg=/etc/kwl/control-plane.json
jget() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],c);process.stdout.write(v===undefined||v===null?"":String(v))' "$1" "$2" 2>/dev/null; }
port=$(jget "$cfg" listen.port)
[ -n "$port" ] || { echo "✖ 读不到控制面端口（$cfg）"; exit 2; }
meta=$(curl -sSk --max-time 5 "https://127.0.0.1:$port/v1/meta" 2>/dev/null || true)
[ -n "$meta" ] || { echo "✖ 控制面 /v1/meta 没有应答（https://127.0.0.1:$port）"; exit 2; }
bad=0
for f in device_auto_enroll device_signout account_switch workspaces team_invites team_member_auto_enroll onboarding_state catalog_epoch device_share_confirm team_roster; do
  if printf '%s' "$meta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit((j.features||[]).includes(process.argv[1])?0:1)})' "$f"; then echo "✓ $f"; else echo "✖ 缺 $f"; bad=1; fi
done

# 共享中继（同事之间同步）：v1.8.0 起是标准服务
rcfg=/etc/kwl/relay.json
if [ "$NO_RELAY" = 1 ]; then
  echo "– 共享中继：按 --no-relay 不核对（律所开不了同事之间同步）"
elif [ ! -f "$rcfg" ]; then
  echo "✖ 共享中继没有配置（$rcfg 不在）：sudo bash deploy/scripts/relay-setup.sh（运维手册 5.3）"; bad=1
elif ! systemctl is-enabled --quiet kwl@relay 2>/dev/null; then
  echo "✖ 共享中继没有启用（kwl@relay）：sudo bash deploy/scripts/relay-setup.sh（运维手册 5.3）"; bad=1
else
  rport=$(jget "$rcfg" listen.port)
  code=$(curl -sSk --max-time 5 -o /dev/null -w '%{http_code}' "https://127.0.0.1:$rport/readyz" 2>/dev/null || echo 000)
  if [ "$code" = 200 ]; then echo "✓ 共享中继 kwl@relay（:$rport）readyz 200"; else echo "✖ 共享中继 kwl@relay（:$rport）readyz $code：journalctl -u kwl@relay -n 80"; bad=1; fi
  # 客户端的中继钉住集照抄控制面的：两张证书的公钥必须相同
  pin() { openssl x509 -in "$1" -noout -pubkey 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | openssl dgst -sha256 -binary | base64; }
  rc=$(jget "$rcfg" tls.cert_file); cc=$(jget "$cfg" tls.cert_file)
  if [ -n "$rc" ] && [ -n "$cc" ] && [ -f "$rc" ] && [ -f "$cc" ]; then
    if [ "$(pin "$rc")" = "$(pin "$cc")" ]; then echo "✓ 共享中继与控制面同一把证书公钥（客户端 relay_pins = 控制面钉住集）"; else echo "✖ 共享中继证书公钥与控制面不同：已出的客户端按控制面钉住集连中继会失败（relay.json 的 tls 改回控制面的证书）"; bad=1; fi
  fi
fi
exit $bad
