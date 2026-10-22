-- v9.4 第 21 批（复核 Q3-09）：工作台“批量接受”的批次号记在卡上——“撤回本批”只撤这一批里、仍是批量接受状态的卡；
-- 批量接受后律师又单独处理过的卡（改了级别、改写、撤回）批次号清空，不再随本批撤回。
-- kwl:managed-transaction
ALTER TABLE risk_cards ADD COLUMN decided_batch text;
