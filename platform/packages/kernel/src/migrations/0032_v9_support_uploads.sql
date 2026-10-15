-- 0032_v9_support_uploads.sql — 第 9 批复核 S9B-02：诊断包上传的本机记录。
-- 诊断包上传不属于任何事项，不进按事项组织的出站账本（egress_records 的 matter_id 非空、对账界面按事项列出）；
-- 改为本表：发送前写 pending（文件摘要与字节数），完成后改 sent / failed；内核启动时仍为 pending 的（发送途中内核退出）记 unknown，
-- 由律师在“本机与安全”里看到“结果不明”。只在本机，不进同步；内容只有摘要、字节数、工单号与结果代码。

CREATE TABLE support_uploads (
  upload_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  file_sha256 text NOT NULL,
  bytes integer NOT NULL,
  ticket text,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'unknown')),
  error_code text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX support_uploads_created_idx ON support_uploads (tenant_id, created_at DESC);
