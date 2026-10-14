-- 0010_v9_egress_gate.sql — v9 阶段 4：出站闸门（第 04 篇 §5.1、§8 EgressRecord）与令牌化工作区（第 02 篇 §8.3–§8.4）
--   1) egress_records 目的地类别扩展：法律模型网关 / 检索服务 / 公开网站（闸门本机抓取）/ 闸门拦截（未外发）；
--   2) 事项令牌密钥与事项令牌表（代号 ↔ 原文，只在律所侧；界面渲染与文书引擎导出时还原）；
--   3) 当事人词典（事项头之外的当事人、关联方与别名；L3a 事项须人工核对）；
--   4) 租户盐（匿名事项编号）；
--   5) 事项“全部化名”开关（L3a 强制；L2 可由事项负责人开启）。
-- SQLite 不能 ALTER CHECK：egress_records 按官方步骤重建。事务与外键检查由迁移器负责（复审 R-16）。
-- kwl:managed-transaction

CREATE TABLE egress_records_new (
  record_id      text PRIMARY KEY,
  tenant_id      text NOT NULL,
  matter_id      text NOT NULL,
  run_id         text,
  attempt_id     text,
  destination_kind text NOT NULL CHECK (destination_kind IN (
                   'maas_model','byok_model','private_model','moonshot_verify','law_source','timestamp','content_update',
                   'support_upload','mock_local','im_inbound','im_outbound',
                   'legal_gateway','search_service','public_web','gate_blocked')),
  destination_host text NOT NULL,
  request_id     text,
  client_idempotency_id text,
  chars          integer NOT NULL DEFAULT 0,
  segments       integer NOT NULL DEFAULT 0,
  pseudonym_findings integer NOT NULL DEFAULT 0,
  pseudonym_counts text NOT NULL DEFAULT '{}',
  doc_refs       text NOT NULL DEFAULT '[]',
  note           text,
  outcome        text NOT NULL DEFAULT 'sent' CHECK (outcome IN ('sent','blocked','failed','mock')),
  created_at     text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO egress_records_new SELECT * FROM egress_records;
DROP TABLE egress_records;
ALTER TABLE egress_records_new RENAME TO egress_records;
CREATE INDEX egress_records_run_idx ON egress_records (run_id);
CREATE INDEX egress_records_matter_idx ON egress_records (matter_id, created_at DESC);

-- 事项令牌密钥：每事项 32 字节随机（账本页级加密保存；G1 随事项密钥经端到端加密共享给成员设备，保证跨设备代号一致）
CREATE TABLE matter_token_keys (
  matter_id  text PRIMARY KEY REFERENCES matters(matter_id),
  tenant_id  text NOT NULL,
  key_b64    text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 事项令牌表：代号 → 首次出现的原文写法（还原只给可信界面与文书引擎）；只增不改，seq 即令牌表版本
CREATE TABLE matter_tokens (
  seq        integer PRIMARY KEY AUTOINCREMENT,
  matter_id  text NOT NULL REFERENCES matters(matter_id),
  token      text NOT NULL,
  category   text NOT NULL CHECK (category IN ('person','org','id_number','phone','account','uscc','address','plate','email')),
  value      text NOT NULL,
  normalized text NOT NULL,
  source     text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (matter_id, token),
  UNIQUE (matter_id, category, normalized)
);

-- 当事人词典：事项头（委托人、相对方）之外的当事人、关联方、证人与别名；自然人默认令牌化，机构只在全部化名时令牌化
CREATE TABLE matter_parties (
  matter_id  text NOT NULL REFERENCES matters(matter_id),
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('person','org')),
  aliases    text NOT NULL DEFAULT '[]',
  role       text,
  added_by   text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (matter_id, name)
);

-- 租户盐（匿名事项编号：HMAC(盐, 租户‖事项)，供模型网关二次检查；不能还原事项；检索调用不携带）
CREATE TABLE tenant_salts (
  tenant_id  text NOT NULL,
  purpose    text NOT NULL,
  salt_b64   text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, purpose)
);

ALTER TABLE matters ADD COLUMN full_pseudonym integer NOT NULL DEFAULT 0 CHECK (full_pseudonym IN (0,1));
