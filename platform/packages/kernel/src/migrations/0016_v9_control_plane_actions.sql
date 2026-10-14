-- 0016_v9_control_plane_actions.sql — v9 阶段 6 复核处置（S6-A22、S6-B31）
--   待同步到控制面的吊销区分三种未完成状态：
--   1) 待发送（联网后自动重试）；
--   2) 已提交、待控制面签名的设备目录确认（submitted_at）——完成以目录把该设备列为吊销为准，不凭 HTTP 应答；
--   3) 控制面拒绝（failed_at，如本设备证书角色不是管理员或合伙人）：不自动重试，界面写明原因、需人工处理；
--      控制面目录列为吊销后（例如另一台管理员设备已吊销）自动完成。
-- kwl:managed-transaction

ALTER TABLE cp_pending_actions ADD COLUMN submitted_at text;
ALTER TABLE cp_pending_actions ADD COLUMN failed_at text;
