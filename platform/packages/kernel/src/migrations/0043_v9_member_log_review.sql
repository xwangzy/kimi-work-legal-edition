-- 0043_v9_member_log_review.sql — 第 12 批第二轮复核处置（S12B-20/28）。
-- member_rewinds：本机写过、之后在链上不成立的轮换，已为它退回过一次导出水位（只退一次，免得每次导出都全量重发）。
--   第 12 批起本机不再删除这类轮换的密钥（它可能在合并更多事件后重新成立）；加密纪元取链上已声明、本机持有胜者密钥的最高纪元。
-- member_dismissed_roots：本机重新引导时放弃的起点（事件仍保留以保住收下时刻；不再采用、也不再记起点冲突）。
CREATE TABLE member_dismissed_roots (
  event_id  text PRIMARY KEY,
  matter_id text NOT NULL,
  at        text NOT NULL
);
CREATE TABLE member_rewinds (
  event_id  text PRIMARY KEY,
  matter_id text NOT NULL,
  at        text NOT NULL
);
