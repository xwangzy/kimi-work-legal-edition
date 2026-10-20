-- v9.3 第 14 批续（B-10 成员离所；评审 Z4 P1-8）：管理员在本机移出成员的记录——停用他的全部电脑（devices.revoke 同一路径）并释放席位。
-- 席位要经控制面释放，当时可能连不上：seat_released_at 为空即“席位还没有释放”，成员页可再点一次“移出律所”重试。只有编号与时刻。
CREATE TABLE IF NOT EXISTS member_removals (
  tenant_id        text NOT NULL,
  member_id        text NOT NULL,
  removed_at       text NOT NULL,
  removed_by       text NOT NULL,
  devices_revoked  integer NOT NULL DEFAULT 0,
  seat_released_at text,
  seat_error       text,
  PRIMARY KEY (tenant_id, member_id)
);
