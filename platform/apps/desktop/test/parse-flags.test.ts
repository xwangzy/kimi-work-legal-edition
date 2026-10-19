/**
 * 解析标记的律师话术（复核 B13-U07）：内核解析器里出现的每个标记都要有对应话术（静态扫描字面量），
 * 材料表不再出现 xlsx_values_only 这类原样标记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PARSE_FLAG_TEXT, parseFlagsText } from "../src/lib/labels.ts";
import { decideMatterTab } from "../src/lib/matter-tab.ts";
import { startMatterFor } from "../src/lib/scenarios.ts";

const kernelSrc = (f: string) => readFileSync(fileURLToPath(new URL(`../../../packages/kernel/src/services/${f}`, import.meta.url)), "utf8");

test("内核解析器发出的每个标记都有律师话术", () => {
  const flags = new Set<string>();
  for (const f of ["parser.ts", "parse-pipeline.ts"]) {
    const src = kernelSrc(f);
    // qualityFlags: [...] 数组里的字面量、flags.add(`前缀:${n}`) 与 new Set([...]) 里的字面量
    for (const m of src.matchAll(/qualityFlags:\s*\[([^\]]*)\]/g)) for (const s of m[1]!.matchAll(/"([a-z_0-9]+)"/g)) flags.add(s[1]!);
    for (const m of src.matchAll(/flags\.add\(\s*[`"]([a-z_0-9]+)/g)) flags.add(m[1]!);
    // new Set([kind === "pdf" ? "pdf_pipeline" : "image_ocr"])：比较对象（=== 之后的字面量）不是标记
    for (const m of src.matchAll(/new Set<string>\(\[([^\]]*)\]/g)) for (const s of m[1]!.matchAll(/(?<!=== )"([a-z_0-9]+)"/g)) flags.add(s[1]!);
    for (const m of src.matchAll(/\? \["([a-z_0-9]+)"\]/g)) flags.add(m[1]!);
  }
  assert.ok(flags.size >= 12, `扫到的标记太少（${[...flags].join(",")}），扫描式可能失效`);
  const missing = [...flags].filter((f) => !/^encoding_?$/.test(f) && PARSE_FLAG_TEXT[f] === undefined);
  assert.deepEqual(missing, []);
});

test("话术：表格、扫描页、编码与未知标记", () => {
  assert.equal(parseFlagsText([]), "已读取");
  assert.equal(parseFlagsText(["plain_text"]), "已读取");
  assert.equal(parseFlagsText(["xlsx_values_only", "xlsx_truncated"]), "已读取：只读了表格里的值，公式没有计算；表格太大，只读了前一部分");
  assert.equal(parseFlagsText(["pdf_pipeline", "scanned_pages:3"]), "已读取：3 页是扫描件（文字是识别出来的）");
  assert.equal(parseFlagsText(["plain_text", "encoding_gb18030"]), "已读取：按 GB18030 编码读取");
  assert.equal(parseFlagsText(["something_new"]), "已读取（有提示）");
  assert.doesNotMatch(parseFlagsText(["v0_crude_docx_parser", "no_page_anchors", "tables_flattened", "comments_revisions_ignored"]), /[a-z_]{4,}/, "不出现工程标记");
});

test("事项页默认标签只定一次（复核 B13-U04）", () => {
  let s = decideMatterTab(null, null, 0, false);
  assert.equal(s.tab, null, "事项还没载入");
  s = decideMatterTab(s.decidedFor, "m1", 0, false);
  assert.equal(s.tab, "materials", "首次载入无材料 → 材料");
  s = decideMatterTab(s.decidedFor, "m1", 1, false);
  assert.equal(s.tab, null, "之后材料数变化不改标签");
  s = decideMatterTab(s.decidedFor, "m2", 3, false);
  assert.equal(s.tab, "board", "换到有材料的事项 → 概览");
  assert.equal(decideMatterTab(null, "m3", 3, true).tab, null, "律师点过标签就不动");
});

test("深链指定的事项不在列表里：不替换成别的事项（复核 B13-U05）", () => {
  const ms = [{ matter_id: "m1", stance: "原告", created_at: "2026-10-01" }];
  assert.deepEqual(startMatterFor("m-closed", ms as any, null, { line: "litigation" } as any), { matterId: null, missing: true });
  assert.deepEqual(startMatterFor("m1", ms as any, null, { line: "litigation" } as any), { matterId: "m1", missing: false });
  assert.equal(startMatterFor(undefined, ms as any, null, { line: "litigation" } as any).missing, false);
});
