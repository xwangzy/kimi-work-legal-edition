/**
 * 第 56 批（Skills 集成核查 P0-1）：方法参数占位符不再被上游吃成空串。
 *
 * 上游 Kimi Code 加载方法时用 expandSkillParameters 展开正文：对前言 arguments 里的每个名字，把正文里的 `$name` 换成 Skill 工具
 * args 按空白切分的第 i 段，没传 args 就换成空串；另把 `$ARGUMENTS[n]`、`$n`、`$ARGUMENTS` 换成对应段或整串。内核从不让模型给
 * Skill 传 args（参数只写在提示词的“方法参数：k=v”一行），所以正文里的 `$court` 到模型眼里是“受诉法院（``）”。
 * 现在正文一律写“方法参数 `court`”，这里：
 *   1. 按上游同一套规则（下面原样复刻，出处 packages/kap-host/vendor/kap-embed/kap-embed.mjs 第 172562～172589 行 expandSkillParameters、
 *      172590 行 skillArgumentNames、172641 行 tokenizeArgs、172473 行 escapeXmlTags、172675 行 escapeRegExp2；正文取法同 143898 行
 *      parseFrontmatter + 143974 行 parseSkillText 的 body.trim()）对签名包里每个方法做一次“不传 args”的展开，展开前后必须逐字相同；
 *   2. 漂移守护：vendor 文件里仍是这段实现（关键正则逐字在），上游改了这里先红，届时重新复刻；
 *   3. 正文里每个“方法参数 `x`”都在前言 arguments 里声明，并且内核提示词那一行写出的是同一个名字（x=值），且说明了两边怎么对上。
 * 反向对照：环境变量 KWL_SKILLS_DIST 指向改之前的产物目录时，第 1 条应失败（第 56 批实施时做过：33 个方法全部失败，第 3、4 两条红）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { methodPromptLine } from "../src/executor/executor.ts";

const platform = fileURLToPath(new URL("../../../", import.meta.url));
const dist = process.env.KWL_SKILLS_DIST ?? join(platform, "content", "skills", "dist");
const manifest = JSON.parse(readFileSync(join(dist, "skills.manifest.json"), "utf8")) as { skills: { id: string }[] };
const VENDOR = join(platform, "packages", "kap-host", "vendor", "kap-embed", "kap-embed.mjs");

// ---- 上游参照实现（逐行复刻，只加类型）----
function escapeXmlTags(input: string): string {
  return input.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function escapeRegExp2(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  let current2 = "";
  let quote2: string | undefined;
  let hasContent = false;
  for (const char of raw) {
    if (quote2 !== void 0) {
      if (char === quote2) quote2 = void 0;
      else {
        current2 += char;
        hasContent = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote2 = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        out.push(current2);
        current2 = "";
        hasContent = false;
      }
      continue;
    }
    current2 += char;
    hasContent = true;
  }
  if (hasContent) out.push(current2);
  return out;
}
function skillArgumentNames(value: unknown): string[] {
  const isValidName = (name: string) => name.trim() !== "" && !/^\d+$/.test(name);
  if (typeof value === "string") return value.split(/\s+/).filter(isValidName);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && isValidName(item));
}
function expandSkillParameters(body: string, rawArgs: string, context: { skillDir: string; sessionId?: string; argumentNames: string[] }): string {
  const tokens = tokenizeArgs(rawArgs);
  let content = body;
  for (let index = 0; index < (context.argumentNames?.length ?? 0); index++) {
    const name = context.argumentNames?.[index];
    if (name === void 0) continue;
    const escaped = escapeRegExp2(name);
    content = content.replaceAll(new RegExp(`\\$${escaped}(?![\\[\\w])`, "g"), escapeXmlTags(tokens[index] ?? ""));
  }
  content = content
    .replaceAll(/\$ARGUMENTS\[(\d+)\]/g, (_m, indexText: string) => escapeXmlTags(tokens[Number.parseInt(indexText, 10)] ?? ""))
    .replaceAll(/\$(\d+)(?!\w)/g, (_m, indexText: string) => escapeXmlTags(tokens[Number.parseInt(indexText, 10)] ?? ""))
    .replaceAll("$ARGUMENTS", escapeXmlTags(rawArgs));
  const hasArgumentPlaceholder = content !== body;
  content = content.replaceAll("${KIMI_SKILL_DIR}", context.skillDir).replaceAll("${KIMI_SESSION_ID}", context.sessionId ?? "");
  if (!hasArgumentPlaceholder && rawArgs.length > 0) return `${content}\n\nARGUMENTS: ${escapeXmlTags(rawArgs)}`;
  return content;
}
/** 上游 parseFrontmatter：首行是 ---，到下一行 --- 为止是前言，其后是正文；parseSkillText 取 body.trim()。 */
function splitSkill(text: string): { args: string[]; body: string } {
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0]?.trim(), "---");
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  const head = lines.slice(1, close).join("\n");
  const m = /^arguments:\s*\[([^\]]*)\]\s*$/m.exec(head); // 本仓库前言写法：行内数组（YAML flow 序列）
  const args = skillArgumentNames(m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  return { args, body: lines.slice(close + 1).join("\n").trim() };
}
// ---- 参照实现到此 ----

const skills = manifest.skills.map((s) => {
  const file = join(dist, "trusted", "skills", s.id, "SKILL.md");
  return { id: s.id, file, ...splitSkill(readFileSync(file, "utf8")) };
});

test("漂移守护：vendor 里的 expandSkillParameters 仍是参照实现复刻的那一版（上游改了先在这里红）", () => {
  const v = readFileSync(VENDOR, "utf8");
  for (const needle of [
    "function expandSkillParameters(body, rawArgs, context) {",
    "new RegExp(`\\\\$${escaped}(?![\\\\[\\\\w])`, \"g\")",
    "escapeXmlTags(tokens[index] ?? \"\")",
    "content.replaceAll(/\\$ARGUMENTS\\[(\\d+)\\]/g",
    ".replaceAll(/\\$(\\d+)(?!\\w)/g",
    "}).replaceAll(\"$ARGUMENTS\", escapeXmlTags(rawArgs));",
    "const hasArgumentPlaceholder = content !== body;",
    "content = content.replaceAll(\"${KIMI_SKILL_DIR}\", context.skillDir)",
    "function skillArgumentNames(metadata) {",
    "function tokenizeArgs(raw) {",
    "const content = expandSkillParameters(skill.content, rawArgs, {",
    "const content = parsed7.body.trim();",
  ]) assert.ok(v.includes(needle), `vendor 中找不到：${needle}`);
});

test("参照实现自检：旧写法 `$court` 在不传 args 时被吃成空串，传了按位置替换", () => {
  const ctx = { skillDir: "/d", argumentNames: ["court", "preserve"] };
  assert.equal(expandSkillParameters("受诉法院（`$court`）、保全（`$preserve`）", "", ctx), "受诉法院（``）、保全（``）");
  assert.equal(expandSkillParameters("受诉法院（`$court`）", "苏州中院 要", ctx), "受诉法院（`苏州中院`）");
  assert.equal(expandSkillParameters("受诉法院（方法参数 `court`）", "", ctx), "受诉法院（方法参数 `court`）");
  assert.equal(expandSkillParameters("$ARGUMENTS 与 $0", "", ctx), " 与 ");
});

test("不传 args 展开后，每个方法正文与展开前逐字相同（没有参数引用被上游吃掉）", () => {
  assert.ok(skills.length >= 33, `方法数 ${skills.length}`);
  const bad: string[] = [];
  for (const s of skills) {
    const out = expandSkillParameters(s.body, "", { skillDir: "/trusted/skills/" + s.id, argumentNames: s.args });
    if (out !== s.body) {
      const i = [...out].findIndex((ch, k) => ch !== [...s.body][k]);
      bad.push(`${s.id}：第 ${i} 字起不同（${[...s.body].slice(Math.max(0, i - 12), i + 20).join("")}）`);
    }
  }
  assert.deepEqual(bad, [], `${bad.length} 个方法的正文被上游展开改动`);
});

test("正文里的“方法参数 `x`”都在前言声明；内核提示词那一行写的是同一个名字，并说明两边怎么对上", () => {
  const bad: string[] = [];
  let refs = 0;
  for (const s of skills) {
    // “方法参数 `a`、`b`”与“方法参数（`a`、`b`）”两种写法
    for (const m of s.body.matchAll(/方法参数[ （]((?:`[a-z_]+`(?:、|，| 与 )?)+)/g)) {
      for (const n of m[1]!.matchAll(/`([a-z_]+)`/g)) {
        refs++;
        const name = n[1]!;
        if (!s.args.includes(name)) bad.push(`${s.id}：正文引用的方法参数 ${name} 不在 arguments（${s.args.join("、")}）里`);
        const line = methodPromptLine(s.id, { [name]: "某值" });
        if (!line.includes(`方法参数：${name}=某值`)) bad.push(`${s.id}：提示词里没有 ${name}=某值`);
        if (!line.includes("方法正文里写的“方法参数 `") || !line.includes("没列出的方法参数视为律师没填")) bad.push(`${s.id}：提示词没说明正文写法与这一行的对应`);
      }
    }
    // 前言声明了、正文里却还用别的写法引用（比如漏改的 $name）的，上一条用例已经拦住；这里另核正文没有任何 `$小写名`
    if (/\$[a-z_]/.test(s.body)) bad.push(`${s.id}：正文仍有 $ 占位符`);
  }
  assert.ok(refs >= 100, `正文里的方法参数引用 ${refs} 处（改写前是 135 处 $name）`);
  assert.deepEqual(bad, []);
  // 没有方法参数时也写明：正文里写的方法参数一律按律师没填处理
  assert.match(methodPromptLine("contract-draft", null), /本次没有方法参数：方法正文里写的“方法参数 `…`”都视为律师没填/);
  assert.equal(methodPromptLine(null, null), "");
});

test("产物与源文件一致：打包没有改写正文（源文件就是模型看到的写法）", () => {
  if (process.env.KWL_SKILLS_DIST) return; // 反向对照时只比产物
  for (const s of skills) {
    const src = join(platform, "content", "skills", s.id, "SKILL.md");
    assert.ok(existsSync(src), s.id);
    assert.equal(readFileSync(src, "utf8").replace(/\r\n/g, "\n"), readFileSync(s.file, "utf8").replace(/\r\n/g, "\n"), s.id);
  }
});
