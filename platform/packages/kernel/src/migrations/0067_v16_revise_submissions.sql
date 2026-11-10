-- V16 第 41 批（真实走查：审合同出修订稿，助手三次调用 docx.revise 都重发全部 61 条修改，每次生成 2～3 分钟，40 分钟工作时限内没交出修订稿）：
--   记住本任务对每份原件最后一次提交的完整修改清单（不论那次是试写、被退回还是已写入），助手更正时只交要换、要删、要加的几条（amend），
--   内核据此合成新的完整清单，仍从原件重新生成、全有或全无。
--   patches 是助手提交的令牌形态清单（JSON，与 docx.revise 的 patches 入参同一结构；不含真名）；outcome 为 preview / not_applied / applied。
--   放在库里而不是进程内存：任务可能跨进程恢复。事项删除时随事项一并删除（services/matter-lifecycle.ts）。
CREATE TABLE revise_submissions (
  run_id              text NOT NULL,
  document_version_id text NOT NULL,
  matter_id           text NOT NULL,
  patches             text NOT NULL,
  outcome             text NOT NULL,
  updated_at          text NOT NULL,
  PRIMARY KEY (run_id, document_version_id)
);
CREATE INDEX revise_submissions_matter_idx ON revise_submissions (matter_id);
