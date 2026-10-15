-- 0034_v9_reminders.sql — 第 10 批 S9 期限提醒（v9 #51、K7）。
-- reminders：本人建立的提醒（事项、期限类型、期限日、提前几天几点、备注、通知谁、版本号与云端登记状态）。
-- reminder_inbox：到时的提醒（本机巡检放入或云端送来、核对签名后放入），按（编号, 版本）去重。
-- 两张表只在本机（不进共享文件夹同步：事项成员经云端通知服务收到，云端只见触发时刻、设备编号与密文）。
-- 事项删除时：提醒撤销并清空备注（交过云端的待云端删除），收到的提醒删除（matter-lifecycle purgeMatter）。

CREATE TABLE reminders (
  reminder_id   text PRIMARY KEY,
  tenant_id     text NOT NULL,
  matter_id     text NOT NULL REFERENCES matters(matter_id),
  created_by    text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('hearing','evidence','appeal','limitation','contract','filing','other')),
  due_date      text NOT NULL,
  remind_at     text NOT NULL,
  days_before   integer NOT NULL,
  remind_time   text NOT NULL,
  note          text NOT NULL DEFAULT '',
  audience      text NOT NULL CHECK (audience IN ('me','team')),
  version       integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cloud_state   text NOT NULL DEFAULT 'local' CHECK (cloud_state IN ('local','pending','synced','failed','cancel_pending','cancelled')),
  cloud_error   text,
  cloud_targets integer,
  created_at    text NOT NULL,
  updated_at    text NOT NULL
);
CREATE INDEX reminders_due_idx ON reminders (tenant_id, created_by, status, remind_at);
CREATE INDEX reminders_cloud_idx ON reminders (tenant_id, cloud_state);
CREATE INDEX reminders_matter_idx ON reminders (matter_id);

CREATE TABLE reminder_inbox (
  reminder_id text NOT NULL,
  version     integer NOT NULL,
  tenant_id   text NOT NULL,
  matter_id   text NOT NULL,
  kind        text NOT NULL,
  due_date    text NOT NULL,
  remind_at   text NOT NULL,
  note        text NOT NULL DEFAULT '',
  from_device text NOT NULL,
  from_member text NOT NULL,
  source      text NOT NULL CHECK (source IN ('local','cloud')),
  received_at text NOT NULL,
  read_at     text,
  PRIMARY KEY (reminder_id, version)
);
CREATE INDEX reminder_inbox_recv_idx ON reminder_inbox (tenant_id, received_at DESC);
CREATE INDEX reminder_inbox_matter_idx ON reminder_inbox (matter_id);
