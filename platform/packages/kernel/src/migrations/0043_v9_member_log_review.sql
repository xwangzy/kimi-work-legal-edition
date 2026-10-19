-- 0043_v9_member_log_review.sql — 第 12 批第二、三轮复核处置（S12B-20/28/33/36/37、S12A-10）。
-- kwl:managed-transaction（重建 sync_alerts 放宽种类）
-- sync_alerts 增两种链告警：member_conflict（两位负责人互相降级或移出、尚无第三位负责人处置）、revoked_change（被吊销设备在吊销前做的移出或轮换因吊销标记未生效，须负责人重做）。
-- member_rewinds：本机写过的轮换在链上“胜出 / 不成立（含落选、声明不算）”的状态；每次由胜出转为不成立时退回一次导出水位（第三轮复核 S12B-37）。
--   第 12 批起本机不再删除这类轮换的密钥（它可能在合并更多事件后重新成立）；加密纪元取链上已声明、本机持有胜者密钥的最高纪元。
-- member_dismissed_roots：本机重新引导时放弃的起点（事件仍保留以保住收下时刻；不再采用、也不再记起点冲突）。
CREATE TABLE member_dismissed_roots (
  event_id  text PRIMARY KEY,
  matter_id text NOT NULL,
  at        text NOT NULL
);
CREATE TABLE member_rewinds (
  event_id  text PRIMARY KEY,
  matter_id text NOT NULL,
  at        text NOT NULL,
  active    integer NOT NULL DEFAULT 1
);

CREATE TABLE sync_alerts_new (
  matter_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('epoch_conflict', 'owner_unverifiable', 'chain_pending', 'rekey_needed', 'epoch_superseded', 'root_conflict', 'member_conflict', 'revoked_change')),
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
