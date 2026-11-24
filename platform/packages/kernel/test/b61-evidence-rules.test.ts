/**
 * 第 61 批（V35，D-264）证据形式规则核对：按证据属性给民事证据规定（2019 修正）的形式规则与法定后果并附条号；
 * 条号逐条对照法规库原文（外部评估 R2：外部技能证明力排序沿用 2001 年旧规则，这里只收可按属性确定判定的规则）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { evidenceRulesCheck } from "../src/tools/tools/evidence-rules.ts";
import { findTool, validateParams } from "../src/tools/registry.ts";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { lawGetArticle } from "../src/tools/tools/law.ts";
import { LAWDB_SHIPPED } from "./helpers.ts";

const signerPub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: signerPub });

test("按属性给提示：复制件无原件、截图、境外公文书证、外文、证人不出庭且有利害关系、对方控制的书证", () => {
  const r = evidenceRulesCheck({
    rows: [
      { name: "对账确认函（复印件）", kind: "书证", original: "复制件无原件" },
      { name: "微信聊天记录截图", kind: "电子数据", carrier: "打印件或截图" },
      { name: "新加坡公司注册证明", kind: "书证", formed: "境外", official_document: true, foreign_language: true },
      { name: "项目经理证言", kind: "证人证言", witness_will_appear: false, witness_interested: true },
      { name: "对方的出入库台账", kind: "书证", held_by: "对方" },
      { name: "送货单原件", kind: "书证", original: "原件" },
    ],
  });
  const arts = (i: number) => r.rows[i]!.hints.map((x) => x.article).join("|");
  assert.match(arts(0), /第九十条第（五）项/);
  assert.match(arts(1), /第十五条第二款/);
  assert.match(arts(2), /第十六条第一款/);
  assert.match(arts(2), /第十七条/);
  assert.match(arts(3), /第六十八条/);
  assert.match(arts(3), /第九十条第（三）项/);
  assert.match(arts(4), /第四十七条/);
  assert.equal(r.rows[5]!.hints.length, 0, "原件书证没有形式问题");
  for (const row of r.rows) for (const x of row.hints) assert.ok(x.for_offering && x.for_challenging);
});

test("提示里的每个条号都能在法规库里取到原文", () => {
  const all = evidenceRulesCheck({
    rows: [
      { name: "a", kind: "书证", original: "复制件无原件", formed: "港澳台", foreign_language: true, held_by: "对方" },
      { name: "b", kind: "视听资料" },
      { name: "c", kind: "电子数据", carrier: "公证保全" },
      { name: "d", kind: "书证", formed: "境外", identity_relation: true },
      { name: "e", kind: "证人证言", witness_will_appear: false, witness_interested: true },
      { name: "f", kind: "当事人陈述" },
    ],
  });
  const nos = new Set<string>();
  for (const row of all.rows) for (const x of row.hints) for (const m of x.article.matchAll(/第([一二三四五六七八九十百]+)条/g)) nos.add(m[1]!);
  assert.ok(nos.size >= 10, [...nos].join(","));
  for (const n of nos) {
    const a = lawGetArticle(lawdb, { law: "最高人民法院关于民事诉讼证据的若干规定", article: `第${n}条`, as_of: "2026-11-24" });
    assert.equal(a.found, true, `第${n}条`);
  }
});

test("工具登记：对 Agent 开放、schema 拒绝未知种类", () => {
  assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes("evidence.rules_check"));
  const schema = findTool("evidence.rules_check")!.inputSchema;
  validateParams(schema, { rows: [{ name: "x", kind: "书证" }] });
  assert.throws(() => validateParams(schema, { rows: [{ name: "x", kind: "传闻" }] }));
  assert.throws(() => evidenceRulesCheck({ rows: [] }), /不能为空/);
});
