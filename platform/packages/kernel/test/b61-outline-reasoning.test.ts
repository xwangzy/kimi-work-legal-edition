/**
 * 第 61 批（V35，D-263）论点提纲的要件涵摄与适用方式：依据可写 mode（直接适用 / 参照适用 / 扩张解释 / 类推）、
 * elements（构成要件逐项对应事实或标待证）、exceptions（但书与例外怎么处理）；提交时内核做推理检查并返回给助手，
 * 律师在确认卡上逐项看到哪个要件有事实、哪个待证（外部评估 R3：演绎推理、类比推理、体系解释三节）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { makeKernel, liveTaskIdentity, type TestKernel, LAWDB_SHIPPED } from "./helpers.ts";
import { reasoningChecks, submitOutline, latestOutline, confirmedView, type OutlineItem } from "../src/services/argument-outlines.ts";
import { findTool, validateParams } from "../src/tools/registry.ts";

const signerPub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: signerPub });

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "outline-reasoning-firm");
});
after(async () => {
  await tk.kernel.close();
});

const basis = (o: Partial<OutlineItem["basis"][number]>) => ({ law: "中华人民共和国民法典", article: 577, note: null, check: "support_pending", matched: "中华人民共和国民法典", article_text: "当事人一方不履行合同义务……", demo: false, ...o });

test("推理检查（纯函数）：有事实却没挂、参照适用缺转介条款、行政处罚类推、条文有但书没处理、主要依据没列要件", () => {
  const items: OutlineItem[] = [
    { arg_id: "a1", claim: "被告应支付尾款", facts: [], counter: null, basis: [basis({ elements: [{ element: "合同有效", status: "fact", facts: [] }, { element: "被告未付款", status: "to_prove", facts: [] }] })] },
    { arg_id: "a2", claim: "参照买卖合同确定检验期", facts: [], counter: null, basis: [basis({ article: 620, mode: "referral", elements: [{ element: "x", status: "undisputed", facts: [] }] })] },
    { arg_id: "a3", claim: "比照处罚", facts: [], counter: null, basis: [basis({ mode: "analogy", note: "行政处罚比照", elements: [{ element: "x", status: "undisputed", facts: [] }] })] },
    { arg_id: "a4", claim: "合同解除", facts: [], counter: null, basis: [basis({ article: 563, article_text: "有下列情形之一的，当事人可以解除合同……法律另有规定的除外。", elements: [{ element: "x", status: "undisputed", facts: [] }] })] },
    { arg_id: "a5", claim: "违约金", facts: [], counter: null, basis: [basis({ article: 585 })] },
  ];
  const r = reasoningChecks(items, "民事起诉状");
  assert.ok(r.some((x) => x.startsWith("a1") && x.includes("没挂事实")));
  assert.ok(r.some((x) => x.startsWith("a2") && x.includes("转介条款")));
  assert.ok(r.some((x) => x.startsWith("a3") && x.includes("法定原则")));
  assert.ok(r.some((x) => x.startsWith("a4") && x.includes("但书")));
  assert.ok(r.some((x) => x.startsWith("1 条论点的主要依据没有列要件对照")));
  // 参照适用同时引了转介条款（民法典第四百六十七条）：不报
  const ok = reasoningChecks([{ arg_id: "b1", claim: "无名合同参照买卖", facts: [], counter: null, basis: [basis({ article: 620, mode: "referral", elements: [{ element: "x", status: "undisputed", facts: [] }] }), basis({ article: 467 })] }], "法律研究备忘录");
  assert.ok(!ok.some((x) => x.includes("转介条款")));
});

test("提交与确认版：要件对照挂的事实要在本事项、带回陈述与确认状态；确认版原样带出适用方式与要件；工具 schema 接受新字段", async () => {
  const { matter } = await tk.inv("matters.create", { title: "要件对照", stance: "原告", consent_status: "agreed" });
  const m = matter.matter_id;
  const live = liveTaskIdentity(tk, m, "b61o");
  tk.kernel.db.run(`INSERT INTO matter_facts (fact_id, tenant_id, matter_id, seq, statement, kind, anchor_status, status) VALUES ('fct_b61a', ?, ?, 1, '2024年8月15日被告签署验收单', 'claimed', 'no_document', 'confirmed')`, [live.tid, m]);
  const r = submitOutline({ db: tk.kernel.db, lawdb }, { tenantId: live.tid, matterId: m, runId: live.rid }, {
    doc_kind: "民事上诉状",
    arguments: [
      {
        claim: "买受人签署验收单后未在检验期内提出质量异议，应视为质量符合约定",
        basis: [
          {
            law: "中华人民共和国民法典",
            article: 621,
            mode: "direct",
            elements: [
              { element: "当事人约定检验期限", status: "undisputed" },
              { element: "买受人在检验期限内未通知出卖人", status: "fact", fact_ids: ["fct_b61a"] },
            ],
            exceptions: "第三款出卖人知道或者应当知道瑕疵的除外：材料无此事实",
          },
        ],
      },
    ],
  });
  assert.equal((r as any).reasoning_checks, undefined, JSON.stringify((r as any).reasoning_checks));
  const o = latestOutline(tk.kernel.db, live.rid)!;
  const b = o.items[0]!.basis[0]!;
  assert.equal(b.mode, "direct");
  assert.equal(b.elements?.[1]?.facts[0]?.statement, "2024年8月15日被告签署验收单");
  assert.equal(b.elements?.[1]?.facts[0]?.confirmed, true);
  assert.ok(b.exceptions?.includes("第三款"));
  assert.throws(
    () => submitOutline({ db: tk.kernel.db, lawdb }, { tenantId: live.tid, matterId: m, runId: live.rid }, { doc_kind: "民事上诉状", arguments: [{ claim: "x", basis: [{ law: "中华人民共和国民法典", article: 621, elements: [{ element: "y", status: "fact", fact_ids: ["fct_other"] }] }] }] }),
    /不在本事项/,
  );
  const cv = confirmedView({ ...o, status: "confirmed", decisions: null });
  assert.equal(cv[0]!.basis[0]!.elements?.length, 2);
  const schema = findTool("outline.submit")!.inputSchema;
  validateParams(schema, { doc_kind: "起诉状", arguments: [{ claim: "x", basis: [{ law: "民法典", article: 577, mode: "referral", elements: [{ element: "y", status: "to_prove", fact_ids: [] }], exceptions: "无" }] }] });
  assert.throws(() => validateParams(schema, { doc_kind: "起诉状", arguments: [{ claim: "x", basis: [{ law: "民法典", mode: "guess" }] }] }));
});
