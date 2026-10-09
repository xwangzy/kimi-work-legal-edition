-- 0002_keys_chain.sql — 密钥体系与签名事件 hash 链（方案 v5.0 第 4 篇 §5.2/§5.3/§6.3/§6.4）
-- 口径：根私钥与恢复托管私钥永不入库（只存公钥）；签名事件为追加式，业务行仍是权威投影；
-- approvals 增加设备签名列（设备签名签发 §6.3）；时间戳锚定本阶段不做。

BEGIN;

-- 律所身份：只存公钥（根公钥验设备证书；恢复托管公钥收事项密钥的恢复包裹）
CREATE TABLE firm_identity (
  tenant_id               text PRIMARY KEY REFERENCES tenants(tenant_id),
  root_public_key_pem     text NOT NULL,
  recovery_public_key_pem text NOT NULL,
  created_at              text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 成员设备证书（cert_json 为根私钥签发的完整证书；吊销在内核侧按密钥纪元处理）
CREATE TABLE devices (
  device_id          text PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants(tenant_id),
  member_id          text NOT NULL,
  role               text NOT NULL,
  sign_pub_pem       text NOT NULL,
  enc_pub_pem        text NOT NULL,
  cert_json          text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at         text,
  revoked_epoch      integer,
  key_epoch_at_issue integer NOT NULL DEFAULT 1,
  created_at         text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX devices_tenant_idx ON devices (tenant_id, status);

-- 事项密钥包裹：wrapped_for = device_id 或字面量 'recovery'（恢复托管公钥）
-- 旧纪元行保留：移出成员后旧内容对原持有者可读、新内容不可读（§5.3）
CREATE TABLE matter_keys (
  matter_id   text NOT NULL REFERENCES matters(matter_id),
  epoch       integer NOT NULL,
  wrapped_for text NOT NULL,
  wrapped_key text NOT NULL,
  created_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (matter_id, epoch, wrapped_for)
);

-- 密钥纪元（tenant 级随吊销递增；matter 级随成员移出递增）
CREATE TABLE key_epochs (
  scope      text NOT NULL CHECK (scope IN ('tenant','matter')),
  scope_id   text NOT NULL,
  epoch      integer NOT NULL,
  reason     text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, scope_id, epoch)
);

-- 签名事件 hash 链（§5.2 事件头最小化 + §6.4：每台主机一条链，内核每日对链头签名）
-- 业务行仍是权威投影；本表是对业务行的签名见证（payload_hash 重算可检测业务行被改）
CREATE TABLE signed_events (
  seq                 integer PRIMARY KEY AUTOINCREMENT,
  kind                text NOT NULL CHECK (kind IN ('run_event','audit_event','egress_record','approval')),
  ref_id              text NOT NULL,
  matter_id           text,
  type                text NOT NULL,
  payload_hash        text NOT NULL,
  lamport             integer NOT NULL,
  key_epoch           integer NOT NULL,
  rev_checkpoint_hash text NOT NULL DEFAULT '',
  prev_hash           text,
  event_hash          text NOT NULL,
  signature           text NOT NULL,
  signer_device_id    text NOT NULL,
  created_at          text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX signed_events_matter_idx ON signed_events (matter_id);
CREATE INDEX signed_events_ref_idx ON signed_events (kind, ref_id);

-- 链头检查点（§6.4：每日对链头签名；时间戳锚定后续阶段）
CREATE TABLE chain_checkpoints (
  checkpoint_id    text PRIMARY KEY,
  upto_seq         integer NOT NULL,
  head_hash        text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('daily','manual')),
  signer_device_id text NOT NULL,
  signature        text NOT NULL,
  created_at       text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 签发（§6.3）：设备签名绑定最终字节 hash；signed_payload 为 canonical JSON，签名即对其字节的 Ed25519 签名
ALTER TABLE approvals ADD COLUMN signer_device_id text;
ALTER TABLE approvals ADD COLUMN signature text;
ALTER TABLE approvals ADD COLUMN completeness_hash text;
ALTER TABLE approvals ADD COLUMN key_epoch integer;
ALTER TABLE approvals ADD COLUMN signed_payload text;

COMMIT;
