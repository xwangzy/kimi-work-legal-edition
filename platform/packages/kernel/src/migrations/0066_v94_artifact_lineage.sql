-- v9.4 第 25 批（走查发现）：成果版本按“同一份文件”比较，不再按种类。
--   原来同一事项里两次任务各出一份 Word（种类都是 agent_report），后一份就算前一份的新版本：前一份不能签发、已签发的验签无效。
--   lineage（新写入由 services/artifact-lineage.ts 算）：内核场景成果为“场景 + 输入材料 + 去掉末尾日期的文件名”；Agent 工具出的文件为
--   “追问链 + 文件名”；最终回复草稿为追问链；审查意见表与修订建议为所审合同；表格审阅导出为那张审阅表；告知书、周报为空（照旧按种类）。
--   版本号仍按种类递增，唯一约束不变。
-- 回填：任务产出一律按“任务 + 原文件名”、最终回复草稿按任务——旧数据只放宽、不收紧（旧的重审与追问各版分开，都可签发；签发仍绑定确切文件 hash），
--   不在 SQL 里去日期（复核 Q7-05：SQL 去日期与运行时不一致会算错）。manifest 不是合法 JSON 的行不按来源回填（复核 Q7-08）。
ALTER TABLE artifact_versions ADD COLUMN lineage text;
UPDATE artifact_versions SET lineage = 'doc:' || (CASE WHEN json_valid(manifest) THEN json_extract(manifest, '$.source_document_version_id') END)
  WHERE kind IN ('review_table', 'review_table_docx', 'revision_draft') AND (CASE WHEN json_valid(manifest) THEN json_extract(manifest, '$.source_document_version_id') END) IS NOT NULL;
UPDATE artifact_versions SET lineage = 'table:' || (CASE WHEN json_valid(manifest) THEN json_extract(manifest, '$.table_id') END)
  WHERE kind IN ('review_grid', 'evidence_index', 'dd_findings') AND run_id IS NULL AND (CASE WHEN json_valid(manifest) THEN json_extract(manifest, '$.table_id') END) IS NOT NULL;
UPDATE artifact_versions SET lineage = 'run:' || run_id
  WHERE lineage IS NULL AND run_id IS NOT NULL AND kind IN ('a1_agent_draft', 'a1_agent_draft_partial');
UPDATE artifact_versions SET lineage = 'run:' || run_id || '|' || filename
  WHERE lineage IS NULL AND run_id IS NOT NULL AND kind NOT IN ('consent_notice', 'matter_weekly_report');
CREATE INDEX artifact_versions_lineage_idx ON artifact_versions (matter_id, kind, audience, lineage, version);
