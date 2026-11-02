/**
 * 第 35 批真实走查 R3：law.search 只比对法名，“竞业限制”“解除劳动合同”“违法解除 赔偿金”一律返回空，劳动争议意见书据此认定“法规库未检出”，
 * 准备把三问结论都降为“初步”——而劳动合同法第二十三、二十四、三十九、四十七、八十七条原文就在库里。现在按关键词同时检索条文；
 * citations.verify 的结果写明“支持待判”是正常结果。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { lawSearch } from "../src/tools/tools/law.ts";
import { findTool } from "../src/tools/registry.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const db = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: signerPub });

const nos = (r: ReturnType<typeof lawSearch>, law: string) => r.articles.filter((a) => a.law_name === law).map((a) => a.article_no);
const LCL = "中华人民共和国劳动合同法";

test("按关键词检索条文：竞业限制、严重违反规章制度、违法解除赔偿金、经济补偿都能定位到条", () => {
  assert.deepEqual(nos(lawSearch(db, { query: "竞业限制" }), LCL).slice(0, 2).sort((a, b) => a - b), [23, 24]);
  assert.ok(nos(lawSearch(db, { query: "严重违反用人单位的规章制度" }), LCL).includes(39));
  assert.ok(nos(lawSearch(db, { query: "劳动合同法 违法解除 赔偿金" }), LCL).includes(87), "法名作过滤、其余作关键词");
  assert.ok(nos(lawSearch(db, { query: "经济补偿" }), LCL).includes(47));
  const byName = lawSearch(db, { query: "劳动合同法" });
  assert.equal(byName.results[0]?.law_name, LCL, "只写法名：照旧按法名命中");
  assert.equal(byName.articles.length, 0);
  const none = lawSearch(db, { query: "数据出境安全评估" });
  assert.equal(none.results.length + none.articles.length, 0);
  assert.match(none.note, /换更短的关键词/);
  assert.ok(lawSearch(db, { query: "竞业限制" }).articles.every((a) => a.snippet.length <= 104 && a.effectiveness === "valid"));
});

test("citations.verify 给助手的结果写明“支持待判”是正常结果", async () => {
  const r: any = await findTool("citations.verify")!.invoke({ as_of: "2026-11-02", citations: [{ law: "劳动合同法", article: 39 }] }, { lawdb: db } as any);
  assert.equal(r.summary.support_pending, 1);
  assert.match(r.note, /支持待判.*正常结果.*不是核验失败/);
});
