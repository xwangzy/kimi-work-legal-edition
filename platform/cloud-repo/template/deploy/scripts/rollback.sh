#!/usr/bin/env bash
# 回滚代码到上一版本（upgrade.sh 记的那个，或显式给提交）；--restore <备份文件> 同时恢复数据（会停全部服务、覆盖 /var/lib/kwl）。
#   sudo bash deploy/scripts/rollback.sh [<提交>] [--restore /var/backups/kwl/kwl-YYYYmmdd-HHMMSS.tar.gz]
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
while [ $# -gt 0 ]; do
  case "$1" in
    --restore) RESTORE="$2"; shift 2 ;;
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
  mv /var/lib/kwl "/var/lib/kwl.before-restore.$(date +%s)"
  tar -xzf "$RESTORE" -C / var/lib/kwl
  chown -R kwl:kwl /var/lib/kwl && chmod 0700 /var/lib/kwl
fi
git -c advice.detachedHead=false checkout --quiet "$TARGET"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
if [ -d /var/www/kwl-console.old ] && [ -z "$RESTORE" ]; then
  rm -rf /var/www/kwl-console.failed; mv /var/www/kwl-console /var/www/kwl-console.failed; mv /var/www/kwl-console.old /var/www/kwl-console
fi
for r in $(echo "$ROLES" | tac); do systemctl restart "kwl@$r"; sleep 2; done
bash deploy/scripts/healthcheck.sh && echo "回滚完成：$(git describe --tags --always)"
