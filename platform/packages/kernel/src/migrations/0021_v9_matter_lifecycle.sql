-- 0021_v9_matter_lifecycle.sql — 事项数据生命周期（用户 10-13 指令第 1 条“数据生命周期管理”；隐私安全审查 P1-1；v9 第 02 篇 §9.13）
--   active → closed（结案：不再发起任务、清理本机 Agent 数据，进入保留期）→ purged（到期删除或提前删除：密码学擦除 + 签名删除回执）；
--   法律保全（legal_hold）期间不得删除。删除只删内容，审计与签名事件链的元数据保留（可证明“做过什么”，不再含内容）。
-- kwl:managed-transaction

ALTER TABLE matters ADD COLUMN lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','closed','purged'));
ALTER TABLE matters ADD COLUMN closed_at text;
ALTER TABLE matters ADD COLUMN retention_until text;
ALTER TABLE matters ADD COLUMN legal_hold integer NOT NULL DEFAULT 0 CHECK (legal_hold IN (0,1));
ALTER TABLE matters ADD COLUMN legal_hold_reason text;
ALTER TABLE matters ADD COLUMN purged_at text;

CREATE TABLE deletion_receipts (
  receipt_id      text PRIMARY KEY,
  tenant_id       text NOT NULL,
  matter_id       text NOT NULL,
  created_by      text NOT NULL,
  signer_device_id text NOT NULL,
  receipt_json    text NOT NULL,
  signature       text NOT NULL,
  created_at      text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 删除时被清除内容的签名业务行（运行事件、去向记录）：签名事件链复核时这些行按“已按删除清单清除”报告而不判篡改；
-- 清单本身的摘要写进签名的 matter.purged 审计事件——清单被增删即判失败（ledger-signer.ts verifyChain）。
CREATE TABLE redacted_rows (
  kind        text NOT NULL CHECK (kind IN ('run_event','egress_record')),
  ref_id      text NOT NULL,
  matter_id   text NOT NULL,
  redacted_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (kind, ref_id)
);
CREATE INDEX redacted_rows_matter_idx ON redacted_rows (matter_id);
