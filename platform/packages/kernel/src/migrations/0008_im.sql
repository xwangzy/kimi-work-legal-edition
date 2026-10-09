-- 0008_im.sql — IM 入口原型（方案 §11.2/§9）：发送人绑定、IM 意向、连接器租约；egress_records 重建以扩展 IM 目的地类别

BEGIN;

-- 发送人 ↔ 成员绑定（绑定操作只在本机/控制台；绑定时验证成员存在）
CREATE TABLE im_bindings (
  tenant_id  text NOT NULL,
  platform   text NOT NULL,
  im_user_id text NOT NULL,
  member_id  text NOT NULL,
  bound_by   text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, platform, im_user_id)
);

-- IM 意向（收文件后等待选择事项 / 审批请求等待节点处理；状态机见 im-runtime）
CREATE TABLE im_intents (
  intent_id  text PRIMARY KEY,
  tenant_id  text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('file_inbound','approval_request')),
  platform   text NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awaiting_choice','processing','done','rejected','expired')),
  payload    text NOT NULL DEFAULT '{}',
  result     text,
  created_by text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX im_intents_status_idx ON im_intents (status, kind);

-- 连接器选主租约（企业微信单连接语义；飞书/钉钉双活属 G1 声明）
CREATE TABLE im_connector_lease (
  platform   text PRIMARY KEY,
  owner      text NOT NULL,
  lease_until text NOT NULL,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- egress_records 重建：destination_kind 扩展 im_inbound / im_outbound（SQLite 不能 ALTER CHECK）
CREATE TABLE egress_records_new (
  record_id      text PRIMARY KEY,
  tenant_id      text NOT NULL,
  matter_id      text NOT NULL,
  run_id         text,
  attempt_id     text,
  destination_kind text NOT NULL CHECK (destination_kind IN ('maas_model','byok_model','private_model','moonshot_verify','law_source','timestamp','content_update','support_upload','mock_local','im_inbound','im_outbound')),
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
INSERT INTO egress_records_new SELECT * FROM egress_records;
DROP TABLE egress_records;
ALTER TABLE egress_records_new RENAME TO egress_records;
CREATE INDEX egress_records_run_idx ON egress_records (run_id);
CREATE INDEX egress_records_matter_idx ON egress_records (matter_id, created_at DESC);

COMMIT;
