-- 0005_firm_node.sql — 所内节点（§5.1/§7.4）：节点执行队列与定时/批量任务
-- 硬门禁语义：仅 node_allowed=1 且非 strict/伦理墙事项可入 node_tasks；入队、同步、执行三处独立校验。
-- 租约（lease_owner/lease_until）防主备双跑（§7.4 语义 v0；IM 双活与飞书钉钉主备属 G1）。

BEGIN;

CREATE TABLE node_tasks (
  task_id       text PRIMARY KEY,
  tenant_id     text NOT NULL,
  matter_id     text NOT NULL REFERENCES matters(matter_id),
  scenario      text NOT NULL,
  input_json    text NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  lease_owner   text,
  lease_until   text,
  attempt_count integer NOT NULL DEFAULT 0,
  run_id        text,
  error         text,
  created_by    text NOT NULL,
  created_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at    text,
  ended_at      text,
  UNIQUE (tenant_id, task_id)
);
CREATE INDEX node_tasks_status_idx ON node_tasks (status, lease_until);

-- v0：cron_expr 以间隔秒替代 cron 表达式（cron 解析在 G1；如实注释于 API 与 README）
CREATE TABLE scheduled_jobs (
  job_id      text PRIMARY KEY,
  tenant_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('deadline_reminder','matter_weekly_report','lawdb_watch')),
  matter_id   text REFERENCES matters(matter_id),
  cron_expr   text NOT NULL DEFAULT '86400',
  params_json text NOT NULL DEFAULT '{}',
  enabled     integer NOT NULL DEFAULT 1,
  lease_owner text,
  lease_until text,
  last_run_at text,
  last_result text,
  created_by  text NOT NULL,
  created_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

COMMIT;
