-- 0031_v9_cp_audit.sql — 第 9 批（v9.2 §5.1 S14；调研 Y2 §3.14“律所管理员可导出本所审计流水，满足律所对受托人的监督”）。
-- cp_audit_records：从中软控制面取回、本机验过控制面签名与哈希链的运营审计流水（律所侧独立留存一份：云端之后删改，本机仍有原记录）。
-- 只有动作代码、执行者编号、目标编号与结果代码——没有客户内容。只在本机（不进共享文件夹同步：每台管理员设备各自取、各自验）。
-- 见过的最高序号与它的 hash 记在 cp_high_water（kind = 'cp_audit'）：云端改写已给出的历史即告警。

CREATE TABLE cp_audit_records (
  tenant_id text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  at text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  actor_fp text,
  action text NOT NULL,
  target text,
  result text NOT NULL,
  prev text NOT NULL,
  hash text NOT NULL,
  fetched_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, seq)
);
