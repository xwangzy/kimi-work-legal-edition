#!/usr/bin/env bash
# 回滚代码到上一版本（upgrade.sh 记的那个，或显式给提交）；--restore <备份文件> 同时恢复数据（会停全部服务）。
#   sudo bash deploy/scripts/rollback.sh [<提交>] [--restore /var/backups/kwl/kwl-YYYYmmdd-HHMMSS.tar.gz] [--restore-all]
# --restore 恢复的是“状态”（律所、账号、设备、套餐、路由、额度）；只增不改的账与日志——用量账本、审计链、网关计量发件箱、签名流水、
# 运营访问记录、运行日志——保留恢复前的那一份（第 56 批，云端审计 8-A：原先整个目录换回备份，备份之后的计费行随回滚消失，
# 网关也不会重放；律所电脑上已取回的审计记录还会与云端对不上、报“云端改写了历史”）。确实要连这些一起换回备份时加 --restore-all。
# 第 73 批（v1.8.0）：共享中继的数据（<data_dir>/relay：团队事项的同步段与密文块）同样保留恢复前的那一份——换回备份会让律师电脑已同步到的
# 段号“倒退”，也会让备份之后按租户删除的数据重新出现。回滚代码本身不碰中继：1.7.x 的代码里就有中继角色，kwl@relay 照常重启。
set -euo pipefail
# 脚本中途会 git checkout 换掉本文件，而 bash 是边读边执行的：先把自己拷到临时文件再从那里执行
if [ -z "${KWL_SCRIPT_COPY:-}" ]; then
  tmp=$(mktemp /tmp/kwl-$(basename "$0").XXXXXX)
  cp "$0" "$tmp"
  KWL_SCRIPT_COPY=1 exec bash "$tmp" "$@"
fi
APP=/opt/kwl/app
TARGET=""
RESTORE=""
RESTORE_ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --restore) RESTORE="$2"; shift 2 ;;
    --restore-all) RESTORE_ALL=1; shift ;;
    *) TARGET="$1"; shift ;;
  esac
done
[ -n "$TARGET" ] || TARGET=$(cat /var/lib/kwl-upgrade/previous)
cd "$APP"
echo "回滚到 ${TARGET:0:12}"
ROLES=$(for r in relay notify support dist search gateway control-plane cp-signer; do systemctl is-enabled --quiet "kwl@$r" 2>/dev/null && echo "$r"; done)
if [ -n "$RESTORE" ]; then
  sha256sum -c "$RESTORE.sha256"
  for r in $ROLES; do systemctl stop "kwl@$r"; done
  OLD="/var/lib/kwl.before-restore.$(date +%s)"
  mv /var/lib/kwl "$OLD"
  tar -xzf "$RESTORE" -C / var/lib/kwl
  if [ "$RESTORE_ALL" = 0 ]; then
    for rel in control-plane/usage control-plane/audit.jsonl control-plane/ops gateway/meter.jsonl gateway/meter.ack cp-signer/ledger.jsonl relay obs; do
      [ -e "$OLD/$rel" ] || continue
      rm -rf "/var/lib/kwl/$rel"
      mkdir -p "$(dirname "/var/lib/kwl/$rel")"
      cp -a "$OLD/$rel" "/var/lib/kwl/$rel"
      echo "保留恢复前的 $rel"
    done
  fi
  echo "恢复前的数据目录留在 $OLD（确认无误后手工删除）"
  chown -R kwl:kwl /var/lib/kwl && chmod 0700 /var/lib/kwl
fi
git -c advice.detachedHead=false checkout --quiet "$TARGET"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
if [ -d /var/www/kwl-console.old ] && [ -z "$RESTORE" ]; then
  rm -rf /var/www/kwl-console.failed; mv /var/www/kwl-console /var/www/kwl-console.failed; mv /var/www/kwl-console.old /var/www/kwl-console
fi
for r in $(echo "$ROLES" | tac); do systemctl restart "kwl@$r"; sleep 2; done
bash deploy/scripts/healthcheck.sh && echo "回滚完成：$(git describe --tags --always)"
