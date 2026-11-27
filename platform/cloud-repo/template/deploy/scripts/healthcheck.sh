#!/usr/bin/env bash
# 逐个检查本机已启用的 kwl@ 服务：systemd 状态 + /healthz（+ /readyz）。全部正常退出 0。
# 按已装载的 kwl@ 单元逐个查（含 v1.8.0 起的共享中继 kwl@relay :8446，端口取 /etc/kwl/<角色>.json 的 listen.port）；中继还没开通时不在列表里，
# 由 verify-capabilities.sh 报缺项
#   sudo bash deploy/scripts/healthcheck.sh
set -uo pipefail
# 本机回环探测：只看进程是否在应答（证书由客户端钉住、对外校验在部署手册的“对外验证”一步做），所以这里用 -k
CURL=(curl -sSk --max-time 5)
bad=0
for unit in $(systemctl list-units --type=service --state=loaded --no-legend 'kwl@*' | awk '{print $1}'); do
  role=${unit#kwl@}; role=${role%.service}
  cfg=/etc/kwl/$role.json
  state=$(systemctl is-active "$unit")
  port=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.listen?.port??""))' "$cfg" 2>/dev/null)
  if [ "$state" != active ]; then echo "✖ $role：$state（journalctl -u $unit -n 50）"; bad=1; continue; fi
  if [ "$role" = cp-signer ]; then echo "✓ $role：active（mTLS，只许控制面调用，不做 HTTP 探测）"; continue; fi
  code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://127.0.0.1:$port/healthz" 2>/dev/null || echo 000)
  ready=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://127.0.0.1:$port/readyz" 2>/dev/null || echo 000)
  if [ "$code" = 200 ]; then echo "✓ $role：healthz 200，readyz $ready"; else echo "✖ $role：healthz $code（https://127.0.0.1:$port）"; bad=1; fi
done
exit $bad
