-- v9.4 第 20 批 C-01 残余（评审 C1 §3.3“推为事实”）：已核的格子送进“事实”后记下事实行编号，不重复推送；
-- 律师撤回格子不撤事实（事实在事实标签里另行驳回）。
-- kwl:managed-transaction
ALTER TABLE review_cells ADD COLUMN fact_id text;
