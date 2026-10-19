-- 第 13 批复核处置（A-01/02/03）：本机发出的成员邀请。邀请码的本机秘密段（invite_secret）只在发出邀请的管理员电脑上，
-- 用来核对入组申请的 HMAC 与对批准结果做 HMAC（控制面不知道它）；批准只认这里记下的成员标识与角色。
CREATE TABLE member_invitations (
  activation_id text PRIMARY KEY,
  tenant_id     text NOT NULL,
  member_slug   text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','partner','lawyer','assistant')),
  display_name  text NOT NULL,
  invite_secret text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','revoked','rejected')),
  device_id     text,
  created_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at    text
);
CREATE INDEX member_invitations_member_idx ON member_invitations (tenant_id, member_slug);
