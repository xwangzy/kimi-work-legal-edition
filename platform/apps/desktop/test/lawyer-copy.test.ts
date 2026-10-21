/**
 * v9.4 律师层用语门禁（U1 §4 #21）：律师看得到的文字里不出现研发用语。
 * 范围：src 下全部页面、组件与 lib，减去管理员层与技术支持（管理、诊断、律所规则、用量、操作记录、召回评测、成员管理）；
 * 已知不查：多行模板字符串、JSX 里被 {变量} 隔开的文字片段、内核生成的文字（内核另有用例，例如 matters.test 的开始前确认要点）；
 * Connections.tsx 只查律师四个标签（AdminTab 之前）；relay-text.ts 的长说明 syncAlertText 只给管理员看，从 syncAlertSummary 起查。
 * 新加一句带“令牌化、出站、闸门、控制面……”的律师层文案，这条用例会失败——请按 U1 §2.0 词表改写，或确属管理员层时移到上面的范围之外。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** 管理员层与技术支持（允许出现管理员说法与原始技术名）。 */
// Boards.tsx 不排除：事项页“概览”（MatterBoard）就在这个文件里，律师看得到（复核 Q1-25）
const ADMIN_FILES = new Set(["pages/FirmUsage.tsx", "pages/RecallEval.tsx", "components/MembersAdmin.tsx", "lib/firm-usage.ts"]);
/** 同一文件里管理员层从哪里开始（之后的内容不查）。 */
const ADMIN_FROM: Record<string, string> = { "pages/Connections.tsx": "function AdminTab(" };
/** 同一文件里律师层从哪里开始（之前的内容是管理员详情）。 */
const LAWYER_FROM: Record<string, string> = { "lib/relay-text.ts": "export function syncAlertSummary(" };

// 不区分大小写；含本轮清理过的 sha256、OCR（复核 Q1-25）
const BANNED = /令牌化|出站|闸门|内核|控制面|执行域|沙箱|DPAPI|主密钥|吊销|租户|中继|网关|锚点|哈希|证书|指纹|上游|v0|Skill|MCP|Playbook|token|sha256|OCR/i;
/** 已知且有意保留的：开发形态专用提示、网址里的 token 检查原因码映射（键名不是可见文字）。 */
const ALLOW = [
  /开发桥/,
  // 数据去向说明里“加密保存的局限”（折叠，标明建议所内 IT 看）：如实写出 Windows 数据保护的局限，是 Y5 §7.3 要求的披露
  /Windows 数据保护（DPAPI）/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

function visibleTexts(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return [
    ...code.matchAll(/"(?:[^"\\\n]|\\.)*"/g),
    ...code.matchAll(/'(?:[^'\\\n]|\\.)*'/g),
    // 模板字符串只取单行的，并去掉 ${…} 里的代码（变量名不是可见文字）
    ...[...code.matchAll(/`(?:[^`\\\n]|\\.)*`/g)].map((m) => [m[0].replace(/\$\{[^}]*\}/g, "")] as unknown as RegExpMatchArray),
    ...code.matchAll(/>([^<>{}]*[一-鿿][^<>{}]*)</g),
  ].map((m) => m[0]);
}

test("律师层文案不出现研发用语（v9.4 U1 #21）", () => {
  const hits: string[] = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f).split("\\").join("/");
    if (ADMIN_FILES.has(rel) || rel === "api.ts") continue;
    let src = readFileSync(f, "utf8");
    if (ADMIN_FROM[rel]) src = src.slice(0, src.indexOf(ADMIN_FROM[rel]!));
    if (LAWYER_FROM[rel]) src = src.slice(src.indexOf(LAWYER_FROM[rel]!));
    for (const t of visibleTexts(src)) {
      if (!/[一-鿿]/.test(t) || !BANNED.test(t) || ALLOW.some((a) => a.test(t))) continue;
      hits.push(`${rel}：${t.slice(0, 80)}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("门禁本身有效：带研发用语的样本会被拦下（反向对照）", () => {
  assert.ok(visibleTexts('const x = "经出站闸门发出";').some((t) => BANNED.test(t)));
  assert.ok(visibleTexts("<p>控制面不可达</p>").some((t) => BANNED.test(t)));
  assert.equal(visibleTexts('// 注释里的出站闸门不算\nconst y = 1;').some((t) => BANNED.test(t)), false);
  assert.ok(visibleTexts("const z = '文件的 Sha256 校验';").some((t) => BANNED.test(t)), "单引号字符串、不分大小写（复核 Q1-25）");
  assert.ok(visibleTexts("const w = `已用 ocr 识别 ${n} 页`;").some((t) => BANNED.test(t)));
});

test("中文与 Kimi 之间留空格（复核 Q1-16）", () => {
  const hits: string[] = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f).split("\\").join("/");
    for (const t of visibleTexts(readFileSync(f, "utf8"))) if (/[一-鿿]Kimi/.test(t)) hits.push(`${rel}：${t.slice(0, 60)}`);
  }
  assert.deepEqual(hits, []);
});
