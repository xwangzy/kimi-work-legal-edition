-- 0004_sync_node.sql — 材料块加密收尾（§5.1）与共享文件夹同步（§7）支撑结构
-- 既有明文开发库可弃（README 已声明），不做过渡迁移；新库 blobs 直接密文（块头带 epoch）。

BEGIN;

-- 节点逐事项授权（§5.3 服务成员）：默认不授权；strict/伦理墙事项强制 0
ALTER TABLE matters ADD COLUMN node_allowed integer NOT NULL DEFAULT 0;

-- 同步状态：每事项导出水位（本机 lamport 与对应时间）与摄取游标
CREATE TABLE sync_state (
  matter_id text PRIMARY KEY REFERENCES matters(matter_id),
  last_export_lamport integer NOT NULL DEFAULT 0,
  last_export_at text,
  last_import_at text,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 已摄取段（幂等去重：同一 segment_id 只应用一次）
CREATE TABLE sync_segments_seen (
  segment_id text PRIMARY KEY,
  from_device text NOT NULL,
  matter_id text NOT NULL,
  applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 行来源追踪（合并规则「归属设备权威 + (lamport, device) 较新者胜」的判定依据）
CREATE TABLE sync_row_origin (
  table_name text NOT NULL,
  row_pk text NOT NULL,
  origin_device text NOT NULL,
  origin_lamport integer NOT NULL,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (table_name, row_pk)
);

-- 业务冲突旗标（§7.1：并发双版本显式保留 + 界面后续处理；落数据与事件）
CREATE TABLE sync_conflicts (
  conflict_id text PRIMARY KEY,
  matter_id text NOT NULL REFERENCES matters(matter_id),
  kind text NOT NULL,
  detail text NOT NULL DEFAULT '{}',
  resolved integer NOT NULL DEFAULT 0,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

COMMIT;
