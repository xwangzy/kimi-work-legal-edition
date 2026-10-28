/**
 * 发给模型的固定文字不被姓名规则误认（v9.4 第 25 批走查发现）：方法正文、方法目录、Agent 档案、工具说明、内核写的提示词框架、
 * 问答系统提示，都和律师的说明、材料一起经出站闸门的事项令牌化器（闸门对所有字符串一律处理，失败关闭）。
 * 规则把其中的普通词认成姓名时（“律师的任务说明”→“任务”、“股东权利”→“权利”、“遇到时告知律师”→“时告知”），
 * 不只这一句被换成〔自然人·…〕，同一请求里所有同样的词都被换掉，并写进事项令牌表、此后每个任务都换——模型读到的指令是坏的。
 * 这里用与闸门同一个令牌化器（空当事人词典）逐份处理，要求没有一处自然人代号；新写的方法或说明触发误认时这里先失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MatterTokenizer } from "@zr-legal/tokenizer";
import { TOOLS } from "../src/tools/registry.ts";
import { agentFollowUpPrompt, agentGoalPrompt, methodPromptLine } from "../src/executor/executor.ts";
import { rulesPromptBlock } from "../src/services/review-rules.ts";
import { prefsPromptLine } from "../src/services/writing-prefs.ts";
import { matterFactsLine } from "../src/services/matter-facts.ts";
import { QA_SYSTEM_PROMPT } from "../src/services/qa-chat.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

/** 与闸门同一个令牌化器（默认识别自然人姓名、空词典）：返回被换成自然人代号的原文。 */
function personHits(text: string): string[] {
  const r = new MatterTokenizer({ matterKey: randomBytes(32) }).tokenize(text);
  return [...new Set(r.entries.filter((e) => e.category === "person").map((e) => e.value))];
}

function mdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (!/^(THIRD_PARTY_LICENSES|dist|node_modules)$/.test(f)) out.push(...mdFiles(p));
    } else if (f.endsWith(".md")) out.push(p);
  }
  return out;
}

/** 工具说明：名称、标题、说明与参数 schema 里的每一段说明文字。 */
function toolTexts(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  const walk = (v: unknown, where: string) => {
    if (typeof v === "string") out.push({ where, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  for (const t of TOOLS) walk({ title: t.title, description: t.description, inputSchema: t.inputSchema }, t.name);
  return out;
}

test("方法正文与参考、Agent 档案：没有一处被认成自然人姓名", () => {
  const files = [...mdFiles(repo("content/skills")), repo("content/agent-profile/legal-agent.md")];
  assert.ok(files.length >= 40, `读到方法与档案文件（${files.length}）`);
  const bad = files.map((f) => ({ f: f.slice(repo("").length), hits: personHits(readFileSync(f, "utf8")) })).filter((x) => x.hits.length > 0);
  assert.deepEqual(bad, [], `这些文字会被换成自然人代号：${bad.map((b) => `${b.f}：${b.hits.join("、")}`).join("；")}`);
});

test("工具说明与参数说明：没有一处被认成自然人姓名", () => {
  const texts = toolTexts();
  assert.ok(texts.length >= TOOLS.length);
  // 整组一起处理（与闸门一样：同一请求里认出的姓名在全文再匹配）
  const hits = personHits(texts.map((x) => x.text).join("\n"));
  assert.deepEqual(hits, [], `工具说明里被认成姓名的：${hits.join("、")}`);
});

test("内核写的提示词框架（事项口径、方法、审查要点、写作偏好、追问）与问答系统提示：没有一处被认成自然人姓名", () => {
  const manifest = JSON.parse(readFileSync(repo("content/skills/dist/skills.manifest.json"), "utf8")) as { skills: { id: string }[] };
  // 第 28 批：事项口径带委托人与相对方（公司名照写）——“委托人=”“相对方=”这几个字不能被认成姓名
  const facts = matterFactsLine({ stage: "first_instance", event_date: "2025-03", region: "上海", client_name: "上海澄明数据科技有限公司", counterparty: "北京远帆信息技术有限公司" });
  const rules = rulesPromptBlock({ rule_set_id: "rs_x", version: 2, title: "采购合同审查要点", sha256: "x", rules: [{ no: 1, topic: "付款", standard: "验收合格后三十日内付款", fallback: "不超过六十日", red_line: "不接受预付全款" }] } as any);
  const prefs = prefsPromptLine({ signature: "本所律师", citation: "short", notes: "段落之间空一行" } as any);
  const texts: string[] = [QA_SYSTEM_PROMPT, rules, prefs];
  for (const s of manifest.skills) {
    const method = methodPromptLine(s.id, { focus: "付款与违约责任" });
    texts.push(agentGoalPrompt({ stance: "买方", jurisdiction: "内地民商事", asOf: "2026-10-23", facts, goal: "审查这份采购合同", methodLine: method, rulesBlock: rules, prefsLine: prefs }));
    texts.push(agentFollowUpPrompt("再看一下违约金", method, true));
  }
  texts.push(agentGoalPrompt({ stance: "原告", jurisdiction: "内地民商事", asOf: "2026-10-23", facts: "", goal: "整理证据", methodLine: methodPromptLine(null, null), rulesBlock: "", prefsLine: "" }));
  const bad = texts.map((t) => personHits(t)).filter((h) => h.length > 0);
  assert.deepEqual(bad, [], `提示词框架里被认成姓名的：${bad.flat().join("、")}`);
});

test("反向：真实的姓名照常换掉（用例的判据认得出自然人代号）", () => {
  assert.deepEqual(personHits("原告：王明，男，汉族。"), ["王明"]);
  // 走查发现的原句：“任务”不再被认成姓名，但同一句里真的姓名照常认出
  assert.deepEqual(personHits("模板与律师的任务说明冲突时，以律师的说明为准。证人李华说明了情况。"), ["李华"]);
});
