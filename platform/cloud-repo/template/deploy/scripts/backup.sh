#!/usr/bin/env bash
# 备份数据目录与配置（不含 /etc/kwl/secrets：密钥只在密钥管理里备份）。保留最近 14 份。
#   sudo bash deploy/scripts/backup.sh [--stop]      --stop：备份期间短暂停控制面（严格一致；不加也安全：状态两代交替原子写、账本只追加）
set -euo pipefail
DEST=/var/backups/kwl
KEEP=${KWL_BACKUP_KEEP:-14}
STOP=0; [ "${1:-}" = --stop ] && STOP=1
install -d -m 0700 "$DEST"
ts=$(date +%Y%m%d-%H%M%S)
out="$DEST/kwl-$ts.tar.gz"
if [ "$STOP" = 1 ] && systemctl is-active --quiet kwl@control-plane; then systemctl stop kwl@control-plane; trap 'systemctl start kwl@control-plane' EXIT; fi
# 日志（obs）不进备份：体积大、另有保留期
tar --exclude='/var/lib/kwl/obs' --exclude='/etc/kwl/secrets' -czf "$out" /var/lib/kwl /etc/kwl 2>/dev/null
chmod 0600 "$out"
( cd /opt/kwl/app && git rev-parse HEAD ) > "$out.commit" 2>/dev/null || true
sha256sum "$out" > "$out.sha256"
ls -1t "$DEST"/kwl-*.tar.gz | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f" "$f.commit" "$f.sha256"; done
echo "已备份：$out（$(du -h "$out" | cut -f1)，代码 $(cat "$out.commit" 2>/dev/null | cut -c1-12)）"
