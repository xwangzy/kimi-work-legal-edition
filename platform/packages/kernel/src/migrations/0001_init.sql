-- 0001_init.sql — 事项账本（方案 v5.0 第 4 篇 §5；由 v4.0 PostgreSQL 迁移脚本改写）
-- SQLite 方言：JSON 以 TEXT 存（边界处序列化）；时间一律 UTC ISO 字符串；内容版本不可变；ID 带前缀。

BEGIN;

CREATE TABLE tenants (
  tenant_id   text PRIMARY KEY,
  name        text NOT NULL,
  created_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE users (
  user_id      text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(tenant_id),
  display_name text NOT NULL,
  created_at   text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 约束：管理员角色不自动获得案卷正文权限（v5：由事项密钥分发实现，密钥体系 G0 第 3–4 周接入）
CREATE TABLE memberships (
  membership_id text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(tenant_id),
  user_id       text NOT NULL REFERENCES users(user_id),
  role          text NOT NULL CHECK (role IN ('firm_admin','knowledge_admin','partner','lawyer','paralegal','it','finance')),
  authz_version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE seats (
  seat_id    text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES tenants(tenant_id),
  user_id    text NOT NULL REFERENCES users(user_id),
  kind       text NOT NULL CHECK (kind IN ('production','review_issuer','admin')),
  valid_from text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  valid_to   text,
  UNIQUE (tenant_id, user_id, kind)
);

-- 事项：v5 以「模型端点 × 协作范围」取代 v4 的 processing_mode；当事人告知同意含「待取得」
CREATE TABLE matters (
  matter_id       text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(tenant_id),
  title           text NOT NULL,
  client_name     text,
  counterparty    text,
  stance          text NOT NULL,
  jurisdiction    text NOT NULL DEFAULT '内地民商事',
  key_dates       text NOT NULL DEFAULT '{}',
  confidentiality text NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal','high','strict')),
  model_endpoint  text NOT NULL DEFAULT 'standard' CHECK (model_endpoint IN ('standard','byok','private','none')),
  collab_scope    text NOT NULL DEFAULT 'personal' CHECK (collab_scope IN ('personal','team')),
  consent_status  text NOT NULL DEFAULT 'pending' CHECK (consent_status IN ('agreed','pending','refused','not_required')),
  policy_version  integer NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by      text NOT NULL REFERENCES users(user_id),
  created_at      text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX matters_tenant_idx ON matters (tenant_id, status);

CREATE TABLE matter_members (
  matter_id   text NOT NULL REFERENCES matters(matter_id),
  user_id     text NOT NULL REFERENCES users(user_id),
  matter_role text NOT NULL CHECK (matter_role IN ('owner','editor','reviewer','issuer','viewer')),
  added_by    text NOT NULL,
  added_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (matter_id, user_id)
);

-- 原件不可变版本；纠错建新版本（supersedes 链）。storage_mode：挂载（只读引用）/ 导入（内容寻址块）
CREATE TABLE document_versions (
  document_version_id text PRIMARY KEY,
  matter_id  text NOT NULL REFERENCES matters(matter_id),
  tenant_id  text NOT NULL REFERENCES tenants(tenant_id),
  filename   text NOT NULL,
  sha256     text NOT NULL,
  size_bytes integer NOT NULL,
  mime       text NOT NULL,
  storage_mode text NOT NULL CHECK (storage_mode IN ('mount','import')),
  storage_uri  text NOT NULL,
  supersedes   text REFERENCES document_versions(document_version_id),
  uploaded_by  text NOT NULL,
  created_at   text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX document_versions_matter_idx ON document_versions (matter_id);
CREATE INDEX document_versions_hash_idx ON document_versions (tenant_id, sha256);

CREATE TABLE parse_versions (
  parse_version_id text PRIMARY KEY,
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  parser         text NOT NULL,
  parser_version text NOT NULL,
  page_count     integer,
  quality_flags  text NOT NULL DEFAULT '[]',
  text_uri       text NOT NULL,
  created_at     text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX parse_versions_doc_idx ON parse_versions (document_version_id);

-- v0 解析文本存储（生产为内容寻址 text_uri；v0 以表代储，接口不变）
CREATE TABLE parse_texts (
  parse_version_id text PRIMARY KEY REFERENCES parse_versions(parse_version_id),
  content text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE evidence_anchors (
  anchor_id        text PRIMARY KEY,
  parse_version_id text NOT NULL REFERENCES parse_versions(parse_version_id),
  page             integer,
  paragraph        text,
  char_start       integer NOT NULL,
  char_end         integer NOT NULL,
  text_hash        text NOT NULL
);
CREATE INDEX evidence_anchors_parse_idx ON evidence_anchors (parse_version_id);

-- 任务 / 尝试 / 事件账本
CREATE TABLE runs (
  run_id          text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(tenant_id),
  matter_id       text NOT NULL REFERENCES matters(matter_id),
  scenario        text NOT NULL,
  workflow_version text NOT NULL,
  status          text NOT NULL CHECK (status IN ('queued','running','waiting_input','waiting_approval','budget_paused','succeeded','failed','cancelled','reconciling')),
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
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX runs_matter_idx ON runs (matter_id, created_at DESC);
CREATE INDEX runs_status_idx ON runs (status);

CREATE TABLE attempts (
  attempt_id  text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES runs(run_id),
  seq         integer NOT NULL,
  status      text NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','interrupted')),
  lease_owner text,
  lease_until text,
  fence_token integer NOT NULL,
  error       text,
  started_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at    text,
  UNIQUE (run_id, seq)
);

-- 追加式事件账本：先落账本再推界面；cursor = event_id
-- prev_hash/event_hash 两列为早期预留，未启用：签名 hash 链以 0002 的 signed_events 见证表为准
CREATE TABLE run_events (
  event_id   integer PRIMARY KEY AUTOINCREMENT,
  run_id     text NOT NULL REFERENCES runs(run_id),
  attempt_id text,
  seq        integer NOT NULL,
  type       text NOT NULL,
  payload    text NOT NULL DEFAULT '{}',
  prev_hash  text,
  event_hash text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (run_id, seq)
);
CREATE INDEX run_events_cursor_idx ON run_events (run_id, event_id);

-- 本地持久任务队列的步骤检查点（§6.1：每步完成即落库；重启后从最后检查点继续）
CREATE TABLE step_checkpoints (
  run_id     text NOT NULL REFERENCES runs(run_id),
  step_name  text NOT NULL,
  attempt_id text NOT NULL,
  result_json text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, step_name)
);

CREATE TABLE tool_operations (
  tool_operation_id text PRIMARY KEY,
  run_id     text NOT NULL REFERENCES runs(run_id),
  attempt_id text NOT NULL REFERENCES attempts(attempt_id),
  tool       text NOT NULL,
  operation  text NOT NULL,
  params_hash text NOT NULL,
  status     text NOT NULL CHECK (status IN ('requested','approved','rejected','succeeded','failed')),
  result_uri text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX tool_operations_run_idx ON tool_operations (run_id);

-- 成果与签发：签发绑定最终字节 hash
CREATE TABLE artifact_versions (
  artifact_version_id text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES tenants(tenant_id),
  matter_id  text NOT NULL REFERENCES matters(matter_id),
  run_id     text REFERENCES runs(run_id),
  kind       text NOT NULL,
  version    integer NOT NULL,
  baseline_id text REFERENCES artifact_versions(artifact_version_id),
  audience   text NOT NULL CHECK (audience IN ('internal','client','counterparty','court')),
  status     text NOT NULL CHECK (status IN ('draft','pending_verification','pending_review','approved','issued','blocked','superseded','withdrawn')),
  filename   text NOT NULL,
  sha256     text NOT NULL,
  storage_uri text NOT NULL,
  open_items text NOT NULL DEFAULT '[]',
  manifest   text NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (matter_id, kind, audience, version)
);

-- v0 成果内容存储（生产为内容寻址块；签发绑定最终字节 hash 不变）
CREATE TABLE artifact_payloads (
  artifact_version_id text PRIMARY KEY REFERENCES artifact_versions(artifact_version_id),
  content text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE approvals (
  approval_id         text PRIMARY KEY,
  artifact_version_id text NOT NULL REFERENCES artifact_versions(artifact_version_id),
  artifact_sha256     text NOT NULL,
  approver_id         text NOT NULL,
  decision            text NOT NULL CHECK (decision IN ('approved','rejected')),
  audience            text,
  assurance_level     text NOT NULL DEFAULT 'approval_record',
  checklist           text NOT NULL DEFAULT '{}',
  valid_until         text,
  created_at          text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX approvals_artifact_idx ON approvals (artifact_version_id);

-- 交付与签发记录（§2.5：下载、外发与客户接受分别记录；不可变交付包）
CREATE TABLE deliveries (
  delivery_id         text PRIMARY KEY,
  artifact_version_id text NOT NULL REFERENCES artifact_versions(artifact_version_id),
  tenant_id  text NOT NULL,
  matter_id  text NOT NULL,
  audience   text NOT NULL CHECK (audience IN ('internal','client','counterparty','court')),
  package_sha256 text NOT NULL,
  action     text NOT NULL CHECK (action IN ('download','external_send','archive')),
  approval_id text REFERENCES approvals(approval_id),
  actor_id   text NOT NULL,
  note       text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX deliveries_matter_idx ON deliveries (matter_id, created_at DESC);

-- 计量：token 分类归集；客户端幂等 ID 供「结果不明先对账」；失败退点不抹掉真实成本
CREATE TABLE usage_records (
  usage_id       text PRIMARY KEY,
  request_id     text NOT NULL,
  tenant_id      text NOT NULL,
  user_id        text,
  matter_id      text,
  run_id         text,
  attempt_id     text,
  route          text NOT NULL,
  provider_model text NOT NULL,
  tokens_uncached_input integer NOT NULL DEFAULT 0,
  tokens_cached_input   integer NOT NULL DEFAULT 0,
  tokens_cache_write    integer NOT NULL DEFAULT 0,
  tokens_output         integer NOT NULL DEFAULT 0,
  tokens_reasoning      integer NOT NULL DEFAULT 0,
  tool_calls     integer NOT NULL DEFAULT 0,
  cost_microcny  integer,
  client_idempotency_id text,
  latency_ms     integer,
  created_at     text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, request_id)
);
CREATE INDEX usage_records_matter_idx ON usage_records (matter_id, created_at DESC);

-- 数据去向记录（§8.3：每一次外发都记入；IM 收发与云盘同步记录在第 5–6 周写入同一张表）
-- 签名信封口径：request_id（broker 回填）/ outcome / note（markFailed 改写）为生命周期列，
-- 在签名信封之外；其余列（目的地、归属、字符数、化名统计等）插入后不可变，在信封内。
CREATE TABLE egress_records (
  record_id      text PRIMARY KEY,
  tenant_id      text NOT NULL,
  matter_id      text NOT NULL,
  run_id         text,
  attempt_id     text,
  destination_kind text NOT NULL CHECK (destination_kind IN ('maas_model','byok_model','private_model','moonshot_verify','law_source','timestamp','content_update','support_upload','mock_local')),
  destination_host text NOT NULL,
  request_id     text,
  client_idempotency_id text,
  chars          integer NOT NULL DEFAULT 0,
  segments       integer NOT NULL DEFAULT 0,
  pseudonym_findings integer NOT NULL DEFAULT 0,
  pseudonym_counts text NOT NULL DEFAULT '{}',
  doc_refs       text NOT NULL DEFAULT '[]',
  note           text,
  outcome        text NOT NULL DEFAULT 'sent' CHECK (outcome IN ('sent','blocked','failed','mock')),
  created_at     text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX egress_records_run_idx ON egress_records (run_id);
CREATE INDEX egress_records_matter_idx ON egress_records (matter_id, created_at DESC);

-- 审计：追加事件；普通日志不存案卷正文
CREATE TABLE audit_events (
  audit_event_id integer PRIMARY KEY AUTOINCREMENT,
  tenant_id  text NOT NULL,
  actor_id   text NOT NULL,
  action     text NOT NULL,
  object_kind text NOT NULL,
  object_id  text NOT NULL,
  policy_version integer,
  detail_hash text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_events_object_idx ON audit_events (object_kind, object_id, created_at DESC);

COMMIT;
