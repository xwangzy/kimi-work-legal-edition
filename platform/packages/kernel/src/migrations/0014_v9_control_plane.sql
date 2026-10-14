-- 0014_v9_control_plane.sql — v9 阶段 6（控制面最小集 + T17 控制面被攻破演练）
--   第 02 篇 §7.1 #2–#5、§9.11“律所侧校验锚”、§10 凭据表；第 04 篇 §5.2、§10；第 06 篇 §1 G0“控制面最小集”。
--   1) 律所侧校验锚：律所根公钥已在 firm_identity；此处固定管理员签名门限（团队版 1 名、律所版 2 名；只升不降）；
--   2) 控制面下发文档的最近接受版本（许可、目录、租户盐、席位令牌、连接器目录）与版本高水位（只增不减：回放旧文档拒绝）；
--   3) 律所策略：接受过的每一版（含管理员签名），生效取最高版本且未过期者，过期或从未取得回退最严模板；
--   4) 律所连接器登记（须管理员设备签名）；成员设备公钥变更挂起（核对安全码后才替换）；控制面内容未通过本机核验的告警；
--   5) 事项匿名摘要待推送（经控制面下发网关做二次检查，收敛偏离 D-20）。
-- kwl:managed-transaction

CREATE TABLE firm_trust (
  tenant_id       text PRIMARY KEY,
  admin_threshold integer NOT NULL CHECK (admin_threshold BETWEEN 1 AND 5),
  source          text NOT NULL,
  pinned_at       text NOT NULL
);

CREATE TABLE cp_documents (
  tenant_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('license','directory','salt','seat','connectors','self_revoked')),
  version     integer,
  body_json   text NOT NULL,
  accepted_at text NOT NULL,
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE cp_high_water (
  tenant_id text NOT NULL,
  kind      text NOT NULL,
  version   integer NOT NULL,
  digest    text,
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE firm_policies (
  tenant_id             text NOT NULL,
  version               integer NOT NULL,
  doc_json              text NOT NULL,
  admin_signatures_json text NOT NULL,
  digest                text NOT NULL,
  relaxations_json      text NOT NULL,
  signers_json          text NOT NULL,
  accepted_at           text NOT NULL,
  PRIMARY KEY (tenant_id, version)
);

CREATE TABLE firm_connectors (
  tenant_id             text NOT NULL,
  connector_id          text NOT NULL,
  version               integer NOT NULL,
  doc_json              text NOT NULL,
  admin_signatures_json text NOT NULL,
  signers_json          text NOT NULL,
  accepted_at           text NOT NULL,
  PRIMARY KEY (tenant_id, connector_id)
);

CREATE TABLE device_key_changes (
  device_id   text PRIMARY KEY,
  tenant_id   text NOT NULL,
  member_id   text NOT NULL,
  cert_json   text NOT NULL,
  safety_code text NOT NULL,
  detected_at text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','dismissed')),
  resolved_at text,
  resolved_by text
);

CREATE TABLE cp_alerts (
  alert_id        integer PRIMARY KEY AUTOINCREMENT,
  tenant_id       text NOT NULL,
  area            text NOT NULL,
  code            text NOT NULL,
  subject         text,
  detail          text NOT NULL,
  created_at      text NOT NULL,
  acknowledged_at text,
  acknowledged_by text
);
CREATE INDEX cp_alerts_open_idx ON cp_alerts (tenant_id, acknowledged_at);

CREATE TABLE anon_matter_outbox (
  matter_id    text PRIMARY KEY REFERENCES matters(matter_id),
  tenant_id    text NOT NULL,
  anon_id      text NOT NULL,
  summary_json text NOT NULL,
  pushed_json  text,
  updated_at   text NOT NULL,
  pushed_at    text
);
