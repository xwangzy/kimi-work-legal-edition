-- v9.4 第 19 批 C-04（评审 C1 §1、§4；CoCounsel Brief Builder）：文书类任务起草前，Agent 先提交“论点与依据”提纲，
-- 律师逐条确认（留 / 删 / 改写论点、去掉不用的依据）后才起草；提纲未确认时本任务不能生成文书（docx.render_report 拒绝）。
--   items：Agent 提交的论点（令牌形态），每条 {arg_id, claim, basis[{law, article, note, check, matched, article_text}], facts[{fact_id?, statement, confirmed}], counter}；
--   article_text 为法规库里的条文原文（公开法律文本，库外为空），律师据此当场比对“这条撑不撑得住这句话”；
--   decisions：律师的逐条决定 {arg_id, keep, claim?（律师改写的论点，原文）, basis_keep[]}；status：proposed 待确认 / confirmed 已确认 / withdrawn 被同任务新提纲取代。
-- kwl:managed-transaction
CREATE TABLE argument_outlines (
  outline_id   text PRIMARY KEY,
  tenant_id    text NOT NULL,
  matter_id    text NOT NULL REFERENCES matters(matter_id),
  run_id       text REFERENCES runs(run_id),
  seq          integer NOT NULL,
  doc_kind     text NOT NULL,
  title        text,
  items        text NOT NULL,
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','withdrawn')),
  decisions    text,
  lawyer_note  text,
  decided_by   text,
  decided_at   text,
  created_at   text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX argument_outlines_run_idx ON argument_outlines (matter_id, run_id, seq);
