/**
 * 成果安全预览（第 04 篇 §5.1 ③）：HTML 产物在无网隔离框架中预览（清洗 + sandbox="" + 注入 CSP）；
 * Markdown/文本产物用安全渲染（只生成元素，不注入 HTML）；其他格式只给下载（下载件交 Office 前由内核剥离外部关系）。
 *
 * 隔离框架按内容摘要换新元素（previewFrameKey，第 62 批 Word 预览空白根因修复）：同一个框架上连改 srcdoc 会让跨进程框架永久不出图。
 * “重新载入预览”同样是换新元素，给万一仍不显示时的人工恢复。
 *
 * V41 第 67 批（工作线 E）：Word 排成浅灰画布上的白色 A4 纸；Excel 按表格排（不套文书纸面），多张工作表在框架外做表签、
 * 框架里一次只放一张表（框架不执行脚本，表签只能在外面；切换表签即换一个新框架，同样不在原框架上改 srcdoc）。
 */
import { useMemo, useState } from "react";
import { buildPreviewDoc, previewFrameKey, splitSheets, type PreviewCite } from "../lib/safe-preview.ts";
import { TOKEN_RE } from "../lib/tokens.ts";
import { Markdown } from "./Markdown.tsx";
import "../styles-preview.css";

const UNNAMED_SHEET = "（未命名）";

/** 表签上的表名：在本机界面还原代号（与正文一样只在本机显示；React 按文字输出，不当 HTML）。 */
function sheetLabel(name: string, map?: Map<string, string | null>): string {
  if (!map || map.size === 0) return name || UNNAMED_SHEET;
  return name.replace(TOKEN_RE, (m) => map.get(m) ?? m) || UNNAMED_SHEET;
}

/** cites：引用角标（v9.4 第 20 批 C-03），见 lib/citation-review.ts previewCites。 */
/** compactNote（第 66 批）：说明收成“近似预览”，完整说法放悬停提示（成果页右侧预览空间小）。 */
export function SafePreview({ filename, text, tokenMap, office, cites, compactNote }: { filename: string; text: string; tokenMap?: Map<string, string | null>; office?: boolean; cites?: PreviewCite[]; compactNote?: boolean }) {
  const lower = filename.toLowerCase();
  // office：内核把 DOCX/XLSX 渲染成的白名单 HTML（修订、批注、表格），同样在隔离框架中显示
  const isHtml = office || lower.endsWith(".html") || lower.endsWith(".htm");
  const isSheet = !!office && /\.xlsx?$/.test(lower);
  const split = useMemo(() => (isSheet ? splitSheets(text) : null), [isSheet, text]);
  // 选中的表签记着属于哪个文件：换了文件回到第一张，同一文件出新版本时留在原来那张
  const [pick, setPick] = useState<{ file: string; i: number }>({ file: filename, i: 0 });
  const count = split?.sheets.length ?? 0;
  const active = count > 0 ? Math.min(pick.file === filename ? pick.i : 0, count - 1) : 0;
  const docHtml = split && count > 0 ? split.head + split.sheets[active]!.html + split.tail : text;
  const citePrefix = split && active > 0 ? split.sheets.slice(0, active).map((s) => s.html).join("") : "";
  // Word 成果用白色 A4 纸面；Excel 用表格版式
  const srcDoc = useMemo(
    () => (isHtml ? buildPreviewDoc(docHtml, tokenMap, { paper: !!office && !isSheet, sheet: isSheet, ...(cites ? { cites } : {}), ...(citePrefix ? { citePrefix } : {}) }) : ""),
    [isHtml, docHtml, tokenMap, office, isSheet, cites, citePrefix],
  );
  const frameKey = useMemo(() => previewFrameKey(srcDoc), [srcDoc]);
  const [reloads, setReloads] = useState(0);
  if (isHtml) {
    const app = isSheet ? "Excel" : "Word";
    const full = isSheet ? "排版为近似效果：列宽、合并单元格、对齐与数字格式按原文件显示，公式显示保存时的结果；以 Excel 打开为准" : "排版为近似效果，修订以绿色插入、红色删除显示；以 Word 打开为准";
    return (
      <div className={`safe-preview${isSheet ? " sp-is-sheet" : office ? " sp-is-doc" : ""}`}>
        <div className="sp-note">
          {office ? (
            compactNote ? (
              <span title={full}>近似预览 · 以 {app} 打开为准</span>
            ) : (
              <span>预览（{full}）</span>
            )
          ) : compactNote ? (
            <span title="不执行脚本、不加载任何外部资源、链接不可点击">隔离预览</span>
          ) : (
            <span>隔离预览：不执行脚本、不加载任何外部资源、链接不可点击。</span>
          )}
          <button type="button" className="btn-link sp-reload" onClick={() => setReloads((n) => n + 1)} title="预览区没有显示内容时，点这里重新载入">
            重新载入预览
          </button>
        </div>
        {split && count > 0 && (
          <div className="sp-sheets" role="tablist" aria-label="工作表">
            {split.sheets.map((s, i) => {
              const label = sheetLabel(s.name, tokenMap);
              return (
                <button key={i} type="button" role="tab" aria-selected={i === active} className={`sp-sheet${i === active ? " on" : ""}`} title={label} onClick={() => setPick({ file: filename, i })}>
                  {label}
                </button>
              );
            })}
          </div>
        )}
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
