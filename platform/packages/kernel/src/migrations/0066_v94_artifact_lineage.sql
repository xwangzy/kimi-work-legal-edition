-- v9.4 第 25 批（走查发现）：成果版本按“同一份文件”比较，不再按种类。
--   原来同一事项里两次任务各出一份 Word（种类都是 agent_report），后一份就算前一份的新版本：前一份不能签发、已签发的验签无效。
--   lineage：任务产出的文件为“去掉日期的文件名”（同一事项里同名即同一份：重审同一份合同、重新起草同一份文书是新版）；
--   任务的最终回复草稿（都叫“草稿-日期.md”）为追问链的第一次任务；审查意见表与修订建议为所审合同；表格审阅导出为那张审阅表；
--   告知书、周报等每个事项一份的种类为空（照旧按种类）。版本号仍按种类递增，唯一约束不变。
-- 回填：最终回复草稿按任务（旧的追问链各版分开——只放宽、不收紧，签发仍绑定确切文件 hash）；其余按 manifest 里的来源或文件名。
ALTER TABLE artifact_versions ADD COLUMN lineage text;
UPDATE artifact_versions SET lineage = 'doc:' || json_extract(manifest, '$.source_document_version_id')
  WHERE kind IN ('review_table', 'review_table_docx', 'revision_draft') AND json_extract(manifest, '$.source_document_version_id') IS NOT NULL;
UPDATE artifact_versions SET lineage = 'table:' || json_extract(manifest, '$.table_id')
  WHERE kind IN ('review_grid', 'evidence_index', 'dd_findings') AND json_extract(manifest, '$.table_id') IS NOT NULL AND run_id IS NULL;
UPDATE artifact_versions SET lineage = 'run:' || run_id
  WHERE lineage IS NULL AND run_id IS NOT NULL AND kind IN ('a1_agent_draft', 'a1_agent_draft_partial');
UPDATE artifact_versions SET lineage = 'name:' || trim(replace(replace(filename, '-部分完成', ''), substr(filename, instr(filename, '-20'), 11), ''))
  WHERE lineage IS NULL AND run_id IS NOT NULL AND kind NOT IN ('consent_notice', 'matter_weekly_report') AND instr(filename, '-20') > 0 AND substr(filename, instr(filename, '-20') + 5, 1) = '-';
UPDATE artifact_versions SET lineage = 'name:' || trim(replace(filename, '-部分完成', ''))
  WHERE lineage IS NULL AND run_id IS NOT NULL AND kind NOT IN ('consent_notice', 'matter_weekly_report');
CREATE INDEX artifact_versions_lineage_idx ON artifact_versions (matter_id, kind, audience, lineage, version);
