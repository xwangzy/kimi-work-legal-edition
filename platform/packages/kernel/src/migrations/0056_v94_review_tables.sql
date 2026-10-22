-- v9.4 第 19 批 C-01（评审 C1 §3.3）：表格审阅最小版——行 = 材料，列 = 问题，格 = 带原文出处的答案 + 复核状态。
--   review_tables：模板（证据清单 / 合同尽调摘要 / 合同台账）、选用的列（JSON）、材料（JSON）；
--   review_cells：Agent 填的值与逐字引文（令牌形态）、引文定位结果、状态（ai / not_found / unreadable / conflict / verified / edited）、
--   律师改写的值（原文；原 AI 值保留可查）。律师已核、已改的格子重跑不覆盖。
-- kwl:managed-transaction
CREATE TABLE review_tables (
  table_id      text PRIMARY KEY,
  tenant_id     text NOT NULL,
  matter_id     text NOT NULL REFERENCES matters(matter_id),
  template      text NOT NULL CHECK (template IN ('evidence_list','dd_contract_summary','contract_ledger')),
  title         text NOT NULL,
  columns       text NOT NULL,
  document_version_ids text NOT NULL,
  created_by    text NOT NULL,
  created_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX review_tables_matter_idx ON review_tables (matter_id, created_at);

CREATE TABLE review_cells (
  cell_id       text PRIMARY KEY,
  table_id      text NOT NULL REFERENCES review_tables(table_id),
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  col_key       text NOT NULL,
  value         text,
  quote         text,
  anchor_status text,
  note          text,
  state         text NOT NULL CHECK (state IN ('ai','not_found','unreadable','conflict','verified','edited')),
  -- 助手最后一次填写时的状态（ai / conflict / not_found）：律师撤回时回到它，“有冲突”不丢（复核 Q2-09）
  ai_state      text CHECK (ai_state IS NULL OR ai_state IN ('ai','not_found','conflict')),
  lawyer_value  text,
  run_id        text REFERENCES runs(run_id),
  decided_by    text,
  decided_at    text,
  updated_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (table_id, document_version_id, col_key)
);
