-- 0044_v9_member_log_round3.sql — 第 12 批第三、四轮复核处置（0043 已提交过，不原地改：第四轮复核 S12B-47）。
-- kwl:managed-transaction（重建 sync_alerts 放宽种类；与新表、新列同一事务）
-- member_rewinds.active：本机写过的轮换在链上“胜出 / 不成立”的状态，每次由胜出转为不成立时退回一次导出水位（第三轮复核 S12B-37）。
-- sync_alerts 增两种链告警：member_conflict（两位负责人互相降级或移出、尚无第三位负责人以成员操作处置）、
--   revoked_change（被吊销设备做的移出或轮换因吊销标记未生效、只提示不暂停，须负责人核实后重做）。
-- matter_key_history：本机某纪元的密钥被链上胜出的那把替换时，原先那把留在这里（第四轮复核 S12A-24/S12B-44：
--   用它封过的材料块仍要解得开，导出前按段的纪元重封）。

-- 按“建新表再复制”重建 member_rewinds（第五轮复核 S12B-59：跑过第三轮那一版 0043 的开发库已有 active 列，ALTER 会报重复列）
CREATE TABLE member_rewinds_new (
  event_id  text PRIMARY KEY,
  matter_id text NOT NULL,
  at        text NOT NULL,
  active    integer NOT NULL DEFAULT 1
);
INSERT INTO member_rewinds_new (event_id, matter_id, at) SELECT event_id, matter_id, at FROM member_rewinds;
DROP TABLE member_rewinds;
ALTER TABLE member_rewinds_new RENAME TO member_rewinds;

CREATE TABLE IF NOT EXISTS matter_key_history (
  matter_id   text NOT NULL,
  epoch       integer NOT NULL,
  wrapped_for text NOT NULL,
  wrapped_key text NOT NULL,
  replaced_at text NOT NULL,
  PRIMARY KEY (matter_id, epoch, wrapped_for, wrapped_key)
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
