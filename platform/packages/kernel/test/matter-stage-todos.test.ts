/**
 * v9.4 第 20 批：事项的程序阶段、事件时点与地域（S-08；评审 S1 §6.2 第 10 项后半），事项待办（C1 §3.2）。
 * - 阶段、事件时点、地域的入参校验与读写；Agent 的事项口径里带上它们；
 * - 签发前按事件时点复核实体法引用的适用版本（程序法从新不核）、按地域核地方性规定；须律师勾选后才能签发；
 * - 待办：手工待办增改删、完成；从任务与成果推出“AI 已完成待你复核”“待签发”。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openLawdb } from "@zr-legal/lawdb";
import { createDocx } from "@zr-legal/docx-engine";
import { artifactCitationBlock, checkArtifactCitations, CITATIONS_EVENT_TIME_CHECK_KEY, timingNote } from "../src/services/artifact-citations.ts";
import { eventDateRange, isProceduralLaw, matterFactsLine } from "../src/services/matter-facts.ts";
import { decideAllCitations, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: signerPub });

let tk: TestKernel | null = null;
after(async () => {
  await tk?.kernel.close().catch(() => {});
});

test("事件时点：2019 年的事实引民法典须核对；2023 年的不用；没填事件时点不核；只认布尔勾选", () => {
  const text = "依据《民法典》第五百八十五条，违约金可以调整。《劳动合同法》第四十七条规定经济补偿。";
  const none = checkArtifactCitations(lawdb, "备忘录.md", Buffer.from(text), "2026-10-01");
  assert.equal(none.timing, 0, "没填事件时点：不按时点核");
  assert.equal(artifactCitationBlock(none, {})?.code, "support", "C-03：系统核到的引用还要律师逐条决定支持性");

  const old = checkArtifactCitations(lawdb, "备忘录.md", Buffer.from(text), "2026-10-01", { event_date: "2019-05-06" });
  assert.equal(old.verified, 2, "系统核验结果不变");
  assert.equal(old.timing, 1, "只有民法典（2021-01-01 施行）在 2019-05-06 没有有效版本；劳动合同法 2013 版有效");
  const item = old.items.find((i) => i.timing)!;
  assert.match(item.raw, /民法典/);
  assert.match(item.timing!, /2019-05-06/);
  assert.match(item.timing!, /时间效力/);
  assert.doesNotMatch(item.timing!, /还没有施行/, "法规库可能没收早期版本，不说“还没有施行”");
  assert.equal(old.event_date, "2019-05-06");
  assert.equal(artifactCitationBlock(old, {})?.code, "timing");
  assert.equal(artifactCitationBlock(old, { [CITATIONS_EVENT_TIME_CHECK_KEY]: "yes" })?.code, "timing", "只认布尔 true");
  assert.equal(artifactCitationBlock(old, { [CITATIONS_EVENT_TIME_CHECK_KEY]: true })?.code, "support", "时点勾过后到支持性这一项");

  const recent = checkArtifactCitations(lawdb, "备忘录.md", Buffer.from(text), "2026-10-01", { event_date: "2023-05" });
  assert.equal(recent.timing, 0, "只到月也能核：2023-05 民法典已施行");
  // 核对不通过的引用不重复提示（先改正）
  const wrong = checkArtifactCitations(lawdb, "备忘录.md", Buffer.from("《民法典》第一千三百条"), "2026-10-01", { event_date: "2019-05-06" });
  assert.equal(wrong.wrong, 1);
  assert.equal(wrong.timing, 0);
});

test("按时点取版本：版本有变化、旧版没有这一条、只到月且当月内换版、程序法从新、地方性规定看地域", () => {
  const row = (lsv: string, effective: string, superseded: string | null, total: number, extra: Record<string, unknown> = {}) => ({ lsv_id: lsv, effective, superseded, total_articles: total, law_name: "中华人民共和国示例法", ...extra }) as any;
  const fake = (rows: any[]) => ({ findLawVersions: (n: string) => (/示例法|示例条例|民事诉讼法/.test(n) ? rows.map((r) => ({ ...r })) : []) });
  const two = fake([row("v1", "2015-01-01", "2024-07-15", 50), row("v2", "2024-07-15", null, 60)]);
  assert.match(timingNote(two, "示例法", 10, "2026-10-01", "2023-03-01", null)!, /2015-01-01 施行的版本，不是现行版本/);
  assert.match(timingNote(two, "示例法", 55, "2026-10-01", "2023-03-01", null)!, /那一版没有第 55 条/);
  assert.equal(timingNote(two, "示例法", 10, "2026-10-01", "2025-01-01", null), null, "事件时点与现行同一版本");
  assert.match(timingNote(two, "示例法", 10, "2026-10-01", "2024-07", null)!, /当月内这部法规的版本有变化/);
  assert.equal(timingNote(two, "示例法", 10, "2026-10-01", "2024-06", null) !== null, true, "2024-06 整月适用旧版");
  // 程序法从新：民事诉讼法不按事件时点核
  const proc = fake([row("p1", "2017-07-01", "2024-01-01", 284, { law_name: "中华人民共和国民事诉讼法" }), row("p2", "2024-01-01", null, 306, { law_name: "中华人民共和国民事诉讼法" })]);
  assert.equal(timingNote(proc, "民事诉讼法", 128, "2026-10-01", "2019-05-06", null), null);
  assert.equal(isProceduralLaw("中华人民共和国仲裁法"), true);
  assert.equal(isProceduralLaw("最高人民法院关于适用《中华人民共和国民事诉讼法》的解释"), true);
  assert.equal(isProceduralLaw("中华人民共和国民法典"), false);
  // 地域：地方性规定与事项地域不同须核；相同或全国不核
  const local = fake([row("l1", "2020-01-01", null, 40, { law_name: "上海市示例条例", law_region: "上海市" })]);
  assert.match(timingNote(local, "上海市示例条例", 3, "2026-10-01", null, "北京市")!, /上海市的地方性规定，本事项地域是北京市/);
  assert.equal(timingNote(local, "上海市示例条例", 3, "2026-10-01", null, "上海市"), null);
  assert.equal(timingNote(local, "上海市示例条例", 3, "2026-10-01", null, "上海"), null, "简写也算同一地域");
  assert.equal(timingNote(two, "示例法", 3, "2026-10-01", null, "北京市"), null, "没写地域的法规不按地域核");
  assert.deepEqual(eventDateRange("2024-02"), { from: "2024-02-01", to: "2024-02-29", monthOnly: true });
  assert.equal(eventDateRange("2024-13"), null);
  assert.equal(matterFactsLine({ stage: "first_instance", event_date: "2023-05", region: "上海市" }), "；程序阶段=一审；事件时点=2023-05（实体法按此时点取适用版本，程序法按现行版本）；地域=上海市");
  assert.equal(matterFactsLine({}), "");
});

test("事项阶段、事件时点、地域：校验、读写、清空；签发前按事件时点核对并须勾选；签发记录写进核对计数", { timeout: 120_000 }, async () => {
  tk = await makeKernel({}, "stage-firm");
  const { inv, kernel } = tk;
  for (const bad of [{ stage: "trial" }, { event_date: "2023-13" }, { event_date: "2023-02-30" }, { event_date: "20230501" }, { region: "很长很长很长很长很长很长很长很长很长很长的地名" }]) {
    await assert.rejects(inv("matters.create", { title: "坏", stance: "原告", ...bad }), (e: any) => e.code === "validation", JSON.stringify(bad));
  }
  const { matter } = await inv("matters.create", { title: "买卖合同纠纷", stance: "原告", consent_status: "not_required", stage: "first_instance", event_date: "2025-06", region: "上海市" });
  assert.equal(matter.stage, "first_instance");
  assert.equal(matter.event_date, "2025-06");
  assert.equal(matter.region, "上海市");
  const listed = (await inv("matters.list", {})).matters.find((m: any) => m.matter_id === matter.matter_id);
  assert.equal(listed.stage, "first_instance", "列表也带阶段");
  const up = await inv("matters.update", { matter_id: matter.matter_id, patch: { stage: "second_instance", region: "" } });
  assert.equal(up.matter.stage, "second_instance");
  assert.equal(up.matter.region, null, "空串即清空");
  assert.equal(up.matter.event_date, "2025-06", "没给的不动");
  await assert.rejects(inv("matters.update", { matter_id: matter.matter_id, patch: { stage: "nope" } }), (e: any) => e.code === "validation");

  // 测试法规库夹具里《律师法》2017 修正本于 2026-09-01 被 2026 修正本取代：事件在 2025-06，引现行第四十一条须按当时版本核对
  const ident = kernel.identity;
  const bytes = createDocx("意见", [{ heading: "正文", paragraphs: ["依据《律师法》第四十一条，律师应当保密。"] }]);
  const { sha256, storage_uri } = kernel.blobs.put(bytes, matter.matter_id);
  const id = `artv_${randomUUID()}`;
  kernel.db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending_review', ?)`,
    [id, ident.tenantId, matter.matter_id, null, "test_timing", "internal", 1, "意见.docx", sha256, storage_uri, ident.userId],
  );
  const comp = await inv("review.completeness", { artifact_version_id: id });
  assert.equal(comp.completeness.artifact_citations.timing, 1);
  assert.match(comp.completeness.artifact_citations.items[0].timing, /2018-01-01 施行的版本/);
  assert.ok(comp.blockers.some((b: string) => b.includes("事件时点")));
  await assert.rejects(
    () => inv("review.approve", { artifact_version_id: id, decision: "approved", expected_sha256: sha256, checklist: {} }),
    (e: any) => e.code === "unverified_citations" && e.detail?.artifact_citations?.code === "timing",
  );
  assert.equal(await decideAllCitations(inv, id), 1);
  await inv("review.approve", { artifact_version_id: id, decision: "approved", expected_sha256: sha256, checklist: { [CITATIONS_EVENT_TIME_CHECK_KEY]: true } });
  const signed = kernel.db.get<{ signed_payload: string }>(`SELECT signed_payload FROM approvals WHERE artifact_version_id = ? AND decision = 'approved'`, [id])!;
  const cc = JSON.parse(signed.signed_payload).citation_check;
  assert.equal(cc.event_time, 1);
  assert.equal(cc.event_date, "2025-06");

  // 清掉事件时点后不再按时点核
  await inv("matters.update", { matter_id: matter.matter_id, patch: { event_date: null } });
  const id2 = `artv_${randomUUID()}`;
  kernel.db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending_review', ?)`,
    [id2, ident.tenantId, matter.matter_id, null, "test_timing2", "internal", 1, "意见二.docx", sha256, storage_uri, ident.userId],
  );
  assert.equal((await inv("review.completeness", { artifact_version_id: id2 })).completeness.artifact_citations.timing, 0);
});

test("待办：增改删与完成；校验；AI 完成的任务推出“待你复核”，提交复核后变“待签发”；结案后只读", { timeout: 120_000 }, async () => {
  const t2 = await makeKernel({}, "todo-firm");
  try {
    const { inv, kernel } = t2;
    const { matter } = await inv("matters.create", { title: "待办事项", stance: "买方", consent_status: "not_required" });
    const mid = matter.matter_id;
    await assert.rejects(inv("todos.create", { matter_id: mid, title: "" }), (e: any) => e.code === "validation");
    await assert.rejects(inv("todos.create", { matter_id: mid, title: "x", assignee_kind: "boss" }), (e: any) => e.code === "validation");
    await assert.rejects(inv("todos.create", { matter_id: mid, title: "x", due_date: "2026-02-30" }), (e: any) => e.code === "validation");
    const a = (await inv("todos.create", { matter_id: mid, title: "整理补充证据", assignee_kind: "assistant", assignee_name: "小王", reviewer_name: "张律师", due_date: "2026-11-05" })).todo;
    const b = (await inv("todos.create", { matter_id: mid, title: "约客户确认底线" })).todo;
    const c = (await inv("todos.create", { matter_id: mid, title: "提交答辩状", due_date: "2026-11-01" })).todo;
    assert.equal(b.assignee_kind, "me");
    let l = await inv("todos.list", { matter_id: mid });
    assert.deepEqual(l.open.map((x: any) => x.todo_id), [c.todo_id, a.todo_id, b.todo_id], "按期限排，没有期限的在后");
    const done = (await inv("todos.update", { matter_id: mid, todo_id: c.todo_id, patch: { done: true } })).todo;
    assert.equal(done.status, "done");
    assert.ok(done.done_at);
    await inv("todos.update", { matter_id: mid, todo_id: b.todo_id, patch: { reviewer_name: "李律师", due_date: null } });
    await assert.rejects(inv("todos.update", { matter_id: mid, todo_id: b.todo_id, patch: { done: "yes" } }), (e: any) => e.code === "validation");
    await inv("todos.delete", { matter_id: mid, todo_id: a.todo_id });
    await assert.rejects(inv("todos.delete", { matter_id: mid, todo_id: a.todo_id }), (e: any) => e.code === "not_found");
    l = await inv("todos.list", { matter_id: mid });
    assert.deepEqual(l.open.map((x: any) => x.todo_id), [b.todo_id]);
    assert.equal(l.open[0].reviewer_name, "李律师");
    assert.deepEqual(l.done.map((x: any) => x.todo_id), [c.todo_id]);
    // 审计不记待办文字
    const audits = kernel.db.all<{ payload_hash: string | null }>(`SELECT * FROM audit_events WHERE action LIKE 'todo.%'`, []);
    assert.ok(audits.length >= 4);
    assert.ok(!JSON.stringify(audits).includes("约客户确认底线"));

    // 推出的待办：AI 完成的任务有草稿 → 待你复核；提交复核后 → 待签发
    const live = liveTaskIdentity(t2, mid, "todo_run");
    kernel.db.run(`UPDATE runs SET status = 'succeeded', input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "审查采购合同" }), live.rid]);
    const art = (kind: string, status: string) => {
      const bytes = Buffer.from("草稿");
      const { sha256, storage_uri } = kernel.blobs.put(bytes, mid);
      const id = `artv_${randomUUID()}`;
      kernel.db.run(
        `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, live.tid, mid, live.rid, kind, "internal", 1, `${kind}.md`, sha256, storage_uri, status, live.uid],
      );
      return id;
    };
    art("memo", "draft");
    const second = art("letter", "draft");
    l = await inv("todos.list", { matter_id: mid });
    const drafts = l.derived.find((x: any) => x.kind === "drafts_to_review");
    assert.equal(drafts.count, 2);
    assert.equal(drafts.goal, "审查采购合同");
    assert.equal(drafts.done_by_ai, true);
    assert.equal(drafts.run_id, live.rid);
    kernel.db.run(`UPDATE artifact_versions SET status = 'pending_review' WHERE artifact_version_id = ?`, [second]);
    l = await inv("todos.list", { matter_id: mid });
    assert.equal(l.derived.find((x: any) => x.kind === "drafts_to_review").count, 1);
    assert.equal(l.derived.find((x: any) => x.kind === "to_sign").artifact_version_id, second);
    // 等你确认的任务
    kernel.db.run(`UPDATE runs SET status = 'waiting_input' WHERE run_id = ?`, [live.rid]);
    l = await inv("todos.list", { matter_id: mid });
    assert.ok(l.derived.some((x: any) => x.kind === "run_waiting" && x.run_id === live.rid));
    assert.ok(!l.derived.some((x: any) => x.kind === "drafts_to_review"), "任务没完成时不推“待你复核”");
    kernel.db.run(`UPDATE runs SET status = 'succeeded' WHERE run_id = ?`, [live.rid]);
    // 结案后只读
    await inv("matters.close", { matter_id: mid, retention_years: 1 });
    await assert.rejects(inv("todos.create", { matter_id: mid, title: "结案后" }), (e: any) => e.code === "conflict");
    assert.equal((await inv("todos.list", { matter_id: mid })).open.length, 1, "结案后仍可看");
  } finally {
    await t2.kernel.close().catch(() => {});
  }
});

test("Agent 的事项口径带上阶段、事件时点与地域（没填的不写）", async () => {
  const src = readFileSync(repo("packages/kernel/src/executor/executor.ts"), "utf8");
  assert.ok(src.includes("分析截止日=${asOf}${facts}\\n"), "A1 任务的事项口径");
  assert.ok(src.includes("分析截止日=${ctxM.asOf}${ctxM.facts}；场景"), "S1 默认路径的事项口径");
});

test("设提醒时按法定期间推算（deadlines.compute）：与 calc.deadline 同一计算，顺延节假日、只到月给区间", { timeout: 60_000 }, async () => {
  const t3 = await makeKernel({}, "deadline-api-firm");
  try {
    const r = await t3.inv("deadlines.compute", { start: "2025-09-16", period: { unit: "day", n: 15 }, rule: "civil" });
    assert.equal(r.deadline, "2025-10-09", "10 月 1 日届满遇国庆中秋假期（10 月 1—8 日）顺延至 10 月 9 日");
    assert.ok(r.steps.length > 0);
    const m = await t3.inv("deadlines.compute", { start: "2025-09", period: { unit: "day", n: 15 } });
    assert.equal(m.deadline, null);
    assert.ok(m.range);
    await assert.rejects(t3.inv("deadlines.compute", { start: "2025-13-01", period: { unit: "day", n: 15 } }), (e: any) => e.code === "validation");
  } finally {
    await t3.kernel.close().catch(() => {});
  }
});
