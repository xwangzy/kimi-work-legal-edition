/**
 * 第 44 批真实验收（催款律师函任务）：第一次运行出了按 10 日付款期限算的《依据与发送前核对-催款.xlsx》后被额度拦下；
 * 律师点“重新运行”，这一次选了“送达后 7 日”，新出的核对表与律师函都是 7 日。原先旧表仍算在本次成果里：独立复核把它当复核对象、
 * 列为“必须改”，修改轮只改了标题，回看判“未落实”，任务记部分完成；任务页“本次交付的文件”里两张核对表并列。
 *
 * 修复：Agent 从头重跑的那一刻（没有成果检查点）把上一次运行的草稿成果标成“已被取代”、旧提纲撤回、Agent 之后各步的检查点清掉；
 * 内核里“本任务这一次的成果”一律不算被取代的文件。对账后重试（按检查点结算、不重跑 Agent）不经过这里——见 v9-defects R-07。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b44-supersede-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { reviveSuperseded, supersedeEarlierAttempts } from "../src/services/attempt-supersede.ts";
import { chainEditTargets, deliveredBeforeDeadline, fixTargetsOf, primaryDeliverableMissing } from "../src/executor/executor.ts";
import { assertOutlineSettled, latestOutline } from "../src/services/argument-outlines.ts";
import { shrinkCheck } from "../src/services/version-shrink.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b44-supersede-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000" }, "b44-supersede-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const REVIEWER = "现在独立复核";
const OLD_TABLE = "依据与发送前核对-催款";
const NEW_TABLE = "依据与发送前核对-货款催收";

test("重新运行：上一次运行的核对表标成已被取代，不进本次成果、不交给复核；这一次的核对表与律师函照常复核", { timeout: 240_000 }, async () => {
  const marker = "B44SUPERSEDE";
  let failedOnce = false;
  const reviewerSaw: string[] = [];
  cloud.model.script = (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(REVIEWER)) {
      reviewerSaw.push(JSON.stringify(ms));
      return { content: "未发现实质问题" };
    }
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes(marker)) return null;
    const did = (id: string) => ms.some((m) => m.role === "tool" && m.tool_call_id === id);
    // 第一次运行：按 10 日出了核对表，接着上游拒绝（真实验收里是试用额度 402），任务失败
    if (!failedOnce) {
      if (!did("old_tbl")) {
        return { toolCalls: [{ id: "old_tbl", name: "mcp__legal__xlsx_render_table", args: { title: OLD_TABLE, sheets: [{ name: "发送前核对", columns: ["项目", "内容"], rows: [["付款期限", "收到本函后10日内付清（OLD10D）"], ["届满示例", "10月1日送达则10月11日届满（OLD10D）"]] }] } }] };
      }
      failedOnce = true;
      return { status: 400, content: "upstream quota exceeded" };
    }
    // 重新运行：律师这次选了送达后 7 日
    if (!did("new_tbl")) {
      return { toolCalls: [{ id: "new_tbl", name: "mcp__legal__xlsx_render_table", args: { title: NEW_TABLE, sheets: [{ name: "发送前核对", columns: ["项目", "内容"], rows: [["付款期限", "本函送达之日起7日内付清（NEW7D）"]] }] } }] };
    }
    if (!did("letter")) {
      return { toolCalls: [{ id: "letter", name: "mcp__legal__docx_render_report", args: { title: "律师函（草稿）", sections: [{ heading: "律师函", paragraphs: ["贵司拖欠货款人民币30万元，请于本函送达之日起7日内付清（NEW7D）。"] }] } }] };
    }
    return { content: `已起草《律师函（草稿）》与《${NEW_TABLE}》，付款期限为送达后7日。` };
  };
  try {
    const { matter } = await tk.inv("matters.create", {
      title: `重新运行取代 ${marker}`,
      stance: "卖方",
      basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
      model_endpoint: "standard",
    });
    const doc = await importBytes(tk.inv, matter.matter_id, "对账单.txt", Buffer.from("买方欠付货款人民币30万元，合同约定收到催款通知后付款。", "utf8"), "text/plain");
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b44-supersede-${Date.now()}`, goal: `${marker} 给买方发催款律师函`, skill: "demand-letter", document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
    const failed = await waitRun(tk.inv, run.run_id, 100_000);
    assert.equal(failed.run.status, "failed", JSON.stringify(failed.events.map((e: any) => e.type)));
    const oldRow = failed.artifacts.find((a: any) => a.filename === `${OLD_TABLE}.xlsx`);
    assert.ok(oldRow, JSON.stringify(failed.artifacts.map((a: any) => a.filename)));
    assert.equal(oldRow.status, "draft");

    await tk.inv("runs.retry", { run_id: run.run_id, expected_version: failed.run.status_version });
    await new Promise((r) => setTimeout(r, 500));
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types));

    // 上一次的核对表：已被取代（仍在，律师可预览、下载）；这一次的文件：草稿
    const byName = new Map(done.artifacts.map((a: any) => [a.filename, a]));
    assert.equal((byName.get(`${OLD_TABLE}.xlsx`) as any)?.status, "superseded", JSON.stringify(done.artifacts.map((a: any) => [a.filename, a.status])));
    assert.equal((byName.get(`${NEW_TABLE}.xlsx`) as any)?.status, "draft");
    assert.equal((byName.get("律师函（草稿）.docx") as any)?.status, "draft");
    const sup = done.events.find((e: any) => e.type === "run.earlier_superseded");
    assert.ok(sup, JSON.stringify(types));
    assert.equal(sup.payload.count, 1);
    assert.deepEqual(sup.payload.files, [`${OLD_TABLE}.xlsx`]);
    assert.ok(types.indexOf("run.earlier_superseded") < types.lastIndexOf("agent.task_started"), "先标取代、再拉起这一次的助手");

    // 复核对象与文件清单只有这一次的文件
    const started = done.events.find((e: any) => e.type === "review.started");
    assert.ok(started, JSON.stringify(types));
    assert.ok(started.payload.docs.includes(`${NEW_TABLE}.xlsx`) && started.payload.docs.includes("律师函（草稿）.docx"), JSON.stringify(started.payload.docs));
    assert.ok(!started.payload.docs.includes(`${OLD_TABLE}.xlsx`), JSON.stringify(started.payload.docs));
    assert.equal(reviewerSaw.length, 1);
    assert.ok(reviewerSaw[0]!.includes("NEW7D"), "复核人看到这一次的文件");
    assert.ok(!reviewerSaw[0]!.includes("OLD10D") && !reviewerSaw[0]!.includes(OLD_TABLE), "复核人看不到上一次的核对表（内容与文件清单）");
    // 修改轮要改的文件同样只有这一次的
    assert.deepEqual(fixTargetsOf(tk.kernel.db, run.run_id, matter.matter_id).map((t) => t.filename).sort(), [`${NEW_TABLE}.xlsx`, "律师函（草稿）.docx"].sort());
  } finally {
    cloud.model.script = null;
  }
});

/** 一条 a1 任务（不经队列执行，只为登记成果、提纲与检查点）。 */
function seedRun(matterId: string, label: string, snapshot: Record<string, unknown> = { goal: "起草" }): string {
  const runId = `run_${label}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  tk.kernel.db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, input_snapshot, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [runId, tk.kernel.identity.tenantId, matterId, "a1.agent_task", "b44-test", "failed", `idem-${runId}`, JSON.stringify(snapshot), tk.kernel.identity.userId],
  );
  return runId;
}

let seq = 0;
function seedArtifact(matterId: string, runId: string, p: { kind: string; filename: string; status?: string; manifest?: Record<string, unknown> }): string {
  seq += 1;
  const blob = tk.kernel.blobs.put(Buffer.from(`${p.filename}-${runId}-${seq}`), matterId);
  const id = `artv_b44_${seq}_${Date.now()}`;
  const v = tk.kernel.db.get<{ next: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = 'internal'`, [matterId, p.kind])!.next;
  tk.kernel.db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by, lineage)
     VALUES (?,?,?,?,?,?,'internal',?,?,?,?,'[]',?,?,?)`,
    [id, tk.kernel.identity.tenantId, matterId, runId, p.kind, v, p.status ?? "draft", p.filename, blob.sha256, blob.storage_uri, JSON.stringify(p.manifest ?? { tool: "docx.render_report" }), tk.kernel.identity.userId, `run:${runId}|${p.filename}`],
  );
  return id;
}

test("supersedeEarlierAttempts：草稿标成已被取代，律师已提交复核或签发的不动；提纲撤回；只留材料快照的检查点；同内容重出时恢复成草稿", async () => {
  const { matter } = await tk.inv("matters.create", { title: "取代单元", stance: "卖方", consent_status: "not_required" });
  const db = tk.kernel.db;
  const runId = seedRun(matter.matter_id, "unit");
  // 第一次运行时什么都没有：不动、不报
  assert.deepEqual(supersedeEarlierAttempts(db, runId), { files: [], kept: [], outlines: 0, checkpoints: 0 });

  const draftDoc = seedArtifact(matter.matter_id, runId, { kind: "agent_report", filename: "律师函（草稿）.docx" });
  const draftTbl = seedArtifact(matter.matter_id, runId, { kind: "agent_table", filename: `${OLD_TABLE}.xlsx`, manifest: { tool: "xlsx.render_table" } });
  const submitted = seedArtifact(matter.matter_id, runId, { kind: "agent_report", filename: "催款函（草稿）.docx", status: "pending_review" });
  const other = seedRun(matter.matter_id, "other");
  const otherDoc = seedArtifact(matter.matter_id, other, { kind: "agent_report", filename: "别的任务.docx" });
  for (const [id, status, s] of [
    ["ol_b44_p", "proposed", 1],
    ["ol_b44_c", "confirmed", 2],
  ] as const) {
    db.run(`INSERT INTO argument_outlines (outline_id, tenant_id, matter_id, run_id, seq, doc_kind, title, items, status) VALUES (?,?,?,?,?,?,?,?,?)`, [`${id}_${runId}`, tk.kernel.identity.tenantId, matter.matter_id, runId, s + seq * 10, "律师函", "提纲", "[]", status]);
  }
  for (const step of ["load_materials", "facts_timeline", "independent_review"]) db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,?)`, [runId, step, "att_x", "[]"]);

  const r = supersedeEarlierAttempts(db, runId);
  assert.deepEqual(r.files.map((f) => f.artifact_version_id).sort(), [draftDoc, draftTbl].sort());
  assert.deepEqual(r.kept, [{ artifact_version_id: submitted, filename: "催款函（草稿）.docx", status: "pending_review" }]);
  assert.equal(r.outlines, 2);
  assert.equal(r.checkpoints, 2);
  const st = (id: string) => db.get<{ status: string }>(`SELECT status FROM artifact_versions WHERE artifact_version_id = ?`, [id])!.status;
  assert.equal(st(draftDoc), "superseded");
  assert.equal(st(draftTbl), "superseded");
  assert.equal(st(submitted), "pending_review", "律师已提交复核的不替律师撤回");
  assert.equal(st(otherDoc), "draft", "别的任务不受影响");
  assert.deepEqual(db.all<{ step_name: string }>(`SELECT step_name FROM step_checkpoints WHERE run_id = ?`, [runId]).map((x) => x.step_name), ["load_materials"]);
  // 旧的确认不再放行文书工具：这一次要重新提交、重新确认
  assert.equal(latestOutline(db, runId), null);
  assert.doesNotThrow(() => assertOutlineSettled(db, runId));
  const reqRun = seedRun(matter.matter_id, "req", { goal: "起草", skill_requires_outline: true });
  db.run(`INSERT INTO argument_outlines (outline_id, tenant_id, matter_id, run_id, seq, doc_kind, title, items, status) VALUES (?,?,?,?,?,?,?,?,?)`, [`ol_b44_req_${reqRun}`, tk.kernel.identity.tenantId, matter.matter_id, reqRun, 900 + seq, "律师函", "提纲", "[]", "confirmed"]);
  assert.doesNotThrow(() => assertOutlineSettled(db, reqRun), "上一次已确认：放行");
  supersedeEarlierAttempts(db, reqRun);
  assert.throws(() => assertOutlineSettled(db, reqRun), /outline\.submit/, "重新运行后旧确认作废：须重新提交并确认");

  // 再调一次：没有新的草稿，不重复计
  assert.equal(supersedeEarlierAttempts(db, runId).files.length, 0);
  // 同内容重出（按内容去重命中旧行）：恢复成草稿；不是 superseded 的不动
  assert.equal(reviveSuperseded(db, draftTbl), true);
  assert.equal(st(draftTbl), "draft");
  assert.equal(reviveSuperseded(db, submitted), false);
  assert.equal(st(submitted), "pending_review");
});

test("主交付物核对、到时限已交出、同名缩水检查、追问可改的文件：都不算被取代的旧文件", async () => {
  const { matter } = await tk.inv("matters.create", { title: "取代核对", stance: "卖方", consent_status: "not_required" });
  const db = tk.kernel.db;
  const runId = seedRun(matter.matter_id, "check");
  const letter = seedArtifact(matter.matter_id, runId, { kind: "agent_report", filename: "律师函（草稿）.docx", manifest: { tool: "docx.render_report", text_chars: 3000 } });
  const table = seedArtifact(matter.matter_id, runId, { kind: "agent_table", filename: `${OLD_TABLE}.xlsx`, manifest: { tool: "xlsx.render_table" } });
  const primary = "律师函或催告函（草稿）.docx";
  assert.equal(primaryDeliverableMissing(db, runId, primary), null, "取代前：交出了律师函");
  assert.ok(deliveredBeforeDeadline(db, runId, primary));
  assert.equal(chainEditTargets(db, [runId], matter.matter_id).length, 2);
  supersedeEarlierAttempts(db, runId);
  // 这一次还什么都没交：不能拿上一次的律师函算“已交出”
  assert.equal(primaryDeliverableMissing(db, runId, primary)?.primary, "律师函或催告函（草稿）");
  assert.equal(primaryDeliverableMissing(db, runId, "依据与发送前核对.xlsx")?.cause, "no_sheet_output");
  assert.equal(deliveredBeforeDeadline(db, runId, primary), null);
  assert.equal(deliveredBeforeDeadline(db, runId, null), null);
  assert.deepEqual(fixTargetsOf(db, runId, matter.matter_id), []);
  assert.deepEqual(chainEditTargets(db, [runId], matter.matter_id), [], "追问不在被取代的旧文件上改");
  // 这一次重出同名律师函、字数少了很多：不跟上一次（已被取代）的比，不提示缩水
  const again = seedArtifact(matter.matter_id, runId, { kind: "agent_report", filename: "律师函（草稿）.docx", manifest: { tool: "docx.render_report", text_chars: 800 } });
  assert.equal(shrinkCheck(db, runId, "agent_report", "律师函（草稿）.docx", again, 800), null);
  assert.equal(primaryDeliverableMissing(db, runId, primary), null, "这一次交出了律师函");
  void letter;
  void table;
});
