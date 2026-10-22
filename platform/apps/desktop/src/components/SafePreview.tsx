/**
 * 成果安全预览（第 04 篇 §5.1 ③）：HTML 产物在无网隔离框架中预览（清洗 + sandbox="" + 注入 CSP）；
 * Markdown/文本产物用安全渲染（只生成元素，不注入 HTML）；其他格式只给下载（下载件交 Office 前由内核剥离外部关系）。
 */
import { useMemo } from "react";
import { buildPreviewDoc, type PreviewCite } from "../lib/safe-preview.ts";
import { Markdown } from "./Markdown.tsx";

/** cites：引用角标（v9.4 第 20 批 C-03），见 lib/citation-review.ts previewCites。 */
export function SafePreview({ filename, text, tokenMap, office, cites }: { filename: string; text: string; tokenMap?: Map<string, string | null>; office?: boolean; cites?: PreviewCite[] }) {
  const lower = filename.toLowerCase();
  // office：内核把 DOCX/XLSX 渲染成的白名单 HTML（修订、批注、表格），同样在隔离框架中显示
  const isHtml = office || lower.endsWith(".html") || lower.endsWith(".htm");
  // Office 成果用文书纸面版式（Y4 #31）
  const srcDoc = useMemo(() => (isHtml ? buildPreviewDoc(text, tokenMap, { paper: !!office, ...(cites ? { cites } : {}) }) : ""), [isHtml, text, tokenMap, office, cites]);
  if (isHtml) {
    return (
      <div className="safe-preview">
        <div className="sp-note">{office ? "预览（排版为近似效果，修订以绿色插入、红色删除显示；以 Word 打开为准）" : "隔离预览：不执行脚本、不加载任何外部资源、链接不可点击。"}</div>
        <iframe title={filename} sandbox="" srcDoc={srcDoc} referrerPolicy="no-referrer" className="sp-frame" />
      </div>
    );
  }
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".markdown")) {
    return (
      <div className="safe-preview sp-md">
        <Markdown text={text} tokenMap={tokenMap} {...(cites ? { cites } : {})} />
      </div>
    );
  }
  return <p className="muted">这种文件不能在应用内预览，请下载后用本机软件打开。</p>;
}
