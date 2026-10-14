-- 0018_v9_token_categories.sql — 审计 2026-10-13 P1-3：令牌类别新增 'case_no'（案号，L3a/全部化名时令牌化）与 'birth_date'（出生日期）
-- 带提示词的个人编号（社保/医保号、病历号、工号……）沿用 'id_number'，微信号/QQ 号沿用 'account'，不新增类别。
-- SQLite 不能 ALTER CHECK：matter_tokens 按官方步骤重建（新表 → 拷贝全部行与 seq → 删旧表 → 改名），保留全部列、默认值、外键与两条 UNIQUE；
-- 自增序列（令牌表版本的单调性）一并带过去。matter_tokens 没有附加索引与触发器（0010 只有 UNIQUE 约束）。
-- 其余含 category 的表（0013 qa_tokens）无 CHECK，不需改。事务与外键检查由迁移器负责。
-- kwl:managed-transaction

CREATE TABLE matter_tokens_new (
  seq        integer PRIMARY KEY AUTOINCREMENT,
  matter_id  text NOT NULL REFERENCES matters(matter_id),
  token      text NOT NULL,
  category   text NOT NULL CHECK (category IN ('person','org','id_number','phone','account','uscc','address','plate','email','case_no','birth_date')),
  value      text NOT NULL,
  normalized text NOT NULL,
  source     text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (matter_id, token),
  UNIQUE (matter_id, category, normalized)
);

INSERT INTO matter_tokens_new (seq, matter_id, token, category, value, normalized, source, created_at)
  SELECT seq, matter_id, token, category, value, normalized, source, created_at FROM matter_tokens ORDER BY seq;

-- 自增序列：取旧表序列与新表已用最大值中的较大者（旧表若删过行，序列可能大于 MAX(seq)）
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'matter_tokens_new', 0
   WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'matter_tokens_new');
UPDATE sqlite_sequence
   SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'matter_tokens'), 0))
 WHERE name = 'matter_tokens_new';

DROP TABLE matter_tokens;
ALTER TABLE matter_tokens_new RENAME TO matter_tokens;
