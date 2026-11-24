/**
 * 成果安全预览（第 04 篇 §5.1 ③）：HTML 产物在无网隔离框架中预览（清洗 + sandbox="" + 注入 CSP）；
 * Markdown/文本产物用安全渲染（只生成元素，不注入 HTML）；其他格式只给下载（下载件交 Office 前由内核剥离外部关系）。
 *
 * 隔离框架按内容摘要换新元素（previewFrameKey，第 62 批 Word 预览空白根因修复）：同一个框架上连改 srcdoc 会让跨进程框架永久不出图。
 * “重新载入预览”同样是换新元素，给万一仍不显示时的人工恢复。
 */
import { useMemo, useState } from "react";
import { buildPreviewDoc, previewFrameKey, type PreviewCite } from "../lib/safe-preview.ts";
import { Markdown } from "./Markdown.tsx";

/** cites：引用角标（v9.4 第 20 批 C-03），见 lib/citation-review.ts previewCites。 */
export function SafePreview({ filename, text, tokenMap, office, cites }: { filename: string; text: string; tokenMap?: Map<string, string | null>; office?: boolean; cites?: PreviewCite[] }) {
  const lower = filename.toLowerCase();
  // office：内核把 DOCX/XLSX 渲染成的白名单 HTML（修订、批注、表格），同样在隔离框架中显示
  const isHtml = office || lower.endsWith(".html") || lower.endsWith(".htm");
  // Office 成果用文书纸面版式（Y4 #31）
  const srcDoc = useMemo(() => (isHtml ? buildPreviewDoc(text, tokenMap, { paper: !!office, ...(cites ? { cites } : {}) }) : ""), [isHtml, text, tokenMap, office, cites]);
  const frameKey = useMemo(() => previewFrameKey(srcDoc), [srcDoc]);
  const [reloads, setReloads] = useState(0);
  if (isHtml) {
    return (
      <div className="safe-preview">
        <div className="sp-note">
          <span>{office ? "预览（排版为近似效果，修订以绿色插入、红色删除显示；以 Word 打开为准）" : "隔离预览：不执行脚本、不加载任何外部资源、链接不可点击。"}</span>
          <button type="button" className="btn-link sp-reload" onClick={() => setReloads((n) => n + 1)} title="预览区没有显示内容时，点这里重新载入">
            重新载入预览
          </button>
        </div>
        <iframe key={`${frameKey}:${reloads}`} title={filename} sandbox="" srcDoc={srcDoc} referrerPolicy="no-referrer" className="sp-frame" data-frame-key={frameKey} />
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

/** Office 预览生成失败（内核渲染报错、文件校验不符等）：说清原因并给重试，不再误报“这种文件不能预览”。 */
export function PreviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="safe-preview sp-error" role="alert">
      <p>预览没有生成：{message || "没有给出具体原因"}</p>
      <p className="muted">文件本身不受影响，仍可下载；重试一次通常就能显示。</p>
      <button type="button" className="btn" onClick={onRetry}>
        重新生成预览
      </button>
    </div>
  );
}
