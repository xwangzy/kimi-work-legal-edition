-- 0035_v9_reminders_cloud.sql — 第 10 批两路复核处置（S10A-02～11、S10B-01～15）：期限提醒的云端状态。
-- cloud_may_have_copy：云端可能持有副本（发出登记之前即置 1，删除成功才清 0）——撤销、删除事项、配置变化时据此决定是否要云端删除，
--   不再被 'local' 覆盖（复核 S10A-07、S10B-02）；
-- cloud_next_at / cloud_attempts：可重试失败的退避（复核 S10A-07、S10B-01：不再有“进去就不重试”的失败态）；
-- cloud_body：当前版本已封好的各设备密文（结果不明后原样重发，命中云端“同版本同内容”幂等，不再升版本重响；复核 S10A-09、S10B-07）；
-- cloud_devices：登记时的接收设备与公钥指纹、发出签名公钥指纹（接收设备或密钥变化即升版本重登；复核 S10A-04/06、S10B-11）；
-- cloud_expire_at：云端副本最迟自动删除的时刻（触发后 7 天；事项删除后提醒行只留它与编号、版本，复核 S10B-14）。
-- reminder_holds：云端送来、暂时不能判断的条目（发出设备未知、签名对不上、发出者成员关系未同步、提前送达）首次见到的时刻，
--   超过 24 小时即判不合格（复核 S10A-03、S10B-15）；reminder_rejects：按原因累计丢弃条数（界面如实提示，复核 S10A-04）。

ALTER TABLE reminders ADD COLUMN cloud_may_have_copy integer NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN cloud_next_at text;
ALTER TABLE reminders ADD COLUMN cloud_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN cloud_body text;
ALTER TABLE reminders ADD COLUMN cloud_devices text;
ALTER TABLE reminders ADD COLUMN cloud_expire_at text;
UPDATE reminders SET cloud_may_have_copy = 1 WHERE cloud_state IN ('synced','failed','cancel_pending');
UPDATE reminders SET cloud_state = 'pending' WHERE cloud_state = 'failed' AND status = 'active';
UPDATE reminders SET cloud_state = 'cancel_pending' WHERE cloud_state = 'failed' AND status = 'cancelled';
UPDATE reminders SET cloud_expire_at = strftime('%Y-%m-%dT%H:%M:%fZ', remind_at, '+7 days');

CREATE TABLE reminder_holds (
  reminder_id text NOT NULL,
  version     integer NOT NULL,
  reason      text NOT NULL,
  first_seen  text NOT NULL,
  PRIMARY KEY (reminder_id, version)
);

CREATE TABLE reminder_rejects (
  tenant_id text NOT NULL,
  reason    text NOT NULL,
  count     integer NOT NULL DEFAULT 0,
  last_at   text NOT NULL,
  PRIMARY KEY (tenant_id, reason)
);
