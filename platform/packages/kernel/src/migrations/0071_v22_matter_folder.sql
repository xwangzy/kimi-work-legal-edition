-- 第 48 批：案卷文件夹（事项就是工作区）——律师把本机的一个案卷文件夹关联到事项，手动“同步”时把新增、改过的文件逐份照常导入。
--   matters.folder_root       关联文件夹的绝对路径（只属于这台电脑：团队同步不导出、不接收，见 sync-engine.ts DEVICE_LOCAL_COLUMNS）
--   matters.folder_linked_at  关联时间；matters.folder_synced_at 上次同步完成的时间
--   document_versions.rel_path 材料在文件夹里的位置（以“/”分隔的相对路径）；不是从文件夹导入的材料为 NULL。
--     同一位置的文件内容变了：新导入一份，supersedes 指向上一版（原件不可变，变化即新版本）。
-- 可空：旧事项与旧材料都为 NULL。
ALTER TABLE matters ADD COLUMN folder_root text;
ALTER TABLE matters ADD COLUMN folder_linked_at text;
ALTER TABLE matters ADD COLUMN folder_synced_at text;
ALTER TABLE document_versions ADD COLUMN rel_path text;
CREATE INDEX document_versions_rel_path_idx ON document_versions (matter_id, rel_path) WHERE rel_path IS NOT NULL;
