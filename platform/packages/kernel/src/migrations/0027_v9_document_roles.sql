-- 0027_v9_document_roles.sql — v9.2 §4.4（Y4 §5 D-4、MT-3）：材料用途（我方 / 对方 / 参考）。
-- 单独成表、不改 document_versions：文档版本行在签名事件链上，改列会改变行摘要；用途是律师的本机标注，可随时改。
-- 运行时写进 A1 材料快照的清单（“001.txt（文件名 · 我方材料）”），供证据目录来源与争点矩阵使用；删除事项时一并清除。
-- kwl:managed-transaction

CREATE TABLE document_roles (
  document_version_id text PRIMARY KEY REFERENCES document_versions (document_version_id),
  matter_id text NOT NULL REFERENCES matters (matter_id),
  role text NOT NULL CHECK (role IN ('ours', 'theirs', 'reference')),
  set_by text NOT NULL,
  set_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX document_roles_matter_idx ON document_roles (matter_id);
