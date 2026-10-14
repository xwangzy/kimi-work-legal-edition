-- 0009_v9_run_states.sql — v9 第 04 篇 §8 任务状态机与 F1/F6 修复
--   F1：runs/attempts 终态枚举化（partial / timed_out / expired；created / validating / waiting_device / recovering）
--   F6：tool_operations 增加 outbox 语义（pending → succeeded/failed；结果不明 unknown → 人工对账）与幂等键、副作用类别
-- SQLite 不能 ALTER CHECK：按官方 12 步重建表。
-- 事务、外键开关、外键完整性检查（提交之前，有违例即回滚）与 schema_migrations 登记都由迁移器负责（复审 R-16），
-- 本文件只含建表与搬数据语句。迁移器按下面的标记识别：
-- kwl:managed-transaction

CREATE TABLE runs_new (
  run_id          text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(tenant_id),
  matter_id       text NOT NULL REFERENCES matters(matter_id),
  scenario        text NOT NULL,
  workflow_version text NOT NULL,
  status          text NOT NULL CHECK (status IN (
                    'created','validating','queued','running',
                    'waiting_input','waiting_approval','waiting_device','budget_paused','recovering','reconciling',
                    'succeeded','partial','failed','cancelled','expired','timed_out')),
  status_version  integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL,
  input_snapshot  text NOT NULL DEFAULT '{}',
  budget_points   integer NOT NULL DEFAULT 0,
  points_reserved integer NOT NULL DEFAULT 0,
  points_charged  integer NOT NULL DEFAULT 0,
  estimate_id     text,
  cancel_reason   text,
  created_by      text NOT NULL,
  created_at      text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  terminal_reason text,
  UNIQUE (tenant_id, idempotency_key)
);
INSERT INTO runs_new (run_id, tenant_id, matter_id, scenario, workflow_version, status, status_version, idempotency_key,
                      input_snapshot, budget_points, points_reserved, points_charged, estimate_id, cancel_reason,
                      created_by, created_at, updated_at)
  SELECT run_id, tenant_id, matter_id, scenario, workflow_version, status, status_version, idempotency_key,
         input_snapshot, budget_points, points_reserved, points_charged, estimate_id, cancel_reason,
         created_by, created_at, updated_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_matter_idx ON runs (matter_id, created_at DESC);
CREATE INDEX runs_status_idx ON runs (status);

CREATE TABLE attempts_new (
  attempt_id  text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES runs(run_id),
  seq         integer NOT NULL,
  status      text NOT NULL CHECK (status IN ('running','succeeded','partial','failed','cancelled','interrupted','timed_out','expired')),
  lease_owner text,
  lease_until text,
  fence_token integer NOT NULL,
  error       text,
  started_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at    text,
  UNIQUE (run_id, seq)
);
INSERT INTO attempts_new (attempt_id, run_id, seq, status, lease_owner, lease_until, fence_token, error, started_at, ended_at)
  SELECT attempt_id, run_id, seq, status, lease_owner, lease_until, fence_token, error, started_at, ended_at FROM attempts;
DROP TABLE attempts;
ALTER TABLE attempts_new RENAME TO attempts;

CREATE TABLE tool_operations_new (
  tool_operation_id text PRIMARY KEY,
  run_id     text NOT NULL REFERENCES runs(run_id),
  attempt_id text NOT NULL REFERENCES attempts(attempt_id),
  tool       text NOT NULL,
  operation  text NOT NULL,
  params_hash text NOT NULL,
  status     text NOT NULL CHECK (status IN ('requested','approved','rejected','pending','succeeded','failed','unknown')),
  result_uri text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  idempotency_key text,
  side_effect     text NOT NULL DEFAULT 'read' CHECK (side_effect IN ('read','write_draft','exec','network','external','irreversible')),
  result_hash     text,
  completed_at    text
);
INSERT INTO tool_operations_new (tool_operation_id, run_id, attempt_id, tool, operation, params_hash, status, result_uri, created_at)
  SELECT tool_operation_id, run_id, attempt_id, tool, operation, params_hash, status, result_uri, created_at FROM tool_operations;
DROP TABLE tool_operations;
ALTER TABLE tool_operations_new RENAME TO tool_operations;
CREATE INDEX tool_operations_run_idx ON tool_operations (run_id);
CREATE UNIQUE INDEX tool_operations_idem_idx ON tool_operations (run_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

