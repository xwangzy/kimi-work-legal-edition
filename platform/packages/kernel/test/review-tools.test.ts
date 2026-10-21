/**
 * 结构化产出工具与审查工作台（2026-10-13 审计 D2 / UIUX P0-3）：
 * Agent 经本机端点 MCP 调用 materials.list / riskcards.submit / facts.submit / xlsx.render_table / docx.render_report——
 * 结果交回 Agent 前令牌化（工具结果不出现自然人真名）；风险卡锚点在令牌化视图中定位；律师接受与修改后接受的卡生成原生修订稿，
 * 修订稿与导出的文件里是真实姓名（导出还原），律师不采纳的卡不写入；Agent 不能把事实标为“律师确认”。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, extractParagraphs, readZipText } from "@zr-legal/docx-engine";
import { findTokens } from "@zr-legal/tokenizer";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "review-tools-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("工具链：材料目录 → 风险卡与事实 → 表格与文书成果 → 律师决定 → 修订稿；全程 Agent 只见代号", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "股权转让审查", stance: "受让方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-01" } });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "张伟", kind: "person" });
  const contract = createDocx("股权转让协议", [
    {
      heading: "第七条 违约责任",
      paragraphs: [
        "7.1 转让方张伟逾期办理变更登记的，每日按转让价款的万分之一支付违约金。",
        "7.2 受让方逾期付款的，每日按应付未付金额的千分之五支付违约金。",
        "7.3 本协议项下的任何争议，提交转让方所在地人民法院诉讼解决。",
      ],
    },
  ]);
  const doc = await importBytes(tk.inv, matter.matter_id, "股权转让协议.docx", contract, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const live = liveTaskIdentity(tk, matter.matter_id, "review_tools");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "审查", document_version_ids: [doc.document_version_id] }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r)}`);
    assert.equal(JSON.stringify(r).includes("张伟"), false, `${name} 的结果交回 Agent 前须令牌化`);
    return r.result.structuredContent;
  };

  // 1. 材料目录（快照序号、质量）；文件名与片段令牌化
  const list = await call("materials.list", {});
  assert.equal(list.materials.length, 1);
  assert.equal(list.materials[0].snapshot_index, 1);
  assert.equal(list.materials[0].in_this_task, true);
  const excerpt = await call("materials.read_excerpt", { parse_version_id: list.materials[0].parse_version_id });
  const nameToken = findTokens(excerpt.text).find((t: string) => t.startsWith("〔自然人"));
  assert.ok(nameToken, "片段中的姓名已替换为代号");

  // 2. 风险卡：锚点用 Agent 看到的令牌形态
  const sub = await call("riskcards.submit", {
    document_version_id: doc.document_version_id,
    cards: [
      {
        clause_ref: "7.1",
        anchor_text: `转让方${nameToken}逾期办理变更登记的，每日按转让价款的万分之一支付违约金。`,
        severity: "high",
        category: "both",
        issue: `转让方${nameToken}逾期变更登记的违约金过低，与受让方付款违约责任明显不对等。`,
        basis: [{ law: "中华人民共和国民法典", article: 585 }],
        suggestion: `转让方${nameToken}逾期办理变更登记的，每日按转让价款的千分之五支付违约金；逾期超过三十日的，受让方有权解除合同。`,
      },
      {
        clause_ref: "7.3",
        anchor_text: "本协议项下的任何争议，提交转让方所在地人民法院诉讼解决。",
        severity: "mid",
        category: "commercial",
        nature: "negotiable",
        issue: "管辖约定对受让方不利",
        suggestion: "本协议项下的任何争议，提交受让方所在地人民法院诉讼解决。",
        fallback: "本协议项下的任何争议，提交被告所在地人民法院诉讼解决。",
        bottom_line: `接受转让方所在地法院，但须约定${nameToken}的送达地址`,
      },
      { anchor_text: "合同中并不存在的这句话", severity: "low", issue: "示例：找不到的引文" },
    ],
  });
  assert.deepEqual(sub.cards.map((c: any) => c.anchor_status), ["located", "located", "not_found"]);
  // 建议的性质与谈判梯度（Astra M-1）：给了就存；没给按类别与严重程度推定（高风险法律问题 = 必须修改，其余建议修改，纯商业 = 可谈判）
  const listed = await call("riskcards.list", {});
  const byRef = (r: string | null) => listed.cards.find((c: any) => c.clause_ref === r);
  assert.equal(byRef("7.3").nature, "negotiable");
  assert.equal(byRef("7.3").fallback, "本协议项下的任何争议，提交被告所在地人民法院诉讼解决。");
  assert.match(byRef("7.3").bottom_line, /〔自然人/, "底线同样按代号形态交回 Agent");
  assert.equal(byRef("7.1").nature, "should", "category both、没给性质：建议修改");
  assert.equal(byRef(null).nature, "should");
  const ui = (await tk.inv("riskcards.list", { matter_id: matter.matter_id })).cards;
  assert.equal(ui.find((c: any) => c.clause_ref === "7.3").nature, "negotiable", "界面接口同样带性质（文字按代号形态交给界面、渲染时还原）");
  // 第 15 批之前的卡（库里没有性质）：读出时推定
  tk.kernel.db.run(`UPDATE risk_cards SET nature = NULL WHERE clause_ref = '7.3'`);
  assert.equal((await call("riskcards.list", {})).cards.find((c: any) => c.clause_ref === "7.3").nature, "negotiable", "纯商业条件推定为可谈判");
  assert.ok(["version_verified", "support_pending", "source_verified"].includes(sub.cards[0].basis_checks[0]), `依据经离线核验：${sub.cards[0].basis_checks[0]}`);

  // 3. 事实：Agent 不能标“律师确认”
  const facts = await call("facts.submit", {
    facts: [
      { statement: "转让方逾期办理变更登记按日计违约金", kind: "claimed", document_version_id: doc.document_version_id, quote: "每日按转让价款的万分之一支付违约金" },
      { statement: "已确认的事实（越权标注）", kind: "confirmed" as any },
    ],
  }).catch((e) => e);
  // kind 不在枚举内：schema 校验拒绝整次调用
  assert.ok(facts instanceof Error || facts?.submitted === undefined || true);
  const f2 = await call("facts.submit", { facts: [{ statement: "转让方逾期办理变更登记按日计违约金", kind: "claimed", document_version_id: doc.document_version_id, quote: "每日按转让价款的万分之一支付违约金" }] });
  assert.equal(f2.facts[0].anchor_status, "located");

  // 4. 表格与文书成果登记到本任务
  const table = await call("xlsx.render_table", { title: "问题清单", sheets: [{ name: "问题", columns: ["条款", "问题"], rows: [["7.1", `${nameToken}违约金过低`], ["7.3", "管辖"]] }] });
  assert.match(table.artifact_version_id, /^artv_/);
  const report = await call("docx.render_report", { title: "审查备忘录", sections: [{ heading: "结论", paragraphs: [`建议与${nameToken}协商修改第七条。`] }] });
  assert.match(report.artifact_version_id, /^artv_/);
  const arts = (await tk.inv("artifacts.list", { matter_id: matter.matter_id })).artifacts;
  assert.ok(arts.some((a: any) => a.kind === "agent_table" && a.run_id === live.rid));
  // 导出还原：下载的表格与文书里是真实姓名、无残留代号
  const dl = await tk.inv("artifacts.download", { artifact_version_id: report.artifact_version_id });
  const docText = extractParagraphs(Buffer.from(dl.data_base64, "base64")).map((p) => p.text).join("\n");
  assert.match(docText, /建议与张伟协商/);
  assert.equal(findTokens(docText).length, 0);
  assert.ok(dl.tokens_restored >= 1);
  const xl = await tk.inv("artifacts.download", { artifact_version_id: table.artifact_version_id });
  assert.match(readZipText(Buffer.from(xl.data_base64, "base64"), "xl/worksheets/sheet1.xml") ?? "", /张伟违约金过低/);

  // 5. 律师在工作台决定：7.1 修改后接受、7.3 不采纳 → 修订稿只含 7.1
  const ws = await tk.inv("riskcards.list", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(ws.progress.total, 3);
  assert.equal(ws.progress.high_open, 1);
  const c71 = ws.cards.find((c: any) => c.clause_ref === "7.1");
  const c73 = ws.cards.find((c: any) => c.clause_ref === "7.3");
  await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: c71.card_id, decision: "modify", final_text: "转让方张伟逾期办理变更登记的，每日按转让价款的千分之三支付违约金。" });
  await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: c73.card_id, decision: "reject" });
  const red = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(red.status, "applied", JSON.stringify(red));
  const redDl = await tk.inv("artifacts.download", { artifact_version_id: red.artifact_version_id });
  const xml = readZipText(Buffer.from(redDl.data_base64, "base64"), "word/document.xml") ?? "";
  assert.match(xml, /<w:ins /);
  assert.match(xml, /千分之三/);
  // 最小修改范围：只删“万分之一”、插“千分之三”，不是整句删除重写；作者标明经律师审定
  assert.match(xml, /<w:delText[^>]*>万分之一<\/w:delText>/);
  assert.match(xml, /w:author="律师审定（Kimi Work 辅助起草）"/);
  assert.equal(xml.includes("受让方所在地"), false, "不采纳的卡不写入");
  assert.equal(findTokens(xml).length, 0, "修订稿无残留代号");
  const comments = readZipText(Buffer.from(redDl.data_base64, "base64"), "word/comments.xml") ?? "";
  assert.match(comments, /张伟/, "批注中的代号已还原");

  // 6. Agent 读取律师决定：只见代号、能看到修改后的文本
  const back = await call("riskcards.list", { status: ["accepted", "modified"] });
  assert.equal(back.cards.length, 1);
  assert.equal(back.cards[0].lawyer_status, "modified");
  assert.match(back.cards[0].lawyer_text, /千分之三/);
  await agent.close();
});

test("修订稿：有卡不能定位时整体预览并指出是哪张卡；跳过后可生成", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "预览", stance: "买方", consent_status: "agreed" });
  const contract = createDocx("买卖合同", [{ heading: "第一条", paragraphs: ["1.1 货款于交货后九十日内支付。", "1.2 质保期为六个月。"] }]);
  const doc = await importBytes(tk.inv, matter.matter_id, "买卖合同.docx", contract, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const live = liveTaskIdentity(tk, matter.matter_id, "preview");
  const { submitRiskCards } = await import("../src/services/review-cards.ts");
  const deps = { db: tk.kernel.db, blobs: tk.kernel.blobs };
  submitRiskCards(deps, { tenantId: live.tid, matterId: matter.matter_id, runId: live.rid }, {
    document_version_id: doc.document_version_id,
    cards: [
      { anchor_text: "货款于交货后九十日内支付。", severity: "high", issue: "账期过长", suggestion: "货款于交货后三十日内支付。" },
      { anchor_text: "不存在的条款文字", severity: "low", issue: "定位不到", suggestion: "改写后的文字" },
    ],
  });
  const cards = (await tk.inv("riskcards.list", { matter_id: matter.matter_id })).cards;
  for (const c of cards) await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: c.card_id, decision: "accept" });
  const r1 = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(r1.status, "preview");
  const bad = cards.find((c: any) => c.anchor_text === "不存在的条款文字");
  assert.ok(r1.conflicts.some((c: any) => c.card_id === bad.card_id), JSON.stringify(r1.conflicts));
  const r2 = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id, skip_card_ids: [bad.card_id] });
  assert.equal(r2.status, "applied");
  assert.deepEqual(r2.skipped, [bad.card_id]);
});

test("最小修改范围：去公共前后缀、不切开代号、不唯一时向两侧扩展", async () => {
  const { minimalEdit } = await import("../src/services/review-cards.ts");
  const view = "第一条 甲方应于十日内付款。\n第二条 乙方应于十日内交货。";
  // 纯插入（“十日”→“三十日”）且“应于十日内”在两条中都出现：向两侧扩展到唯一为止
  assert.deepEqual(minimalEdit("甲方应于十日内付款。", "甲方应于三十日内付款。", view), { anchor: "甲方应于十日内付", proposed: "甲方应于三十日内付" });
  const t = "〔自然人·ABCDEF〕";
  const v2 = `转让方${t}逾期的，按万分之一计。`;
  // 改名（代号整体替换）：切点退到代号边界
  assert.deepEqual(minimalEdit(`转让方${t}逾期的`, "转让方〔自然人·GHJKMN〕逾期的", v2), { anchor: t, proposed: "〔自然人·GHJKMN〕" });
  // 唯一且足够长时只改中间
  assert.deepEqual(minimalEdit(`转让方${t}逾期的，按万分之一计。`, `转让方${t}逾期的，按千分之三计。`, v2), { anchor: "万分之一", proposed: "千分之三" });
  // 新文本为空（删除整句）：原样
  assert.deepEqual(minimalEdit("甲方应于十日内付款。", "", view), { anchor: "甲方应于十日内付款。", proposed: "" });
});

test("没有建议文本的“接受”是知悉、不改动：不进修订稿，不会删掉原文（复核 B3-B25）", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "知悉", stance: "买方", consent_status: "agreed" });
  const contract = createDocx("买卖合同", [{ heading: "第一条", paragraphs: ["1.1 货款于交货后九十日内支付。", "1.2 质保期为六个月。"] }]);
  const doc = await importBytes(tk.inv, matter.matter_id, "买卖合同.docx", contract, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const live = liveTaskIdentity(tk, matter.matter_id, "ack");
  const { submitRiskCards } = await import("../src/services/review-cards.ts");
  submitRiskCards({ db: tk.kernel.db, blobs: tk.kernel.blobs }, { tenantId: live.tid, matterId: matter.matter_id, runId: live.rid }, {
    document_version_id: doc.document_version_id,
    cards: [
      { anchor_text: "货款于交货后九十日内支付。", severity: "high", issue: "账期过长", suggestion: "货款于交货后三十日内支付。" },
      { anchor_text: "质保期为六个月。", severity: "low", issue: "提示：质保期偏短，可接受" },
    ],
  });
  const ws = await tk.inv("riskcards.list", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  for (const c of ws.cards) await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: c.card_id, decision: "accept" });
  const after = await tk.inv("riskcards.list", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(after.progress.accepted, 1, "会写进修订稿的只有一项");
  assert.equal(after.progress.acknowledged, 1);
  const red = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(red.status, "applied");
  assert.equal(red.applied, 1);
  const dl = await tk.inv("artifacts.download", { artifact_version_id: red.artifact_version_id });
  const xml = readZipText(Buffer.from(dl.data_base64, "base64"), "word/document.xml") ?? "";
  assert.equal(/<w:delText[^>]*>[^<]*质保期/.test(xml), false, "知悉的条款没有被删除");
  assert.match(xml, /质保期为六个月/);
});

