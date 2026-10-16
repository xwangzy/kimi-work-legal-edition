-- 0039_v9_share_relay_round4.sql — 第 11 批第四轮复核处置。
-- kwl:managed-transaction（多条 ALTER 在同一事务里）
-- matter_members 增列 author_sig / author_cert：成员行由作者设备逐行签名（签名 + 作者设备证书），同事转发的成员行也能核验作者
--   （复核 S11A-35、S11B-35：共同负责人、移交后的新负责人、负责人第二台设备加入的成员原先认不出负责人）。存量行为空，按原规则（作者 = 段签名设备）。
-- relay_matters 增列 gen（中继告知的“重置代数”，变大即按运营重置处理，复核 S11B-36/37）、resend_full（重置后本机写入的行全量重发，复核 S11A-36）。
-- relay_imported：清掉“总是附带的行”的记录（第二轮按摘要记下的旧记录会挡住这些行，复核 S11B-39②）。

ALTER TABLE matter_members ADD COLUMN author_sig text;
ALTER TABLE matter_members ADD COLUMN author_cert text;
ALTER TABLE relay_matters ADD COLUMN gen integer NOT NULL DEFAULT 0;
ALTER TABLE relay_matters ADD COLUMN resend_full integer NOT NULL DEFAULT 0;
DELETE FROM relay_imported WHERE t IN ('users', 'matters', 'devices', 'im_bindings', 'matter_members');
