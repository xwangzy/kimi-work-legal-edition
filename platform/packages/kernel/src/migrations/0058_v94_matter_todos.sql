-- v9.4 第 20 批（评审 C1 §3.2、§1 #19，借鉴 Harvey Spaces / Legal Work Orchestration）：事项是大本营——概览里的“待办”。
-- 每条写做什么、谁做（我 / 助理 / 同事 / AI）、谁复核、期限；律师手工添加。AI 完成的任务、等你确认的任务、待签发的成果
-- 不存这里，由 todos.list 从任务与成果实时推出（不会两套状态对不上）。
--   assignee_kind：me 我 / assistant 助理 / colleague 同事 / ai AI；assignee_name：助理、同事的称呼（可空）；reviewer_name：复核人（可空 = 不需要复核）；
--   status：open 未完成 / done 已完成。首期只在本机（同事务不同步，偏离 D-117）。
-- kwl:managed-transaction
CREATE TABLE matter_todos (
  todo_id       text PRIMARY KEY,
  tenant_id     text NOT NULL,
  matter_id     text NOT NULL REFERENCES matters(matter_id),
  title         text NOT NULL,
  assignee_kind text NOT NULL DEFAULT 'me' CHECK (assignee_kind IN ('me','assistant','colleague','ai')),
  assignee_name text,
  reviewer_name text,
  due_date      text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_by    text NOT NULL,
  created_at    text NOT NULL,
  done_by       text,
  done_at       text,
  updated_at    text NOT NULL
);
CREATE INDEX matter_todos_matter_idx ON matter_todos (matter_id, status);
