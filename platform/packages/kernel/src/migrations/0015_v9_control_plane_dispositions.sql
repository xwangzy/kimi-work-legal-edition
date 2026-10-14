-- 0015_v9_control_plane_dispositions.sql — v9 阶段 6 复核处置
--   1) 见过的吊销（粘滞，复核主审自查 SF-3）：设备目录列为吊销、但本机设备表尚无的设备也记下——之后即使被重新列为有效也不插入；
--   2) 待同步到控制面的动作（复核 S6-A12）：本机吊销设备等收紧动作先记入队列，同步时重试，界面显示“已同步 / 待同步”。
-- kwl:managed-transaction

CREATE TABLE cp_revoked_devices (
  tenant_id  text NOT NULL,
  device_id  text NOT NULL,
  revoked_at text NOT NULL,
  source     text NOT NULL,
  PRIMARY KEY (tenant_id, device_id)
);

CREATE TABLE cp_pending_actions (
  action_id   integer PRIMARY KEY AUTOINCREMENT,
  tenant_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('revoke_device')),
  target      text NOT NULL,
  created_at  text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  done_at     text
);
CREATE INDEX cp_pending_actions_open_idx ON cp_pending_actions (tenant_id, done_at);
