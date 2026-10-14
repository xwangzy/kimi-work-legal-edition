-- 0019_v9_review_cards_facts.sql — 结构化产出（2026-10-13 审计 D2 / UIUX P0-3；v9 第 03 篇 §6.1 风险卡、§6.2 四类事实）
--   Agent 通过法律工具提交（riskcards.submit / facts.submit），内核核对锚点（原文在材料中能否定位）后落盘；
--   律师在审查工作台逐张“接受 / 修改后接受 / 不采纳”，只有接受与修改后的卡写进修订稿；事实行只有律师确认后才可被文书与汇报引用。
--   文字字段按 Agent 提交时的令牌形态保存（第 02 篇 §8.4：令牌只在界面渲染与文书导出时还原）；律师在界面上改写的文本为原文（final_text）。
-- kwl:managed-transaction

CREATE TABLE risk_cards (
  card_id       text PRIMARY KEY,
  tenant_id     text NOT NULL,
  matter_id     text NOT NULL REFERENCES matters(matter_id),
  run_id        text REFERENCES runs(run_id),
  document_version_id text REFERENCES document_versions(document_version_id),
  seq           integer NOT NULL,
  clause_ref    text,
  anchor_text   text NOT NULL,
  anchor_start  integer,
  anchor_end    integer,
  anchor_status text NOT NULL CHECK (anchor_status IN ('located','ambiguous','not_found','no_document')),
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
CREATE INDEX risk_cards_matter_idx ON risk_cards (matter_id, run_id, seq);
CREATE INDEX risk_cards_doc_idx ON risk_cards (document_version_id, status);

CREATE TABLE matter_facts (
  fact_id       text PRIMARY KEY,
  tenant_id     text NOT NULL,
  matter_id     text NOT NULL REFERENCES matters(matter_id),
  run_id        text REFERENCES runs(run_id),
  seq           integer NOT NULL,
  statement     text NOT NULL,
  -- 材料声称 / 推论 / 待确认（Agent 只能提交这三类）；律师确认后为 confirmed
  kind          text NOT NULL CHECK (kind IN ('claimed','inferred','to_confirm','confirmed')),
  occurred_on   text,
  amount_yuan   real,
  party         text,
  document_version_id text REFERENCES document_versions(document_version_id),
  quote         text,
  anchor_start  integer,
  anchor_end    integer,
  anchor_status text NOT NULL CHECK (anchor_status IN ('located','ambiguous','not_found','no_document')),
  status        text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected')),
  decided_by    text,
  decided_at    text,
  created_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX matter_facts_matter_idx ON matter_facts (matter_id, occurred_on, seq);
