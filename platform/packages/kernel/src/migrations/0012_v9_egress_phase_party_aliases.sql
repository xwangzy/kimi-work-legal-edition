-- 0012_v9_egress_phase_party_aliases.sql — 阶段 4 复核 S4-20、S4-21
--   1) egress_records：两阶段记录的完成标记（预写为 0，补全为 1）；结果新增 'unknown'（预写后闸门或内核中断、未补全的记录在闸门重拉时标为结果不明，进入人工对账）；
--      content_digest = 出站内容关键事实（检索原文与发出的查询、URL、裁决、载荷摘要、模型）的摘要，预写时计入签名信封——签名链能证明“发出了什么”，
--      补全另追加一条签名审计事件，不改写信封内的事实；
--   2) matter_parties：学得的别名（待律师确认，仍参与匹配）与律师停用的别名（停用的自动派生字号、驳回的学得别名，此后不再学回）。
-- SQLite 不能 ALTER CHECK：egress_records 按官方步骤重建。事务与外键检查由迁移器负责。
-- kwl:managed-transaction

CREATE TABLE egress_records_new (
  record_id      text PRIMARY KEY,
  tenant_id      text NOT NULL,
  matter_id      text NOT NULL,
  run_id         text,
  attempt_id     text,
  destination_kind text NOT NULL CHECK (destination_kind IN (
                   'maas_model','byok_model','private_model','moonshot_verify','law_source','timestamp','content_update',
                   'support_upload','mock_local','im_inbound','im_outbound',
                   'legal_gateway','search_service','public_web','gate_blocked')),
  destination_host text NOT NULL,
  request_id     text,
  client_idempotency_id text,
  chars          integer NOT NULL DEFAULT 0,
  segments       integer NOT NULL DEFAULT 0,
  pseudonym_findings integer NOT NULL DEFAULT 0,
  pseudonym_counts text NOT NULL DEFAULT '{}',
  doc_refs       text NOT NULL DEFAULT '[]',
  note           text,
  outcome        text NOT NULL DEFAULT 'sent' CHECK (outcome IN ('sent','blocked','failed','mock','unknown')),
  created_at     text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed      integer NOT NULL DEFAULT 1 CHECK (completed IN (0,1)),
  content_digest text
);
INSERT INTO egress_records_new
  (record_id, tenant_id, matter_id, run_id, attempt_id, destination_kind, destination_host, request_id, client_idempotency_id,
   chars, segments, pseudonym_findings, pseudonym_counts, doc_refs, note, outcome, created_at, completed, content_digest)
  SELECT record_id, tenant_id, matter_id, run_id, attempt_id, destination_kind, destination_host, request_id, client_idempotency_id,
         chars, segments, pseudonym_findings, pseudonym_counts, doc_refs, note, outcome, created_at, 1, NULL
    FROM egress_records;
DROP TABLE egress_records;
ALTER TABLE egress_records_new RENAME TO egress_records;
CREATE INDEX egress_records_run_idx ON egress_records (run_id);
CREATE INDEX egress_records_matter_idx ON egress_records (matter_id, created_at DESC);
CREATE INDEX egress_records_open_idx ON egress_records (completed) WHERE completed = 0;

ALTER TABLE matter_parties ADD COLUMN learned_aliases text NOT NULL DEFAULT '[]';
ALTER TABLE matter_parties ADD COLUMN excluded_aliases text NOT NULL DEFAULT '[]';
