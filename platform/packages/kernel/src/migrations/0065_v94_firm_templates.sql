-- v9.4 第 24 批（评审 C1 §1 #23；10-23 拍板：做“本所范本库”，只收律师主动放入、去除客户信息的范本，不自动取已签发件）：
--   firm_templates：一份范本（名称、合同类型、适用立场、说明、原文件名、条款摘要）；按律所存在这台电脑，不同步、不上云、不发给 AI；
--   firm_template_clauses：按条拆开的正文（seq 0 为首部，不参与审合同时的条款匹配）。
--   放入时内核逐条查像客户信息的写法（本人事项当事人含简称别名、案号、证件号、手机号、银行账号、邮箱），查到的不放或换成【】占位符。
-- kwl:managed-transaction
CREATE TABLE firm_templates (
  template_id   text PRIMARY KEY,
  tenant_id     text NOT NULL,
  title         text NOT NULL,
  contract_type text NOT NULL,
  stance        text,
  note          text,
  source_name   text,
  sha256        text NOT NULL,
  created_by    text NOT NULL,
  created_at    text NOT NULL
);
CREATE INDEX firm_templates_tenant_idx ON firm_templates (tenant_id, contract_type);
CREATE TABLE firm_template_clauses (
  template_id text NOT NULL REFERENCES firm_templates(template_id),
  seq         integer NOT NULL,
  heading     text NOT NULL,
  text        text NOT NULL,
  PRIMARY KEY (template_id, seq)
);
