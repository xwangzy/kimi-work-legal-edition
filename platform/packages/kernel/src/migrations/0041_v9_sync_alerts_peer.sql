-- 0041_v9_sync_alerts_peer.sql — 第 11 批第七轮（收口）复核处置。
-- kwl:managed-transaction
-- sync_alerts 增列 peer_device / peer_member：纪元冲突的另一方（本机解不开它的段、或它签发了另一把密钥）。
--   冲突只在这一方发来更高纪元、且本机解得开时解除（复核 S11A-54/S11B-54：否则被移出的共同负责人再轮换一次即可解除暂停）；界面写明另一方是谁。
ALTER TABLE sync_alerts ADD COLUMN peer_device text;
ALTER TABLE sync_alerts ADD COLUMN peer_member text;
