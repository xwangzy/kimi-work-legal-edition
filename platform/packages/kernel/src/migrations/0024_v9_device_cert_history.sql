-- 0024_v9_device_cert_history.sql — 第 4 批复核 B4-A11/A12：同一设备编号下被替换的证书留档。
-- device.json 丢失后重开，本机会换新密钥并以同一编号重签证书；之后导入恢复文件又换回原密钥。两次替换之间签出的见证行、
-- 成果审批与删除回执都要能继续验签：验签按“当前证书 → 留档证书”依次尝试，每张都须由律所根签发、设备编号一致（伪造不出）。
-- kwl:managed-transaction

CREATE TABLE device_cert_history (
  device_id     text NOT NULL,
  cert_id       text NOT NULL,
  cert_json     text NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('rekeyed','recovered')),
  superseded_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (device_id, cert_id)
);
