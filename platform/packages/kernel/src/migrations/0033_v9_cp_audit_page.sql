-- 0033_v9_cp_audit_page.sql — 第 9 批复核 S9A-12：最后一次取到最新运营审计流水时那一页的控制面签名信封（导出时附上，
-- 收件人可用控制面公钥核对“截至云端序号 N”）。cp_documents 的 kind 有 CHECK 约束，单列一表。只在本机，不进同步。

CREATE TABLE cp_audit_signed_page (
  tenant_id text PRIMARY KEY,
  envelope_json text NOT NULL,
  fetched_at text NOT NULL
);

-- 运营审计记录的数值明细（复核 S9A-09，进哈希）：本机留存须原样保存，否则导出后收件人验链不过
ALTER TABLE cp_audit_records ADD COLUMN detail_json text;
