-- 0037_v9_share_relay.sql — 第 11 批 S11：团队事项经中软共享中继同步（端到端加密；含两路复核处置）。
-- relay_export_state：中继介质的导出水位（与共享文件夹的 sync_state 分开）；
--   last_always_digest：每段都附带的行（用户、事项、设备、IM 绑定）的摘要——只有它们且摘要未变时不出段。
-- relay_matters：中继上可能有本事项副本的事项（上传任何块之前就记下，删除回执据此如实写“中软共享中继上有密文副本”；复核 S11B-07）；
--   known：已知中继上有该事项（非负责人的设备等负责人先登记，复核 S11A-04）；history_*：取历史的进度与退避
--   （新得到面向本机的包裹即重取，复核 S11B-05）；my_epoch：本机持有包裹的最高纪元。
-- relay_kv：游标、中继实例编号与收发结果（只有代码与时刻，不含内容）。
-- relay_retry：取回失败的段（不堵队头，退避重试，7 天放弃）。
-- relay_outbox：发件的退避与卡住原因（复核 S11B-01/08/09：可恢复的退避重试，不可恢复的如实显示）。
-- relay_blob_wait：密文块取不回的收件段（退避，30 天放弃；复核 S11B-06）。
-- relay_imported：经中继摄取的行；中继介质导出时不原样发回（复核 S11B-03）。

CREATE TABLE relay_export_state (
  matter_id           text PRIMARY KEY,
  last_export_lamport integer NOT NULL DEFAULT 0,
  last_export_at      text,
  last_always_digest  text,
  updated_at          text NOT NULL
);

CREATE TABLE relay_matters (
  matter_id       text PRIMARY KEY,
  first_seen_at   text NOT NULL,
  uploaded_at     text,
  known           integer NOT NULL DEFAULT 0,
  history_cursor  integer NOT NULL DEFAULT 0,
  history_state   text NOT NULL DEFAULT 'pending' CHECK (history_state IN ('pending','done','denied')),
  history_next_at text,
  history_attempts integer NOT NULL DEFAULT 0,
  my_epoch        integer NOT NULL DEFAULT 0
);

CREATE TABLE relay_kv (
  k text PRIMARY KEY,
  v text NOT NULL
);

CREATE TABLE relay_retry (
  segment_id   text PRIMARY KEY,
  matter_id    text NOT NULL,
  item_json    text NOT NULL,
  attempts     integer NOT NULL DEFAULT 1,
  first_at     text NOT NULL,
  next_at      text NOT NULL,
  last_error   text NOT NULL
);

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

-- h：每段都附带的四张表（用户、事项、设备、IM 绑定）记收到时的行内容摘要——本机行仍与收到的一样就不再导出（本机改过的照常导出）。
CREATE TABLE relay_imported (
  t  text NOT NULL,
  pk text NOT NULL,
  h  text NOT NULL DEFAULT '',
  PRIMARY KEY (t, pk)
);
