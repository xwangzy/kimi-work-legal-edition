-- 0025_v9_cert_history_bound.sql — 第 4 批复核 B4-R10：留档证书的有效上界。
-- 留档时记下当时签名事件链的最大序号；验签时留档证书只对不晚于该序号的见证行、检查点、审批与删除回执有效——
-- 被替换下来的旧私钥即使泄露，也签不出被判为有效的新见证。
-- kwl:managed-transaction

ALTER TABLE device_cert_history ADD COLUMN superseded_seq integer NOT NULL DEFAULT 0;
