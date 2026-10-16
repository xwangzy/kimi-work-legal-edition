-- 0038_v9_share_relay_review.sql — 第 11 批两路复核处置（第一、二轮）：共享中继的收发状态。
-- 另起迁移，不改已执行过的 0037（复核 S11B-26；执行器按文件名判断）。
-- relay_matters 增列：known / known_at（已知中继上有该事项、最近确认时刻：非负责人等负责人先登记，复核 S11A-04/21）；
--   history_state / history_next_at / history_attempts（取历史的进度与退避，不是读者记“暂缓”不当完成，复核 S11A-11）；
--   my_epoch（本机持有自己包裹的最高纪元：上升即重取历史，复核 S11B-05）；controller（中继告知的控制成员，复核 S11B-19）。
--   旧列 history_done 不再使用。
-- relay_outbox：发件的退避与卡住原因（复核 S11B-01/08/09）。
-- relay_blob_wait：密文块取不回的收件段（退避，30 天放弃；复核 S11B-06）。
-- relay_imported：经中继摄取的行与收到时的内容摘要；本机行仍与收到时相同即不经中继原样发回（复核 S11B-03/20）；按事项清理（S11B-24）。
-- relay_unreadable：本机永远解不开、已丢弃的段（本机加入前的纪元、待钥 30 天），下载前跳过（复核 S11B-25）。

ALTER TABLE relay_matters ADD COLUMN known integer NOT NULL DEFAULT 0;
ALTER TABLE relay_matters ADD COLUMN known_at text;
ALTER TABLE relay_matters ADD COLUMN history_state text NOT NULL DEFAULT 'pending' CHECK (history_state IN ('pending','done','denied'));
ALTER TABLE relay_matters ADD COLUMN history_next_at text;
ALTER TABLE relay_matters ADD COLUMN history_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE relay_matters ADD COLUMN my_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE relay_matters ADD COLUMN controller text;
UPDATE relay_matters SET history_state = 'done' WHERE history_done = 1;

CREATE TABLE relay_outbox (
  segment_id  text PRIMARY KEY,
  matter_id   text NOT NULL,
  state       text NOT NULL CHECK (state IN ('retry','stuck')),
  attempts    integer NOT NULL DEFAULT 0,
  next_at     text,
  last_error  text NOT NULL,
  updated_at  text NOT NULL
);

CREATE TABLE relay_blob_wait (
  segment_id  text PRIMARY KEY,
  matter_id   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 1,
  first_at    text NOT NULL,
  next_at     text NOT NULL,
  last_error  text NOT NULL
);

CREATE TABLE relay_imported (
  t         text NOT NULL,
  pk        text NOT NULL,
  matter_id text,
  h         text NOT NULL DEFAULT '',
  PRIMARY KEY (t, pk)
);
CREATE INDEX relay_imported_matter_idx ON relay_imported (matter_id);

CREATE TABLE relay_unreadable (
  segment_id text PRIMARY KEY,
  matter_id  text NOT NULL,
  at         text NOT NULL
);
