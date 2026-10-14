-- 0013_v9_w1_approvals_qa_basis.sql — v9 阶段 5（W1 桌面）
--   1) 出站批准凭据（第 02 篇 §9.5：批准绑定主体、事项、动作、参数摘要、目的地、期限与 nonce；收敛偏离 D-16）：
--      律师在可信界面确认跨边界动作（含实体的检索、新域名抓取、图像原样送模型）→ 内核以本机设备签名密钥签发凭据 →
--      出站闸门按（运行、用途、出站摘要、目的地）向内核取凭据并用设备公钥独立核验；“本次”凭据一次用尽，“本任务内”只在本运行内有效；
--   2) 无事项问答（第 04 篇 §5.3）：历史只在本机；每个会话一把令牌密钥（问题中的标识符与人名在出站前替换为会话代号）；
--   3) 四项依据（第 02 篇 §8.1；收敛偏离 D-21）：委托/保密授权、个人信息处理依据、敏感信息特别条件、转委托与次处理者——JSON 字段，
--      consent_status 由四项派生（全部为“已确认/不适用”即齐备），宿主与闸门按四项判定。
-- kwl:managed-transaction

CREATE TABLE egress_approvals (
  approval_id  text PRIMARY KEY,
  tenant_id    text NOT NULL,
  matter_id    text NOT NULL REFERENCES matters(matter_id),
  run_id       text NOT NULL,
  user_id      text NOT NULL,
  device_id    text NOT NULL,
  channel      text NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('search','fetch','media')),
  reason       text NOT NULL,
  digest       text,
  destination  text NOT NULL,
  variant      text CHECK (variant IS NULL OR variant IN ('original','generalized')),
  scope        text NOT NULL CHECK (scope IN ('once','task')),
  nonce        text NOT NULL,
  expires_at   text NOT NULL,
  credential   text NOT NULL,
  signature    text NOT NULL,
  uses         integer NOT NULL DEFAULT 0,
  bound_digests text NOT NULL DEFAULT '[]',
  revoked_at   text,
  created_at   text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX egress_approvals_run_idx ON egress_approvals (run_id, purpose);

CREATE TABLE qa_conversations (
  conversation_id text PRIMARY KEY,
  tenant_id    text NOT NULL,
  user_id      text NOT NULL,
  title        text NOT NULL,
  token_key_b64 text NOT NULL,
  created_at   text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX qa_conversations_user_idx ON qa_conversations (tenant_id, user_id, updated_at DESC);

CREATE TABLE qa_messages (
  message_id      text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES qa_conversations(conversation_id),
  seq             integer NOT NULL,
  role            text NOT NULL CHECK (role IN ('user','assistant','notice')),
  text            text NOT NULL,
  created_at      text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE qa_tokens (
  conversation_id text NOT NULL REFERENCES qa_conversations(conversation_id),
  seq        integer NOT NULL,
  token      text NOT NULL,
  category   text NOT NULL,
  value      text NOT NULL,
  normalized text NOT NULL,
  source     text NOT NULL,
  PRIMARY KEY (conversation_id, token)
);

ALTER TABLE matters ADD COLUMN basis text;
