set -e
B=https://192.168.64.20:8443
C() { curl -sk --noproxy "*" --max-time 15 "$@"; }
login() { # email → token（密码只在本脚本内使用，不打印）
  local pw; pw=$(cat "/root/kwl-e2e/$1.pw")
  local tok; tok=$(C -X POST $B/v1/auth/login -H 'content-type: application/json' -d "$(printf '{"email":"%s","password":"%s","client":{"platform":"web"}}' "$1" "$pw")" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("session_token",""))')
  C -X POST $B/v1/auth/reauth -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "$(printf '{"password":"%s"}' "$pw")" >/dev/null
  echo "$tok"
}
A=$(login admin@kwl-demo.example); O=$(login operator@kwl-demo.example)
echo "sysadmin 权限含: $(C $B/v1/ops/roles -H "authorization: Bearer $A" | python3 -c 'import sys,json; r=[x for x in json.load(sys.stdin)["roles"] if x["id"]=="sysadmin"][0]["perms"]; print([p for p in r if p in ("plan.manage","price.manage","route.manage")])')"
echo "未定价建金额套餐: $(C -X PUT $B/v1/ops/plans/b56-vm-cny -H "authorization: Bearer $A" -H 'content-type: application/json' -d '{"label":"虚机金额","quota_unit":"cny","seat_quota":10}' | python3 -c 'import sys,json; j=json.load(sys.stdin); print(j.get("error",{}).get("code"), j.get("error",{}).get("aliases") or j.get("ok"))')"
echo "系统管理员建 token 套餐: $(C -X PUT $B/v1/ops/plans/b56-vm-tok -H "authorization: Bearer $A" -H 'content-type: application/json' -d '{"label":"虚机按量","quota_unit":"tokens","seat_quota":1000000}' | python3 -c 'import sys,json; j=json.load(sys.stdin); print(j.get("ok"), j.get("error",{}).get("code"))')"
echo "设备最近使用(运营视图前3): $(C "$B/v1/ops/devices" -H "authorization: Bearer $O" | python3 -c 'import sys,json; print([(d["last_seen_on"],d["registered_at"][:10]) for d in json.load(sys.stdin)["devices"][:3]])')"
M=$(date -u +%Y-%m)
echo "本月账单行: $(C "$B/v1/ops/billing?period=$M" -H "authorization: Bearer $O" | python3 -c 'import sys,json; j=json.load(sys.stdin); print([(r["tid"],r.get("basis"),r["requests"],r["value_cny"]) for r in j["rows"][:3]])')"
echo "上月账单 basis: $(C "$B/v1/ops/billing?period=2026-10" -H "authorization: Bearer $O" | python3 -c 'import sys,json; j=json.load(sys.stdin); print(sorted(set(r.get("basis") for r in j["rows"])))')"
echo "账本行数 $(wc -l < /var/lib/kwl/control-plane/usage/2026-11.jsonl) 审计 $(wc -l < /var/lib/kwl/control-plane/audit.jsonl) 提交 $(cd /opt/kwl/app && git rev-parse --short HEAD)"
