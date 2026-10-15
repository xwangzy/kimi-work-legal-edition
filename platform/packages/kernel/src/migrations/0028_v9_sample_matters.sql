-- 0028_v9_sample_matters.sql — v9.2 §4.4（Y4 §5 D-6、#24；v9 第 03 篇 §5 第 3 步“示例事项”）：
-- 首次使用时放入一件虚构的示例事项（合成合同 + 三张示例风险卡，不发任何请求），律师可在审查工作台试用；可一键移除（走删除流程，留墓碑行防止再次自动放入）。
-- kwl:managed-transaction

CREATE TABLE sample_matters (
  matter_id text PRIMARY KEY,
  installed_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at text
);
