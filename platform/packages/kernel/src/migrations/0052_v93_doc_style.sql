-- v9.3 第 15 批 B-4（评审 Z1 P1-1：生成的 Word 没有版式）：这台电脑导出 Word 时用的文书版式——函头（自动用本所名称 / 自定义 / 不加）、
-- 函头下的地址电话（至多两行）、正文字体字号、页码，以及律所上传的 Word 模板（字节存在本表，随账本加密；上限 5 MB）。不含案件内容。
CREATE TABLE IF NOT EXISTS firm_doc_style (
  tenant_id        text PRIMARY KEY,
  letterhead       text NOT NULL DEFAULT 'auto' CHECK (letterhead IN ('auto','custom','none')),
  letterhead_name  text,
  letterhead_lines text NOT NULL DEFAULT '[]',
  body             text NOT NULL DEFAULT 'song-xiaosi' CHECK (body IN ('song-xiaosi','fangsong-san')),
  page_numbers     integer NOT NULL DEFAULT 1,
  template         blob,
  template_name    text,
  template_sha256  text,
  updated_at       text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
