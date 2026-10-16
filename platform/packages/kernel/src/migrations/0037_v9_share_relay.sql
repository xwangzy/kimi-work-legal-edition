-- 0037_v9_share_relay.sql — 第 11 批 S11：团队事项经中软共享中继同步（端到端加密）。
-- relay_export_state：中继介质的导出水位（与共享文件夹的 sync_state 分开——换介质时中继从头收到全部内容）；
--   last_always_digest：每段都附带的行（用户、事项、设备、IM 绑定）的摘要——只有它们且摘要未变时不出段。
-- relay_matters：本机经中继发出过或取回过段的事项（删除回执据此写“中软共享中继上有密文副本”；新见到的事项先取历史）。
-- relay_kv：取新段的游标与最近一次收发的结果（只有代码，不含内容）。

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
  history_cursor  integer NOT NULL DEFAULT 0,
  history_done    integer NOT NULL DEFAULT 0
);

CREATE TABLE relay_kv (
  k text PRIMARY KEY,
  v text NOT NULL
);

-- relay_retry：取回失败的段（块被换、块缺失、不再是读者等单条问题）——不堵住后面的段（游标照常前进），
--   按退避重试，7 天仍取不回即丢弃并计数。只存中继给的段登记（编号、事项、摘要、块摘要），不含内容。
CREATE TABLE relay_retry (
  segment_id   text PRIMARY KEY,
  matter_id    text NOT NULL,
  item_json    text NOT NULL,
  attempts     integer NOT NULL DEFAULT 1,
  first_at     text NOT NULL,
  next_at      text NOT NULL,
  last_error   text NOT NULL
);
