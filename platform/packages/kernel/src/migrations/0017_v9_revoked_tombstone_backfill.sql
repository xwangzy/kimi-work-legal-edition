-- 0017_v9_revoked_tombstone_backfill.sql — v9 阶段 6 复核处置（S6-C08；S6-C17：另起迁移，已执行过 0016 的工作区同样回补）
--   此前（0015 之前或开发形态）已吊销的设备回补吊销墓碑：来源按本机吊销记（进入控制面形态时补建待同步动作）；
--   之后共享文件夹同步与事件验收对它们一律拒收。
-- kwl:managed-transaction

INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source)
SELECT tenant_id, device_id, COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')), 'local'
  FROM devices WHERE status = 'revoked';
