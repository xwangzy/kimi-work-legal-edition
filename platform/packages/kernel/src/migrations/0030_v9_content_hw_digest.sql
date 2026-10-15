-- 0030_v9_content_hw_digest.sql — 第 8 批复核 S8A-04：“先后只认 seq”要求同一通道同一 seq 只对应一份内容。
-- 见过的最高通道 seq 同时记下该 seq 的内容摘要；之后同 seq 给出不同摘要的签名清单一律拒绝并审计。

ALTER TABLE content_channel_hw ADD COLUMN content_sha256 text;
