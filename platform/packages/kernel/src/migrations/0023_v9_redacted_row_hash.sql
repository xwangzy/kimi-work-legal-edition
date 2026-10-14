-- 0023_v9_redacted_row_hash.sql — 第 3 批复核 C-A08：清除后的行仍保留元数据（运行编号、序号、类型；去向记录的目的地、时间、字数等），
-- 它们也须防篡改：删除时为每一行记下“清除后形态”的摘要，清单摘要（签名的 matter.purged 审计事件）把它包括在内，链复核逐行重算核对。
-- kwl:managed-transaction

ALTER TABLE redacted_rows ADD COLUMN row_hash text;
