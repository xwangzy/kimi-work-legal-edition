-- 0036_v9_reminders_cloud_version.sql — 第 10 批第三轮复核 S10B-25：云端确认持有的版本。
-- 有效提醒因超出云端可接受范围改为“只在本机”时：云端持有的正是当前版本就保留（仍可补发给离线设备）；
-- 是更旧的版本（离线时改过期限）就删掉，删完回到“只在本机”——不让旧期限、旧备注按旧时间送到同事与其他设备。
-- 另起迁移，不改已执行过的 0035（复核 S10B-22 局限）。

ALTER TABLE reminders ADD COLUMN cloud_version integer;
UPDATE reminders SET cloud_version = version WHERE cloud_state = 'synced';
