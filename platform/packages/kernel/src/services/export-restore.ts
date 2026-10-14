/**
 * 导出时还原代号（v9 第 02 篇 §8.4“令牌只在两个地方还原——界面渲染层与可信文书引擎的导出”）。
 *
 * Agent 写出的成果（最终答复、工作区里的备忘录、表格、Word 文件）都是事项令牌形态，入库时保持原样（成果 hash 绑定令牌形态的字节）；
 * 律师下载或导出到文件夹时，由这里按事项令牌表还原成真实名称与号码：
 * - 文本类（md/txt/csv/json/html）：整篇还原；
 * - Office（docx/xlsx/pptx）：只改正文类部件里的文字（Word 正文、页眉页脚、批注、脚注尾注；Excel 共享字符串与工作表内联字符串；
 *   PowerPoint 幻灯片与备注），替换值按 XML 转义；包内其他部件原样保留；写出仍经 writeZip（去除外取引用）。
 * 代号被拆在两个格式片段里（例如一半加粗）时无法还原：如实计入 unresolved，由界面提示律师核对。
 */
import { readZipEntries, writeZip } from "@zr-legal/docx-engine";
import { findTokens } from "@zr-legal/tokenizer";

export interface RestoreOutcome {
  bytes: Buffer;
  /** 被还原的代号次数。 */
  restored: number;
  /** 未能还原的代号（不在令牌表、登记为冲突，或被格式片段拆开）。 */
  unresolved: string[];
  changed: boolean;
}

type Restore = (text: string) => { text: string; restored: number; unknown: string[] };

const TEXT_EXT = /\.(md|txt|csv|json|html?)$/i;
const OOXML_EXT = /\.(docx|xlsx|pptx)$/i;
/** 正文类部件（只在这些部件里还原文字）。 */
const TEXT_PARTS = /^(?:word\/(?:document|header\d*|footer\d*|comments|footnotes|endnotes)\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|ppt\/slides\/slide\d+\.xml|ppt\/notesSlides\/notesSlide\d+\.xml)$/;

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function restoreArtifactBytes(filename: string, buf: Buffer, restore: Restore): RestoreOutcome {
  if (TEXT_EXT.test(filename)) {
    const text = buf.toString("utf8");
    if (findTokens(text).length === 0) return { bytes: buf, restored: 0, unresolved: [], changed: false };
    const r = restore(text);
    return { bytes: Buffer.from(r.text, "utf8"), restored: r.restored, unresolved: [...new Set(r.unknown)], changed: r.restored > 0 };
  }
  if (!OOXML_EXT.test(filename)) return { bytes: buf, restored: 0, unresolved: [], changed: false };
  let files: Map<string, Buffer>;
  try {
    files = readZipEntries(buf);
  } catch {
    return { bytes: buf, restored: 0, unresolved: [], changed: false };
  }
  let restored = 0;
  const unresolved = new Set<string>();
  let changed = false;
  for (const [name, data] of files) {
    if (!TEXT_PARTS.test(name)) continue;
    const xml = data.toString("utf8");
    const tokens = findTokens(xml);
    if (tokens.length === 0) {
      // 代号被格式片段拆开时整串找不到：去掉标签后再看一次，如实报告
      for (const t of findTokens(xml.replace(/<[^>]+>/g, ""))) unresolved.add(t);
      continue;
    }
    // 逐个代号还原（值按 XML 转义；代号本身不含 XML 特殊字符）
    let out = xml;
    for (const t of tokens) {
      const r = restore(t);
      if (r.restored === 0 || r.text === t) {
        unresolved.add(t);
        continue;
      }
      const n = out.split(t).length - 1;
      out = out.split(t).join(escapeXml(r.text));
      restored += n;
    }
    for (const t of findTokens(out.replace(/<[^>]+>/g, ""))) unresolved.add(t);
    if (out !== xml) {
      files.set(name, Buffer.from(out, "utf8"));
      changed = true;
    }
  }
  if (!changed) return { bytes: buf, restored: 0, unresolved: [...unresolved], changed: false };
  return { bytes: writeZip([...files.entries()].map(([name, data]) => ({ name, data }))), restored, unresolved: [...unresolved], changed: true };
}
