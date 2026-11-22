set -e
B=https://127.0.0.1:8443
C() { curl -sk --noproxy "*" --max-time 15 "$@"; }
login() { local pw; pw=$(cat "/root/kwl-e2e/$1.pw"); local tok; tok=$(C -X POST $B/v1/auth/login -H 'content-type: application/json' -d "$(printf '{"email":"%s","password":"%s","client":{"platform":"web"}}' "$1" "$pw")" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("session_token",""))'); C -X POST $B/v1/auth/reauth -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "$(printf '{"password":"%s"}' "$pw")" >/dev/null; echo "$tok"; }
counts() { echo "账本 $(wc -l < /var/lib/kwl/control-plane/usage/2026-11.jsonl) 审计 $(wc -l < /var/lib/kwl/control-plane/audit.jsonl) 运营访问 $(wc -l < /var/lib/kwl/control-plane/ops/access.jsonl) 计量 $(wc -l < /var/lib/kwl/gateway/meter.jsonl) 提交 $(cd /opt/kwl/app && git rev-parse --short HEAD)"; }
plans() { C $B/v1/ops/plans -H "authorization: Bearer $1" | python3 -c 'import sys,json; print(sorted(p["id"] for p in json.load(sys.stdin)["plans"]))'; }
cd /opt/kwl/app
echo "== 0 升级后（新版）"; counts
O=$(login operator@kwl-demo.example)
# 升级后产生一条律所审计：给验收律所设上限 90%（之后取消不了——运营只能调低；演练律所，无妨）
echo "设上限: $(C -X POST $B/v1/ops/tenants/ten_b53ipfirm/cap -H "authorization: Bearer $O" -H 'content-type: application/json' -d '{"cap_pct":90}')"
echo "套餐目录: $(plans $O)"; counts
BACKUP=$(ls -1t /var/backups/kwl/kwl-*.tar.gz | head -1); echo "升级时的备份: $BACKUP"
echo "== 1 只回滚代码（旧版读新状态）"
bash deploy/scripts/rollback.sh 2>&1 | tail -4; counts
O=$(login operator@kwl-demo.example); echo "旧版套餐目录（新状态仍在）: $(plans $O)"
echo "== 2 再升级"
bash deploy/scripts/upgrade.sh e1a59db 2>&1 | tail -2; counts
echo "== 3 回滚并恢复升级前的备份（状态回去，账与日志保留）"
BEFORE_AUDIT=$(wc -l < /var/lib/kwl/control-plane/audit.jsonl); BEFORE_OPS=$(wc -l < /var/lib/kwl/control-plane/ops/access.jsonl)
bash deploy/scripts/rollback.sh 177fa3f --restore "$BACKUP" 2>&1 | tail -12; counts
O=$(login operator@kwl-demo.example); echo "恢复后套餐目录（升级后建的两个应不在）: $(plans $O)"
echo "审计保留: 恢复前 $BEFORE_AUDIT → 恢复后 $(wc -l < /var/lib/kwl/control-plane/audit.jsonl)；运营访问: $BEFORE_OPS → $(wc -l < /var/lib/kwl/control-plane/ops/access.jsonl)（应 ≥ 恢复前）"
echo "== 4 最终升级到新版"
bash deploy/scripts/upgrade.sh e1a59db 2>&1 | tail -2; counts
ls -d /var/lib/kwl.before-restore.* | tail -2
