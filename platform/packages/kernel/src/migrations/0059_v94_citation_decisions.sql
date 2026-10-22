-- v9.4 第 20 批 C-03（评审 C1 §4.2、§4.4）：成果里每处引用的支持性由律师逐条决定——确认支持 / 标为不支持（须改正）/ 我已知悉。
-- 按成果版本记（新版本文字可能变了，须重新决定）；cite_key 是“引用原文#第几次出现”。签发前：标为不支持的须先改正，系统核到的每一条都要有决定。
-- kwl:managed-transaction
CREATE TABLE citation_decisions (
  artifact_version_id text NOT NULL REFERENCES artifact_versions(artifact_version_id),
  cite_key            text NOT NULL,
  decision            text NOT NULL CHECK (decision IN ('supported','unsupported','acknowledged')),
  decided_by          text NOT NULL,
  decided_at          text NOT NULL,
  PRIMARY KEY (artifact_version_id, cite_key)
);
