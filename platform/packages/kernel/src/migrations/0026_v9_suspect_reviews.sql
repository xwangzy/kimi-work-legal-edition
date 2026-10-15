-- 0026_v9_suspect_reviews.sql — v9.2 §3.3–3.4（Y5 P1-11 ③）：发送前疑似姓名的律师判定。
-- 规则候选器在令牌化之后仍像自然人姓名的原文（疑似未替换）由律师逐个判定：是姓名 → 加入当事人名单（matter_parties）；
-- 不是姓名 → 记在这里，本事项不再提示。L3a 事项还有未判定的疑似姓名时不能发起。
-- 值是本机账本内的原文（与当事人词典同级，随 SQLCipher 加密）；删除事项时一并清除（matter-lifecycle.ts purgeMatter）。
-- kwl:managed-transaction

CREATE TABLE matter_suspect_reviews (
  matter_id text NOT NULL REFERENCES matters (matter_id),
  value text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('not_name', 'name')),
  decided_by text NOT NULL,
  decided_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (matter_id, value)
);
