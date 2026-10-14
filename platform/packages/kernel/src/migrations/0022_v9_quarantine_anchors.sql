-- 0022_v9_quarantine_anchors.sql — 第 3 批复核处置：材料隔离（B3-A05）与风险卡规范锚点（B3-B04 / B3-B14）
-- kwl:managed-transaction

-- 材料隔离（复核 B3-A05）：重新解析才发现国家秘密标志的材料——删除导入副本块、全部解析文本与派生内容（风险卡、事实行），
-- 登记行标为已隔离，不再能被选入任务、交给工具或预览；挂载原件在律师自己的文件夹里，本产品不删除，只解除引用。
ALTER TABLE document_versions ADD COLUMN quarantined_at text;
ALTER TABLE document_versions ADD COLUMN quarantine_reason text;

-- 风险卡锚点口径（复核 B3-B04 / B3-B14）：锚点改存文档视图里的规范原文（定位到的那一段），Agent 的原话另存 anchor_quote；
-- 新增锚点状态 cross_paragraph（引文跨段落：修订按段落写入，不能自动修订，须拆卡）。SQLite 不能改 CHECK，按表重建。
CREATE TABLE risk_cards_v2 (
  card_id       text PRIMARY KEY,
  tenant_id     text NOT NULL,
  matter_id     text NOT NULL REFERENCES matters(matter_id),
  run_id        text REFERENCES runs(run_id),
  document_version_id text REFERENCES document_versions(document_version_id),
  seq           integer NOT NULL,
  clause_ref    text,
  anchor_text   text NOT NULL,
  anchor_quote  text,
  anchor_start  integer,
  anchor_end    integer,
  anchor_status text NOT NULL CHECK (anchor_status IN ('located','ambiguous','not_found','no_document','cross_paragraph')),
  severity      text NOT NULL CHECK (severity IN ('high','mid','low')),
  category      text NOT NULL CHECK (category IN ('legal','commercial','both')),
  issue         text NOT NULL,
  basis         text NOT NULL DEFAULT '[]',
  suggestion    text,
  fallback      text,
  needs_client_decision integer NOT NULL DEFAULT 0 CHECK (needs_client_decision IN (0,1)),
  assumptions   text,
  status        text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','modified','rejected')),
  final_text    text,
  decided_by    text,
  decided_at    text,
  created_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO risk_cards_v2 (card_id, tenant_id, matter_id, run_id, document_version_id, seq, clause_ref, anchor_text, anchor_quote, anchor_start, anchor_end,
                           anchor_status, severity, category, issue, basis, suggestion, fallback, needs_client_decision, assumptions, status, final_text,
                           decided_by, decided_at, created_at)
  SELECT card_id, tenant_id, matter_id, run_id, document_version_id, seq, clause_ref, anchor_text, anchor_text, anchor_start, anchor_end,
         anchor_status, severity, category, issue, basis, suggestion, fallback, needs_client_decision, assumptions, status, final_text,
         decided_by, decided_at, created_at
    FROM risk_cards;
DROP TABLE risk_cards;
ALTER TABLE risk_cards_v2 RENAME TO risk_cards;
CREATE INDEX risk_cards_matter_idx ON risk_cards (matter_id, run_id, seq);
CREATE INDEX risk_cards_doc_idx ON risk_cards (document_version_id, status);
