-- 0003_parse_ocr.sql — 本机解析与 OCR（方案 v5.0 第 4 篇 §8.1）：页级解析状态与文件页锚点
-- 页质量逐页落库（低质量页可见、可重扫、可人工纠正）；parse_texts.content 以 \f（换页符）分隔页，
-- 锚点 file_page 由字符区间换算（非 PDF 材料无 \f → file_page 为 NULL）。

BEGIN;

CREATE TABLE parse_pages (
  parse_version_id text NOT NULL REFERENCES parse_versions(parse_version_id),
  page_no    integer NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('text','scanned','image')),
  quality    text NOT NULL CHECK (quality IN ('ok','low','unreadable')),
  note       text,
  char_count integer NOT NULL DEFAULT 0,
  mean_score real,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (parse_version_id, page_no)
);

ALTER TABLE evidence_anchors ADD COLUMN file_page integer;

COMMIT;
