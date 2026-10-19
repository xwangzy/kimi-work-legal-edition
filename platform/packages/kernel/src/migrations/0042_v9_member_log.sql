-- 0042_v9_member_log.sql — 第 12 批：带因果链的成员日志（设计见 docs/第12批-成员日志设计.md）。
-- kwl:managed-transaction（重建 sync_alerts 放宽种类；与新表同一事务，中途失败整体回滚）
-- member_events：每个团队事项的成员事件（作者设备签名、引用前序事件、按事项合并的逻辑时钟）；只增不改，编号 = 载荷摘要。
--   via_member：首次收到时转发它的段的签发成员（本机写的为 NULL；缺前序的事件只有经本链在册成员转发的才暂停发出）。
-- member_chain：本机采用的起点；root_id 为空 = 本机被要求重新引导该事项（下次收到的链按首同步规则采用）。
-- sync_alerts 增四种链告警：chain_pending / rekey_needed / epoch_superseded / root_conflict（有告警即暂停发出，沿用 0040）。

CREATE TABLE member_events (
  event_id      text PRIMARY KEY,
  matter_id     text NOT NULL,
  lamport       integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('genesis','anchor','member','rekey','wrap','mark','control')),
  author_device text NOT NULL,
  author_member text NOT NULL,
  payload       text NOT NULL,
  sig           text NOT NULL,
  author_cert   text NOT NULL,
  via_member    text,
  received_at   text NOT NULL
);
CREATE INDEX member_events_matter ON member_events (matter_id, lamport);

CREATE TABLE member_chain (
  matter_id  text PRIMARY KEY,
  root_id    text,
  adopted_at text NOT NULL
);

-- chain_paused_export：有告警暂停发出期间，只发成员链（不含内容）的段——按介质记上次发出的链摘要，链没变不重发。
CREATE TABLE chain_paused_export (
  matter_id text NOT NULL,
  medium    text NOT NULL CHECK (medium IN ('folder', 'relay')),
  digest    text NOT NULL,
  at        text NOT NULL,
  PRIMARY KEY (matter_id, medium)
);

CREATE TABLE sync_alerts_new (
  matter_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('epoch_conflict', 'owner_unverifiable', 'chain_pending', 'rekey_needed', 'epoch_superseded', 'root_conflict')),
  epoch       integer NOT NULL DEFAULT 0,
  detail      text NOT NULL,
  first_at    text NOT NULL,
  last_at     text NOT NULL,
  hits        integer NOT NULL DEFAULT 1,
  peer_device text,
  peer_member text,
  PRIMARY KEY (matter_id, kind, epoch)
);
INSERT INTO sync_alerts_new (matter_id, kind, epoch, detail, first_at, last_at, hits, peer_device, peer_member)
  SELECT matter_id, kind, epoch, detail, first_at, last_at, hits, peer_device, peer_member FROM sync_alerts;
DROP TABLE sync_alerts;
ALTER TABLE sync_alerts_new RENAME TO sync_alerts;
