-- 0011_v9_token_conflicts.sql — 阶段 4 审查 S4-08：冲突代号登记
-- 闸门与内核各自首次为不同的值分配到同一短编号时（同类同事项 30 位碰撞 + 两侧并发首次分配），内核按事项密钥重算发现不一致：
-- 把该代号登记为冲突——此后界面与文书引擎一律不还原它（不会还原成另一个值），由律师核对；闸门随策略版本递增重建令牌化器。

BEGIN;

CREATE TABLE matter_token_conflicts (
  matter_id   text NOT NULL REFERENCES matters(matter_id),
  token       text NOT NULL,
  detected_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (matter_id, token)
);

COMMIT;
