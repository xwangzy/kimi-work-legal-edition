-- v9.4 第 22 批（评审 C1 §1 #20、#21、#22、#4、#29）：
--   matters.template_id：新建事项时选的事项类型（模板只在创建时预置阶段、待办与关键日期；之后律师随意改，模板不再管）；
--   matter_review_rules：本事项的审查要点（客户或本所的审查标准：条款、我方标准、可退让、不可谈），律师逐条写或改。
--     status：active 在用（每个事项至多一版）/ superseded 被新版取代 / retired 停用 / draft AI 从范本起草、律师还没审定（不能用于审查）；
--     version：在用与历史版本从 1 起编号；草稿没有版本号（律师审定启用时才编号）；source：lawyer 律师写或审定 / ai_draft AI 起草；
--     审合同的任务按发起时在用的那一版（快照进任务输入）判“偏离规则”，之后改要点不影响已发起的任务；
--   firm_doc_style.redline_author：Word 修订里显示的作者名（这台电脑设置；空 = 缺省“律师审定（Kimi Work 辅助起草）”）；
--   user_writing_prefs：我的写作偏好（只存格式与文风：落款、法条引用写法、其他说明；不存案情，保存时内核拦下像当事人名称、案号、金额的内容）。
-- kwl:managed-transaction
ALTER TABLE matters ADD COLUMN template_id text;
CREATE TABLE matter_review_rules (
  rule_set_id text PRIMARY KEY,
  tenant_id   text NOT NULL,
  matter_id   text NOT NULL REFERENCES matters(matter_id),
  version     integer,
  title       text NOT NULL,
  rules       text NOT NULL,
  sha256      text NOT NULL,
  status      text NOT NULL CHECK (status IN ('active','superseded','retired','draft')),
  source      text NOT NULL CHECK (source IN ('lawyer','ai_draft')),
  run_id      text,
  created_by  text NOT NULL,
  created_at  text NOT NULL,
  UNIQUE (matter_id, version)
);
CREATE INDEX matter_review_rules_matter_idx ON matter_review_rules (matter_id, status);
ALTER TABLE firm_doc_style ADD COLUMN redline_author text;
CREATE TABLE user_writing_prefs (
  tenant_id  text NOT NULL,
  user_id    text NOT NULL,
  prefs      text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
