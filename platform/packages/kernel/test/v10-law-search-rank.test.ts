/**
 * V10 第 36 批：9 部法规扩为全文、另收 6 部后约 2,600 条，单个关键词命中几十条。按 BM25 式打分排序（少见词权重高、同词多次递减、长条文略降权），
 * 律师常查的概念能把对应条文排进前几条（原先同分按法名与条号排，相关条文被挤出前十）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { lawSearch } from "../src/tools/tools/law.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const db = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: signerPub });
const top = (q: string, n = 5) => lawSearch(db, { query: q }).articles.slice(0, n).map((a) => `${a.law_name}#${a.article_no}`);

test("常查概念排进前几条：保证期间、增资优先认缴、委托处理个人信息、预扣利息、一般保证、未届期股权转让", () => {
  const cases: [string, string][] = [
    ["保证期间 没有约定", "中华人民共和国民法典#692"],
    ["增加注册资本 优先 认缴", "中华人民共和国公司法#227"],
    ["委托处理个人信息", "中华人民共和国个人信息保护法#21"],
    ["预先在本金中扣除利息", "最高人民法院关于审理民间借贷案件适用法律若干问题的规定#26"],
    ["保证方式 没有约定 一般保证", "中华人民共和国民法典#686"],
    ["转让已认缴出资但未届出资期限的股权", "中华人民共和国公司法#88"],
  ];
  for (const [q, want] of cases) assert.ok(top(q).includes(want), `${q} → ${top(q).join(" / ")}`);
});
