// node render-text.mts <file.docx|file.xlsx>：按 Word / Excel 打开时看到的样子输出文字（段首自动编号照显示、表格逐行、修订稿显示接受全部修订后的文字与修订处数）
import { readFileSync } from "node:fs";
const E = "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/v96-b35/platform/packages/docx-engine/src/index.ts";
const { docxListLabels, extractParagraphs, sanitizeDocx, readZipEntries } = await import(E);
const f = process.argv[2]!;
const buf = readFileSync(f);
if (/\.docx$/i.test(f)) {
  const xml = readZipEntries(buf).get("word/document.xml")!.toString("utf8");
  const ins = (xml.match(/<w:ins\b/g) ?? []).length, del = (xml.match(/<w:del\b/g) ?? []).length;
  const comments = readZipEntries(buf).get("word/comments.xml")?.toString("utf8") ?? "";
  if (ins + del > 0) console.log(`[本文件含修订：插入 ${ins} 处、删除 ${del} 处；批注 ${(comments.match(/<w:comment\b/g) ?? []).length} 条。以下为接受全部修订后的文字]`);
  const view = ins + del > 0 ? sanitizeDocx(buf).docx : buf;
  const labels = docxListLabels(view);
  extractParagraphs(view).forEach((p: any, i: number) => { const t = p.text; if (t.trim() || labels[i]) console.log(`${labels[i] ? labels[i] + " " : ""}${t}`); });
  if (comments) for (const m of comments.matchAll(/<w:comment\b[^>]*w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:comment>/g)) console.log(`[批注·${m[1]}] ${m[2].replace(/<[^>]+>/g, "")}`);
} else {
  const z = readZipEntries(buf);
  const ss = (z.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").match(/<si>[\s\S]*?<\/si>/g)?.map((s: string) => s.replace(/<[^>]+>/g, "")) ?? [];
  for (const [name, data] of z) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    console.log(`== ${name}`);
    for (const row of data.toString("utf8").match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const cells = [...row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => { const t = /t="s"/.test(c[1]!) ; const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? "")?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] ?? "")?.[1] ?? ""; return t ? ss[Number(v)] ?? "" : v; });
      console.log(cells.join(" | "));
    }
  }
}
