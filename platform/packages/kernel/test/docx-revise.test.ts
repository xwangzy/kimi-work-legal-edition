/**
 * 第 28 批：文书交付链路的三处修复。
 * - docx.revise：Agent 经本机端点在律师上传的 Word 原件副本上写修订——令牌形态的锚点按事项令牌表还原；修订稿保留原件版式、
 *   以 w:ins/w:del 显示修改；清洁稿接受全部修订；原件不变；任一锚点不成立整体不写，逐条给出改法；
 * - 论点确认时一并确认事实（outlines.decide 的 confirm_facts）：只确认留下的论点引用的待确认事实，提纲里的事实状态随之刷新；
 * - 主交付物核对（primaryDeliverableMissing）：文书类方法没有任何 Word 文书时给出缺失说明，有 Word 文书或表格类方法不报。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { createStyledDocx, extractParagraphs, readZipEntries, writeZip } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { findTool, legalToolLockProblems } from "../src/tools/registry.ts";
import { primaryDeliverableMissing } from "../src/executor/executor.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "revise-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function agentFor(matterId: string, label: string) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const raw = async (name: string, args: unknown) =>
    (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
  const call = async (name: string, args: unknown) => {
    const r = await raw(name, args);
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r)}`);
    assert.equal(JSON.stringify(r).includes("王建国"), false, `${name} 的结果交回 Agent 前须令牌化`);
    return r.result.structuredContent;
  };
  return { live, raw, call, close: () => agent.close() };
}

const p = (t: string) => ({ kind: "p" as const, runs: [{ text: t }] });
/** 乙方提供的技术服务合同（含表格与自然人联系人），版式由文书引擎生成——修订后须保留表格。 */
function contractDocx(): Buffer {
  return createStyledDocx(
    [
      { kind: "title", text: "技术服务合同" },
      { kind: "table", rows: [[[{ text: "甲方" }], [{ text: "上海澄明数据科技有限公司" }]], [[{ text: "乙方" }], [{ text: "北京远帆信息技术有限公司" }]]] },
      p("乙方项目联系人：王建国。"),
      { kind: "h1", text: "第三条 服务费用及支付方式" },
      p("3.2 甲方应于本合同签订之日起五个工作日内一次性向乙方支付全部服务费用。"),
      { kind: "h1", text: "第四条 验收" },
      p("4.1 甲方应在收到通知后三日内完成验收；逾期未提出书面异议的，视为验收合格。"),
      { kind: "h1", text: "第八条 争议解决" },
      p("8.1 协商不成的，提交乙方所在地有管辖权的人民法院诉讼解决。"),
    ],
    undefined,
    null,
    { mark: false },
  );
}

test("docx.revise 已登记、锁文件一致、对 Agent 开放", () => {
  assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes("docx.revise"));
  assert.ok(findTool("docx.revise"));
  assert.equal(legalToolLockProblems().has("docx.revise"), false, String(legalToolLockProblems().get("docx.revise")));
});

test("在原件上修订：令牌形态锚点还原、修订稿保留表格并显示修订、清洁稿接受全部修订、原件不变", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "技术服务合同修改", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "王建国", kind: "person" });
  const original = contractDocx();
  const doc = await importBytes(tk.inv, matter.matter_id, "技术服务合同（乙方提供稿）.docx", original, DOCX_MIME);
  const a = await agentFor(matter.matter_id, "revise");
  try {
    const list = await a.call("materials.list", {});
    const m = (list.materials ?? list.items ?? []).find((x: any) => x.document_version_id === doc.document_version_id);
    assert.ok(m, `materials.list 给出材料编号：${JSON.stringify(list).slice(0, 300)}`);
    // Agent 看到的联系人姓名是代号：照抄代号作锚点
    const excerpt = await a.call("materials.read_excerpt", { parse_version_id: doc.parse_version_id, char_start: 0, char_end: 400 });
    const token = /〔自然人·[^〕]+〕/.exec(JSON.stringify(excerpt))?.[0];
    assert.ok(token, "材料摘录里的姓名已换成代号");
    const out = await a.call("docx.revise", {
      document_version_id: doc.document_version_id,
      patches: [
        { anchor: "五个工作日内一次性向乙方支付全部服务费用", proposed_text: "五个工作日内向乙方支付服务费用总额的30%；验收合格后支付40%；运维期满后支付30%", comment: "按甲方要求改为分期付款" },
        { anchor: "三日内完成验收；逾期未提出书面异议的，视为验收合格", proposed_text: "十五个工作日内完成验收，验收以甲方书面确认为准" },
        { anchor: "乙方所在地", proposed_text: "甲方住所地" },
        { anchor: `乙方项目联系人：${token}。`, proposed_text: `乙方项目联系人：${token}（变更须提前书面通知甲方）。` },
      ],
    });
    assert.equal(out.status, "applied", JSON.stringify(out));
    assert.equal(out.applied, 4);
    assert.match(out.revision.filename, /（修订稿）\.docx$/);
    assert.match(out.clean.filename, /（清洁稿）\.docx$/);
    const rows = tk.kernel.db.all<{ kind: string; run_id: string }>(`SELECT kind, run_id FROM artifact_versions WHERE run_id = ? ORDER BY kind`, [a.live.rid]);
    assert.deepEqual(rows.map((r) => r.kind), ["revision_clean", "revision_draft"], "两份成果都登记在本任务下");

    const rev = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: out.revision.artifact_version_id })).data_base64, "base64");
    const revXml = readZipEntries(rev).get("word/document.xml")!.toString("utf8");
    assert.match(revXml, /<w:tbl>/, "修订稿保留原件表格");
    assert.match(revXml, /<w:del\b[\s\S]*一次性向乙方支付全部服务费用/, "删除的原文以修订痕迹保留");
    assert.match(revXml, /<w:ins\b[\s\S]*运维期满后支付30%/, "新文字以插入修订显示");
    const revVisible = extractParagraphs(rev).map((x) => x.text).join("\n");
    assert.ok(revVisible.includes("王建国（变更须提前书面通知甲方）"), "代号按令牌表还原为真名");
    assert.match(revXml, /<w:ins\b[^>]*>(?:(?!<\/w:ins>)[\s\S])*（变更须提前书面通知甲方）/, "只标改动的字：姓名照原样保留，插入的是括注");
    assert.equal(/〔自然人·/.test(revXml), false, "交付件不残留代号");

    const clean = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: out.clean.artifact_version_id })).data_base64, "base64");
    const cleanXml = readZipEntries(clean).get("word/document.xml")!.toString("utf8");
    assert.equal(/<w:(ins|del)\b/.test(cleanXml), false, "清洁稿不含修订标记");
    const text = extractParagraphs(clean).map((x) => x.text).join("\n");
    assert.ok(text.includes("验收合格后支付40%") && text.includes("甲方住所地有管辖权"), "清洁稿是修改后的文字");
    assert.equal(text.includes("视为验收合格"), false, "被删的条款不在清洁稿里");
    assert.match(cleanXml, /<w:tbl>/, "清洁稿同样保留表格");

    const orig = tk.kernel.db.get<{ sha256: string }>(`SELECT sha256 FROM document_versions WHERE document_version_id = ?`, [doc.document_version_id])!;
    assert.equal(orig.sha256, doc.sha256, "原件不变");
  } finally {
    await a.close();
  }
});

test("锚点不成立：整体不写、逐条给出改法；段后插入新条款写成插入修订", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "合同修改冲突", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "技术服务合同.docx", contractDocx(), DOCX_MIME);
  const a = await agentFor(matter.matter_id, "revise-bad");
  try {
    const bad = await a.call("docx.revise", {
      document_version_id: doc.document_version_id,
      patches: [
        { anchor: "乙方所在地", proposed_text: "甲方住所地" },
        { anchor: "第九条 这段原文不存在", proposed_text: "x" },
      ],
    });
    assert.equal(bad.status, "not_applied");
    assert.equal(bad.written, false);
    assert.equal(bad.conflicts.length, 1);
    assert.equal(bad.conflicts[0].index, 1);
    assert.match(bad.conflicts[0].fix, /逐字照抄|不在本材料/);
    assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_versions WHERE run_id = ?`, [a.live.rid])!.n, 0, "整体不写");

    const ok = await a.call("docx.revise", {
      document_version_id: doc.document_version_id,
      patches: [{ anchor: "提交乙方所在地有管辖权的人民法院诉讼解决。", proposed_text: "第九条 保密\n9.1 双方对履行本合同知悉的对方商业秘密负有保密义务，本条在合同终止后五年内持续有效。", insert_after: true }],
    });
    assert.equal(ok.status, "applied", JSON.stringify(ok));
    const clean = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: ok.clean.artifact_version_id })).data_base64, "base64");
    const paras = extractParagraphs(clean).map((x) => x.text);
    const at = paras.findIndex((t) => t.includes("提交乙方所在地有管辖权的人民法院诉讼解决"));
    assert.equal(paras[at + 1], "第九条 保密", "新条款插在锚点段之后");
    assert.match(paras[at + 2] ?? "", /^9\.1 双方对履行本合同/);
  } finally {
    await a.close();
  }
});

test("非 Word 材料：返回 not_docx 与改用说明，不写成果", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "文本材料", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "合同.txt", Buffer.from("3.2 甲方应一次性支付全部费用。"), "text/plain");
  const a = await agentFor(matter.matter_id, "revise-txt");
  try {
    const r = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "一次性支付全部费用", proposed_text: "分期支付" }] });
    assert.equal(r.status, "not_applied");
    assert.equal(r.reason, "not_docx");
    assert.match(r.note, /docx\.render_report/);
  } finally {
    await a.close();
  }
});

test("确认论点时一并确认事实：只确认留下的论点引用的待确认事实，提纲里的状态随之刷新", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "买卖合同纠纷", stance: "原告", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  const a = await agentFor(matter.matter_id, "outline-facts");
  try {
    const ins = (id: string, statement: string, status: string) =>
      tk.kernel.db.run(`INSERT INTO matter_facts (fact_id, tenant_id, matter_id, run_id, seq, statement, kind, anchor_status, status) VALUES (?, ?, ?, ?, 1, ?, 'claimed', 'no_document', ?)`, [id, a.live.tid, matter.matter_id, a.live.rid, statement, status]);
    ins("fct_a", "双方于 2025 年 3 月 10 日签订买卖合同", "proposed");
    ins("fct_b", "被告尚欠货款 30 万元", "proposed");
    ins("fct_c", "被告曾提出质量异议", "proposed");
    ins("fct_r", "原告同意延期付款", "rejected");
    const sub = await a.call("outline.submit", {
      doc_kind: "民事起诉状",
      arguments: [
        { claim: "被告应支付剩余货款", basis: [{ law: "民法典", article: 509 }], facts: [{ fact_id: "fct_a" }, { fact_id: "fct_b" }, { fact_id: "fct_r" }] },
        { claim: "质量异议不成立", basis: [{ law: "民法典", article: 509 }], facts: [{ fact_id: "fct_c" }] },
      ],
    });
    const r = await tk.inv("outlines.decide", { matter_id: matter.matter_id, outline_id: sub.outline_id, decisions: [{ arg_id: "a1", keep: true }, { arg_id: "a2", keep: false }], confirm_facts: true });
    assert.equal(r.facts_confirmed, 2, "只确认留下的论点引用的两条待确认事实");
    const st = (id: string) => tk.kernel.db.get<{ status: string }>(`SELECT status FROM matter_facts WHERE fact_id = ?`, [id])!.status;
    assert.deepEqual([st("fct_a"), st("fct_b"), st("fct_c"), st("fct_r")], ["confirmed", "confirmed", "proposed", "rejected"], "删掉的论点的事实不动，已驳回的不翻");
    const got = await a.call("outline.get", {});
    assert.equal(got.status, "confirmed");
    const facts = JSON.stringify(got);
    assert.match(facts, /"fact_id":"fct_a","statement":"[^"]*","confirmed":true/, "助手读确认版时事实已是已确认");
    // 不勾选时不动事实
    const sub2 = await a.call("outline.submit", { doc_kind: "民事起诉状", arguments: [{ claim: "质量异议不成立", basis: [{ law: "民法典", article: 509 }], facts: [{ fact_id: "fct_c" }] }] });
    const r2 = await tk.inv("outlines.decide", { matter_id: matter.matter_id, outline_id: sub2.outline_id, decisions: [{ arg_id: "a1", keep: true }] });
    assert.equal(r2.facts_confirmed, 0);
    assert.equal(st("fct_c"), "proposed");
  } finally {
    await a.close();
  }
});

test("主交付物核对：文书类方法没有 Word 文书 → 缺失说明；有 Word 文书或表格类方法 → 不报", async () => {
  const { matter } = await tk.inv("matters.create", { title: "核对主交付物", stance: "原告", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  const live = liveTaskIdentity(tk, matter.matter_id, "primary");
  const db = tk.kernel.db;
  const art = (kind: string, filename: string) =>
    db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by) VALUES (?,?,?,?,?,1,'internal','draft',?,?,?,'[]','{}',?)`,
      [`art_${Math.random().toString(36).slice(2, 10)}`, live.tid, matter.matter_id, live.rid, kind, filename, "x".repeat(64), "blob://x", live.uid],
    );
  art("agent_table", "提交前核对清单.xlsx");
  art("a1_agent_draft", "草稿-2026-10-28.md");
  const miss = primaryDeliverableMissing(db, live.rid, "民事起诉状（草稿）.docx");
  assert.ok(miss);
  assert.equal(miss.primary, "民事起诉状（草稿）");
  assert.equal(miss.cause, "no_word_output");
  assert.match(miss.note, /没有交出《民事起诉状（草稿）》/);
  assert.equal(primaryDeliverableMissing(db, live.rid, "计算明细.xlsx"), null, "表格类方法不核对 Word");
  assert.equal(primaryDeliverableMissing(db, live.rid, null), null, "没有方法不核对");
  art("a1_workspace_file", "起诉状-工作区.docx");
  assert.equal(primaryDeliverableMissing(db, live.rid, "民事起诉状（草稿）.docx"), null, "工作区里的 Word 文书也算");
});

test("待补占位：复核页列出个数，签发须勾选“已知悉”；没有占位的文件不受影响", { timeout: 60_000 }, async () => {
  const { placeholdersOf } = await import("../src/services/placeholders.ts");
  assert.deepEqual(placeholdersOf("住所：【待填】。签约日【待确认】，违约金【金额待测算确认】，再一个【待填】。【附件一】"), {
    total: 4,
    kinds: [{ text: "【待填】", n: 2 }, { text: "【待确认】", n: 1 }, { text: "【金额待测算确认】", n: 1 }],
  });
  assert.equal(placeholdersOf("【附件一】【注】正文").total, 0, "不带“待”字的方括号不算");
  const { matter } = await tk.inv("matters.create", { title: "占位签发", stance: "原告", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  const live = liveTaskIdentity(tk, matter.matter_id, "ph");
  const { randomUUID } = await import("node:crypto");
  const put = (paras: string[]) => {
    const bytes = createStyledDocx([{ kind: "title", text: "民事起诉状" }, ...paras.map(p)], undefined, null, {});
    const { sha256, storage_uri } = tk.kernel.blobs.put(bytes, matter.matter_id);
    const id = `artv_${randomUUID()}`;
    tk.kernel.db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'pending_review', ?)`,
      [id, tk.kernel.identity.tenantId, matter.matter_id, live.rid, `agent_report_${id.slice(-6)}`, "internal", 1, "民事起诉状.docx", sha256, storage_uri, tk.kernel.identity.userId],
    );
    return { id, sha256 };
  };
  const a = put(["原告：甲公司。住所：【待填】。", "2025 年 3 月 10 日双方签订买卖合同【待确认】。"]);
  const comp = await tk.inv("review.completeness", { artifact_version_id: a.id });
  assert.equal(comp.placeholders.total, 2);
  assert.ok(comp.blockers.some((b: string) => /2 处待补占位/.test(b)));
  await assert.rejects(
    () => tk.inv("review.approve", { artifact_version_id: a.id, decision: "approved", expected_sha256: a.sha256, checklist: {} }),
    (e: any) => e.code === "placeholders_open" && /2 处待补占位/.test(e.message),
  );
  await assert.rejects(() => tk.inv("review.approve", { artifact_version_id: a.id, decision: "approved", expected_sha256: a.sha256, checklist: { placeholders_acknowledged: "yes" } }), (e: any) => e.code === "placeholders_open", "只认布尔 true");
  await tk.inv("review.approve", { artifact_version_id: a.id, decision: "approved", expected_sha256: a.sha256, checklist: { placeholders_acknowledged: true, placeholders: 2 } });
  const b = put(["原告：甲公司。住所：上海市。"]);
  assert.equal((await tk.inv("review.completeness", { artifact_version_id: b.id })).placeholders.total, 0);
  await tk.inv("review.approve", { artifact_version_id: b.id, decision: "approved", expected_sha256: b.sha256, checklist: {} });
});

test("复核页“你来核对”的条目不写工具名（第 28 批，工作准则第 10 条）", async () => {
  const { lawyerWords } = await import("../src/skills-bundle.ts");
  assert.equal(lawyerWords("期限届满日由 calc.deadline 算出并附过程"), "期限届满日由期限计算工具算出并附过程");
  assert.equal(lawyerWords("所有依据都经过 citations.verify；intercepted / unverified_offline 的没有出现在确定性表述中"), "所有依据都经过引用核验；核对未通过或离线未核实的没有出现在确定性表述中");
  assert.equal(lawyerWords("`materials.list` 中的每一份材料都在目录中"), "材料目录中的每一份材料都在目录中");
  // 全部方法的自检条目：抽取后不再含工具名
  const { readdirSync, readFileSync } = await import("node:fs");
  const root = new URL("../../../content/skills/", import.meta.url);
  const tool = /\b(calc|citations|materials|docx|xlsx|facts|riskcards|outline|law|table|rules)\.[a-z_]+\b/;
  for (const id of readdirSync(root)) {
    let text = "";
    try {
      text = readFileSync(new URL(`${id}/SKILL.md`, root), "utf8");
    } catch {
      continue;
    }
    const sec = /## \d+\. 质量自检\n([\s\S]*?)\n## /.exec(text)?.[1] ?? "";
    for (const line of sec.split("\n")) {
      const m = /^\s*-\s*\[[ xX]\]\s*(.+)$/.exec(line);
      if (m) assert.doesNotMatch(lawyerWords(m[1]!), tool, `${id}：${m[1]!.slice(0, 60)}`);
    }
  }
});

test("任务失败给律师看的话（第 28 批模型不可用演练）：通道不可达写“AI 服务暂时连不上”，不露内部原因码", async () => {
  const { agentFailureText } = await import("../src/executor/executor.ts");
  const t = agentFailureText("host_reported_failure", "502 模型通道不可达（已排队或稍后重试）");
  assert.match(t, /^AI 服务暂时连不上（502 模型通道不可达/);
  assert.match(t, /重新运行/);
  assert.equal(t.includes("host_reported_failure"), false);
  assert.match(agentFailureText("host_reported_failure", "材料快照写入失败"), /^任务没有完成：材料快照写入失败/);
  assert.match(agentFailureText("unknown_task", null), /^任务没有完成（unknown_task）/);
  // 第 29 批 429 演练：限流说“繁忙”，不说“连不上”
  assert.match(agentFailureText("host_reported_failure", "429 rate limit exceeded (drill)"), /^AI 服务繁忙（请求太多被限流/);
  // 第 29 批上游不回应演练：超时写明时限与下一步，不露原因码
  const { agentTimeoutText } = await import("../src/executor/executor.ts");
  const t2 = agentTimeoutText("run_deadline_exceeded");
  assert.match(t2, /^任务工作了 25 分钟仍没有完成/);
  assert.match(t2, /重新运行/);
  assert.equal(t2.includes("run_deadline_exceeded"), false);
});

test("试写（dry_run）：返回改到的段落改前与改后的整段文字、不生成文件；漏字一眼可见（第 28 批真实走查：“于本验收合格后”）", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "试写", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "技术服务合同.docx", contractDocx(), DOCX_MIME);
  const a = await agentFor(matter.matter_id, "revise-dry");
  try {
    const r = await a.call("docx.revise", {
      document_version_id: doc.document_version_id,
      dry_run: true,
      patches: [
        { anchor: "合同签订之日起五个工作日内", proposed_text: "验收合格后三十日内" },
        { anchor: "一次性向乙方支付", proposed_text: "向乙方支付" },
        { anchor: "提交乙方所在地有管辖权的人民法院诉讼解决。", proposed_text: "第九条 保密", insert_after: true },
      ],
    });
    assert.equal(r.status, "preview");
    assert.equal(r.written, false);
    const c32 = r.changes.find((x: any) => x.before.includes("3.2"));
    assert.equal(c32.after, "3.2 甲方应于本验收合格后三十日内向乙方支付全部服务费用。", "同一段两处修改合并；漏掉的“本”在改后整段里看得见");
    assert.deepEqual(r.changes.find((x: any) => x.inserted_after)?.inserted_after, ["第九条 保密"]);
    assert.match(r.note, /本/);
    assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_versions WHERE run_id = ?`, [a.live.rid])!.n, 0, "试写不登记成果");
  } finally {
    await a.close();
  }
});

/** 自动编号的合同（第 29 批）：条款号由 numbering.xml 生成（“第三条”“3.2”），段落文字里没有。 */
function autoNumberedDocx(): Buffer {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const num = (ilvl: number) => `<w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr></w:pPr>`;
  const para = (t: string, pPr = "") => `<w:p>${pPr}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const body = [
    para("技术服务合同"),
    para("服务费用及支付方式", num(0)),
    para("本合同服务费用总额为人民币 1,200,000 元。", num(1)),
    para("甲方应于本合同签订之日起五个工作日内一次性向乙方支付全部服务费用。", num(1)),
    para("争议解决", num(0)),
    para("协商不成的，提交乙方所在地有管辖权的人民法院诉讼解决。", num(1)),
  ].join("");
  const files = readZipEntries(createStyledDocx([p("占位")], undefined, null, { mark: false }));
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  files.set(
    "word/numbering.xml",
    Buffer.from(
      `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    ),
  );
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

test("自动编号的合同（第 29 批）：材料文字带条款号；修订锚点、风险卡引文抄进条款号也能定位，修订稿不重复写编号", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "自动编号合同", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "技术服务合同（自动编号）.docx", autoNumberedDocx(), DOCX_MIME);
  const a = await agentFor(matter.matter_id, "revise-autonum");
  try {
    const excerpt = await a.call("materials.read_excerpt", { parse_version_id: doc.parse_version_id, char_start: 0, char_end: 400 });
    const text = String(excerpt.text);
    assert.match(text, /第三条 服务费用及支付方式/, "一级编号写进材料文字");
    assert.match(text, /3\.2 甲方应于本合同签订之日起五个工作日内/, "二级编号写进材料文字");
    assert.match(text, /第四条 争议解决\n4\.1 协商不成的/);

    const out = await a.call("docx.revise", {
      document_version_id: doc.document_version_id,
      patches: [
        { anchor: "3.2 甲方应于本合同签订之日起五个工作日内一次性向乙方支付全部服务费用。", proposed_text: "甲方应于验收合格后三十日内一次性向乙方支付全部服务费用。" },
        { anchor: "乙方所在地", proposed_text: "甲方住所地", paragraph_hint: "4.1" },
      ],
    });
    assert.equal(out.status, "applied", JSON.stringify(out));
    const clean = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: out.clean.artifact_version_id })).data_base64, "base64");
    const paras = extractParagraphs(clean).map((x) => x.text);
    assert.ok(paras.includes("甲方应于验收合格后三十日内一次性向乙方支付全部服务费用。"), `清洁稿：${JSON.stringify(paras)}`);
    assert.equal(paras.some((t) => /^3\.2/.test(t)), false, "编号仍由 Word 自动生成，不写进段落文字");
    assert.ok(paras.includes("协商不成的，提交甲方住所地有管辖权的人民法院诉讼解决。"));

    const sub = await a.call("riskcards.submit", {
      document_version_id: doc.document_version_id,
      cards: [{ clause_ref: "4.1", anchor_text: "4.1 协商不成的，提交乙方所在地有管辖权的人民法院诉讼解决。", severity: "mid", category: "legal", issue: "管辖约定对委托方不利", suggestion: "协商不成的，提交甲方住所地有管辖权的人民法院诉讼解决。" }],
    });
    assert.equal(sub.cards[0].anchor_status, "located", "引文开头的条款号去掉后定位到原文");
    // 工作台原文栏照 Word 显示带编号
    const shown = await tk.inv("materials.text", { document_version_id: doc.document_version_id });
    assert.ok(shown.paragraphs.includes("第三条 服务费用及支付方式"), JSON.stringify(shown.paragraphs));
    assert.ok(shown.paragraphs.includes("3.2 甲方应于本合同签订之日起五个工作日内一次性向乙方支付全部服务费用。"));
  } finally {
    await a.close();
  }
});

test("导出 PDF 的打印页（第 29 批）：与“下载 Word”同一份文件、真名已还原；修订稿拒绝、清洁稿可以", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "导出 PDF", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "王建国", kind: "person" });
  const doc = await importBytes(tk.inv, matter.matter_id, "技术服务合同（乙方提供稿）.docx", contractDocx(), DOCX_MIME);
  const a = await agentFor(matter.matter_id, "print");
  try {
    const out = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "乙方所在地", proposed_text: "甲方住所地" }] });
    assert.equal(out.status, "applied");
    const r = await tk.inv("artifacts.print_html", { artifact_version_id: out.clean.artifact_version_id });
    assert.match(r.filename, /（清洁稿）\.pdf$/);
    assert.match(r.html, /<!doctype html>/);
    assert.ok(r.html.includes("王建国"), "打印页是还原真名后的文件（与下载 Word 同一份）");
    assert.ok(r.html.includes("甲方住所地有管辖权"), "清洁稿的文字");
    assert.equal(/〔自然人·/.test(r.html), false, "不残留代号");
    await assert.rejects(() => tk.inv("artifacts.print_html", { artifact_version_id: out.revision.artifact_version_id }), /清洁稿/, "修订稿不直接导出 PDF");
    const audit = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'artifact.print_pdf'`);
    assert.ok((audit?.n ?? 0) >= 1, "导出留痕");
  } finally {
    await a.close();
  }
});

test("场景卡指定主交付物（第 29 批）：须是方法列出的交付物，写进任务快照；不认识的在发起时拒绝", async () => {
  const { skillSnapshot } = await import("../src/skills-bundle.ts");
  const bundle = { ok: true as const, dir: "", contentSha256: "x", skills: [{ id: "due-diligence", version: "1.2.0", tier: "beta", lines: [], title: "尽调", description: "", tools_required: [], primary_output: "尽调清单.xlsx", outputs: ["尽调清单.xlsx", "尽调报告（内部稿）.docx"] }] };
  assert.equal(skillSnapshot(bundle, "due-diligence", "尽调报告（内部稿）.docx").skill_primary_output, "尽调报告（内部稿）.docx", "卡上指定的覆盖方法缺省的第一项");
  assert.equal(skillSnapshot(bundle, "due-diligence").skill_primary_output, "尽调清单.xlsx", "不指定时用前言第一项");
  assert.equal(skillSnapshot(bundle, "due-diligence", "不存在.docx").skill_primary_output, "尽调清单.xlsx", "不在 outputs 里的不采用");
  // 发起时校验：不认识的主交付物直接拒绝，不创建任务
  const { matter } = await tk.inv("matters.create", { title: "尽调主交付物", stance: "收购方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  await assert.rejects(
    () => tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `dd-bad-${Date.now()}`, goal: "尽调", skill: "due-diligence", primary_output: "不存在的报告.docx", plan_first: true }),
    /主交付物须是这个方法列出的交付物之一/,
  );
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE matter_id = ?`, [matter.matter_id])!.n, 0, "没有创建任务");
});
