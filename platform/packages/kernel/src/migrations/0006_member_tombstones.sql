-- 0006_member_tombstones.sql — 成员墓碑（阻断项：行级 DELETE 被同步回灌复活 → 再轮换向被移出成员重新包裹）
-- 机制：removed_* 墓碑 + 作者权威（author_device）+ 较新者胜（row_lamport）；读路径一律过滤 removed_at IS NULL；
-- 既有行 backfill：removed_* 为 NULL（有效成员）、row_lamport=1、author_device=''（未知，按最低优先级）。

BEGIN;

ALTER TABLE matter_members ADD COLUMN removed_at text;
ALTER TABLE matter_members ADD COLUMN removed_lamport integer;
ALTER TABLE matter_members ADD COLUMN author_device text NOT NULL DEFAULT '';
ALTER TABLE matter_members ADD COLUMN row_lamport integer NOT NULL DEFAULT 1;

COMMIT;
