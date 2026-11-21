-- 第 51 批：客户授权依据逐案留痕（D-216）。
--   合规核验：律师点确认不等于客户授权；授权依据是“每一份委托合同”（或客户单独的书面同意），不是律师个人的一次声明。
--   改为每个事项第一次用 AI 时由律师逐案记录“依据类型 + 出处”；设置里的开关降为“预填常用条款出处”，不再替新事项自动记录。
--
--   matters.basis_source 取值扩为：
--     engagement_terms  委托合同中的 AI 条款（须写明出处：合同名称或编号、条款号；律师开了开关且存了常用出处时可预填）；
--     separate_consent  客户单独书面同意（须写明出处：日期与方式）；
--     confirmed         第 48 批旧值（律师确认 / 逐项记录），继续接受以兼容；
--     NULL              逐项编辑、当事人拒绝，或此前的事项。
--   matters.basis_ref             授权依据出处（至多 200 字），如“委托代理合同（2026）沪律字第 123 号 第 9 条，2026-03-02 签订”；
--   matters.basis_notice_version  记录时告知客户的 AI 次处理者清单版本（AI_SUBPROCESSORS.version）；
--                                 与当前版本不同即须重新确认（模型推理拦下）；为空的旧事项不拦。
--   两列与 basis_source 同口径：随团队事项同步（加密的同步段），来源清为 NULL 的一切路径同时清空。
--   user_ai_authorization.default_ref  律师常用的委托合同 AI 条款出处（只用于预填；只在本机、不同步、不上云）。
--   user_ai_notice  律师本人看过“首次使用 AI 数据去向告知”的版本与时间（只在本机、按律师本人，不同步、不上云）。
ALTER TABLE matters ADD COLUMN basis_ref text;
ALTER TABLE matters ADD COLUMN basis_notice_version text;
ALTER TABLE user_ai_authorization ADD COLUMN default_ref text;
CREATE TABLE user_ai_notice (
  tenant_id text NOT NULL,
  user_id   text NOT NULL,
  version   text NOT NULL,
  acked_at  text NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
