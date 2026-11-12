-- 第 42 批：工具操作多记一列“状态摘要”（JSON，只有状态词、计数与布尔值，不含正文；见 src/tools/result-summary.ts）。
--   此前账本里工具调用只有成功 / 失败：回答不了“修改草稿有多少次锚点找不到”“交付前检查报了哪几类、几处”“表格整份重出了几次”，
--   每轮验收都靠人工读事件流去数。可空：旧行与没有可记内容的调用为 NULL。
ALTER TABLE tool_operations ADD COLUMN result_summary text;
