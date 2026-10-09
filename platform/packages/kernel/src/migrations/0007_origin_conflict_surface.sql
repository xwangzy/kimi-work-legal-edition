-- 0007_origin_conflict_surface.sql — 归属冲突计数透出（sync.status 可见；行级内容不变，仅元数据列）

BEGIN;

ALTER TABLE sync_state ADD COLUMN last_import_origin_conflicts integer NOT NULL DEFAULT 0;

COMMIT;
