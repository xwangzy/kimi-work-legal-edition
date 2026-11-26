-- 第 70 批（V44）：去向记录按请求编号查的索引。
-- 1) “设置 · 套餐与用量”的最近记录：云端明细带回出站闸门生成的请求编号（kwlg_…），内核在本机按编号对回“哪件事项的哪个任务”（事项名只在本机显示）；
-- 2) 闸门结束阶段按请求编号补全预写记录（原来每次都全表扫描）。
CREATE INDEX IF NOT EXISTS egress_records_request_idx ON egress_records (request_id);
