-- 0040_v9_sync_alerts.sql — 第 11 批第六轮复核处置：团队同步的持久告警（两种介质；只有编号、纪元、计数与原因代码）。
-- epoch_conflict：同一纪元本机持有的密钥与在册成员签发的段或包裹不一致（同号纪元分叉，复核 S11A-43/51、S11B-46）——
--   未解决前本机不经同步发出该事项的新内容；本机持有更高纪元（负责人再次轮换）即解决。
-- owner_unverifiable：已有事项里，被吊销设备写的成员行因转发者不可信被拒收（交接时本机离线，复核 S11A-52）——负责人可能无法确认；
--   本机同样暂停发出该事项（失败即关闭），恢复须重新引导（第 12 批）。
CREATE TABLE sync_alerts (
  matter_id text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('epoch_conflict', 'owner_unverifiable')),
  epoch     integer NOT NULL DEFAULT 0,
  detail    text NOT NULL,
  first_at  text NOT NULL,
  last_at   text NOT NULL,
  hits      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (matter_id, kind, epoch)
);
