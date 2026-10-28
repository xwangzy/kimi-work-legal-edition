/**
 * 第 29 批：组件顶层“提前 return”不得写在 hook 之前（源码对照）。
 * 真实走查：开始面板（ScenarioStart）在第 26 批新增的 useState/useEffect 之前 `if (confirm) return <RunSheet …/>`，
 * 一需要发起确认（点“下一步：确认”）整页报错“这个页面出了点问题”（React：Rendered fewer hooks than expected）。
 * 检查口径：组件函数体里两格缩进的语句（顶层语句）——出现在任一 hook 调用之前的 `if (…) return` 都算违规。
 * 另：场景卡指定的主交付物须是方法列出的交付物（第 29 批，尽调“发现与报告”卡）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "../src/lib/scenarios.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsxFiles(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));
}

/** 组件函数（首字母大写的 function）的函数体各行：从声明行到同缩进的右花括号。 */
function components(src: string): { name: string; lines: string[] }[] {
  const lines = src.split("\n");
  const out: { name: string; lines: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export\s+)?(?:default\s+)?function\s+([A-Z]\w*)\s*\(/.exec(lines[i]!);
    if (!m) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j] !== "}") body.push(lines[j++]!);
    out.push({ name: m[1]!, lines: body });
    i = j;
  }
  return out;
}

const HOOK = /^ {2}(?:(?:const|let)\s+[^=]+=\s*)?use[A-Z]\w*\s*[<(]/;
const EARLY = /^ {2}if\s*\(.*\)\s*return\b/;

test("组件顶层没有写在 hook 之前的提前 return", () => {
  const bad: string[] = [];
  for (const f of tsxFiles(SRC)) {
    for (const c of components(readFileSync(f, "utf8"))) {
      const lastHook = c.lines.reduce((at, l, k) => (HOOK.test(l) ? k : at), -1);
      c.lines.forEach((l, k) => {
        if (k < lastHook && EARLY.test(l)) bad.push(`${f.slice(SRC.length)} ${c.name}：${l.trim().slice(0, 80)}`);
      });
    }
  }
  assert.deepEqual(bad, [], "提前 return 须放在全部 hook 之后");
});

// ─── 场景卡的主交付物（第 29 批）：卡上写的 primary 必须是方法前言 outputs 里的一项；是 Word 的，方法须把出 Word 的工具列为必需 ───
function frontmatterList(text: string, key: string): string[] {
  const m = new RegExp(`^\\s{2}${key}:\\s*\\[(.*)\\]\\s*$`, "m").exec(text);
  return m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

test("场景卡指定的主交付物是方法列出的交付物；Word 主交付物的方法把出 Word 的工具列为必需", () => {
  const skillsDir = fileURLToPath(new URL("../../../content/skills/", import.meta.url));
  const withPrimary = SCENARIOS.filter((c) => c.primary);
  assert.ok(withPrimary.some((c) => c.id === "dd-findings" && c.primary === "尽调报告（内部稿）.docx"), "尽调发现与报告的主交付物是报告");
  for (const c of withPrimary) {
    const text = readFileSync(join(skillsDir, c.skill!, "SKILL.md"), "utf8");
    assert.ok(frontmatterList(text, "outputs").includes(c.primary!), `${c.id}：${c.primary} 不在 ${c.skill} 的 outputs 里`);
    if (/\.docx$/i.test(c.primary!)) assert.ok(frontmatterList(text, "tools_required").some((t) => t === "docx.render_report" || t === "docx.revise"), `${c.id}：方法须把出 Word 的工具列为必需`);
  }
  // 审合同的主交付物是意见书（第 29 批：原先第一项是风险卡，只交卡也记“完成”）
  const review = readFileSync(join(skillsDir, "contract-review", "SKILL.md"), "utf8");
  assert.equal(frontmatterList(review, "outputs")[0], "审查意见书（内部稿）.docx");
});

// ─── 开始面板用的估价须是按当前输入算的（第 29 批真实走查：刚选“我方地位”就点“开始分析”，任务说明里没有我方地位）───
test("开始面板：点开始时手里的估价不是按当前输入算的就重算；确认事实为零的提示与 D-155 一致", () => {
  const src = readFileSync(join(SRC, "components", "ScenarioStart.tsx"), "utf8");
  const start = /const start = async \(\) => \{([\s\S]*?)\n  \};/.exec(src)?.[1] ?? "";
  assert.ok(start.includes("prepareStart(matter, value, opts)"), "开始时可重算估价");
  assert.doesNotMatch(start, /=\s*estimate\s*\?\?/, "不能不看输入就沿用去抖算出的估价");
  assert.match(start, /estimateFor\.current/, "按估价对应的输入判断是否过期");
  assert.match(src, /estimateFor\.current = \[matter, value, opts\]/, "估价落地时记下它对应的输入");
  assert.doesNotMatch(src, /AI 只能列出要件框架/, "确认事实为零也照常出矩阵（D-155）");
});
