-- 0020_v9_matter_ws_keys.sql — 事项工作区密钥（审计 S3 / 隐私 P0-3 / ZP-9；设计 docs/audit-2026-10-13/设计-工作区与会话落盘加密.md §3.1）
--   每台设备每个事项一把随机 32 字节密钥（按代 gen），以本机设备加密公钥包裹后保存；只用于本机 Agent 引擎会话、事件日志、工作区与材料快照的落盘加密。
--   与事项密钥（matter_keys，共享块与同步）解耦：宿主只拿到按用途派生的区密钥，拿不到事项密钥。
--   **不进入同步**（sync-engine 的表清单不含本表）；本机用户被移出事项、本设备被吊销或事项删除时删行即“加密擦除”。
-- kwl:managed-transaction

CREATE TABLE matter_ws_keys (
  matter_id   text NOT NULL REFERENCES matters(matter_id),
  gen         integer NOT NULL CHECK (gen >= 1),
  device_id   text NOT NULL,
  wrapped_key text NOT NULL,
  created_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at  text,
  PRIMARY KEY (matter_id, gen, device_id)
);
