#!/usr/bin/env bash
# 第 71 批（v1.6.0）：升级后核对云端公布的关键能力（本机回环访问控制面 /v1/meta）。缺了就非零退出并写明缺什么。
# 第 72 批（v1.7.0）：另核 workspaces、team_invites、team_member_auto_enroll、onboarding_state、catalog_epoch、device_share_confirm。
#   sudo bash deploy/scripts/verify-capabilities.sh
set -uo pipefail
cfg=/etc/kwl/control-plane.json
port=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.listen?.port??""))' "$cfg" 2>/dev/null)
[ -n "$port" ] || { echo "✖ 读不到控制面端口（$cfg）"; exit 2; }
meta=$(curl -sSk --max-time 5 "https://127.0.0.1:$port/v1/meta" 2>/dev/null || true)
[ -n "$meta" ] || { echo "✖ 控制面 /v1/meta 没有应答（https://127.0.0.1:$port）"; exit 2; }
bad=0
for f in device_auto_enroll device_signout account_switch workspaces team_invites team_member_auto_enroll onboarding_state catalog_epoch device_share_confirm; do
  if printf '%s' "$meta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit((j.features||[]).includes(process.argv[1])?0:1)})' "$f"; then echo "✓ $f"; else echo "✖ 缺 $f"; bad=1; fi
done
exit $bad
