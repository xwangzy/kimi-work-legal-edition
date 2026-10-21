/**
 * 阶段 5 复核处置的整链用例（kap-host + 出站闸门 + 云端 v0 mock；不接触真实外部主机）：
 * - 检索确认卡（复核 S5-A02/B01/A06/B11）：“本任务内”只放行改写后的一般性查询（原文放行只能逐条）；手动档不提供“本任务内”；
 *   L3a 卡只有改写后、只能逐条；
 * - 等待律师时宿主退出（复核 S5-B03）：任务离开“等待”并进入终态，确认卡与提问消失，作答接口不再受理；
 * - 律所档位上限（复核 S5-A13）：未设置为“默认”，取值不认识按最严“手动”。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "w1-disp-secret-0123456789abcdef";
import { SoftwareSigner } from "@zr-legal/keys";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readZipEntries } from "@zr-legal/docx-engine";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { kapMatterPolicy, firmPolicyInputOf, localDevPolicyBody } from "../src/index.ts";
import { approvalPolicyOf } from "../src/egress/gate-host.ts";
import { EgressApprovalStore } from "../src/services/egress-approvals.ts";
import { generateKeyPairSync } from "node:crypto";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_w1-disp-firm" });
  tk = await makeKernel(
    { ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_FIRM_MAX_MODE: "auto", ZR_FIRM_L3A_STANDARD_MODEL: "allow" },
    "w1-disp-firm",
  );
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const FULL = { engagement: "confirmed", personal_info: "confirmed", sensitive: "confirmed", subprocessor: "confirmed" };

/** 按目标里的标记脚本化模型：依次发出给定的工具调用，全部有结果后给出答复。 */
function script(marker: string, calls: { id: string; name: string; args: unknown }[]): void {
  cloud.model.script = (body) => {
    const first = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
    if (!first.includes(marker)) return null;
    const answered = new Set(msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    const next = calls.find((c) => !answered.has(c.id));
    return next ? { toolCalls: [next] } : { content: "完成。" };
  };
}

async function start(matterId: string, goal: string, mode: string): Promise<string> {
  const est = await tk.inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [] });
  const run = await tk.inv("runs.start", { matter_id: matterId, estimate_id: est.estimate_id, idempotency_key: `wd-${Date.now()}-${Math.random()}`, goal, mode, plan_first: false });
  return run.run_id;
}

async function nextCard(runId: string, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const it = await tk.inv("runs.interactions", { run_id: runId });
    if (it.approvals.length > 0) return it.approvals[0];
    if (Date.now() > deadline) throw new Error("等不到确认卡");
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("检索确认卡：“本任务内”只放行改写后（原文只能逐条）；手动档不提供“本任务内”；L3a 只有改写后、只能逐条", { timeout: 240_000 }, async () => {
  const { inv } = tk;
  // ① L2 默认档：“本任务内 + 原文”被拒；“本任务内”（缺省改写后）放行本运行内后续含当事人的检索，全部以改写后发出
  const { matter: m1 } = await inv("matters.create", { title: "回购纠纷", stance: "原告", client_name: "孙悦", counterparty: "甲科技有限公司", basis: FULL });
  script("WDTASK", [
    { id: "s1", name: "WebSearch", args: { query: "甲科技有限公司 股权回购 判例" } },
    { id: "s2", name: "WebSearch", args: { query: "甲科技有限公司 增资 对赌" } },
  ]);
  const r1 = await start(m1.matter_id, "WDTASK 研究回购义务", "default");
  const c1 = await nextCard(r1);
  assert.equal(c1.kind, "search");
  assert.deepEqual(c1.scope_options, ["once", "task"]);
  assert.equal(c1.task_variant, "generalized");
  await assert.rejects(inv("runs.approve", { run_id: r1, approval_id: c1.approval_id, object_hash: c1.object_hash, nonce: c1.nonce, decision: "approve", scope: "task", variant: "original" }), /只能按改写后/);
  await inv("runs.approve", { run_id: r1, approval_id: c1.approval_id, object_hash: c1.object_hash, nonce: c1.nonce, decision: "approve", scope: "task" });
  const d1 = await waitRun(inv, r1, 120_000);
  assert.equal(d1.run.status, "succeeded", JSON.stringify(d1.events.map((e: any) => e.type)));
  const qs = cloud.search.calls.map((c) => c.query).filter((q) => q.includes("回购") || q.includes("对赌"));
  assert.equal(qs.length >= 2, true, JSON.stringify(cloud.search.calls));
  assert.ok(qs.every((q) => !q.includes("甲科技")), `“本任务内”只发改写后的查询：${JSON.stringify(qs)}`);

  // ② 手动档：确认卡只提供“本次”
  const { matter: m2 } = await inv("matters.create", { title: "手动档事项", stance: "原告", counterparty: "乙商贸有限公司", basis: FULL });
  script("WDMANUAL", [{ id: "m1", name: "WebSearch", args: { query: "乙商贸有限公司 买卖合同" } }]);
  const r2 = await start(m2.matter_id, "WDMANUAL 研究", "manual");
  const c2 = await nextCard(r2);
  assert.deepEqual(c2.scope_options, ["once"], "手动档不提供“本任务内允许”（第 02 篇 §9.3）");
  await inv("runs.approve", { run_id: r2, approval_id: c2.approval_id, object_hash: c2.object_hash, nonce: c2.nonce, decision: "reject" });
  await waitRun(inv, r2, 120_000);

  // ③ L3a：卡片只有改写后、只能逐条；原文变体被拒；改写后逐条放行
  const { matter: m3 } = await inv("matters.create", { title: "高敏事项", stance: "原告", counterparty: "丙投资有限公司", confidentiality: "high", basis: FULL });
  script("WDL3A", [{ id: "l1", name: "WebSearch", args: { query: "丙投资有限公司 股东出资" } }]);
  const r3 = await start(m3.matter_id, "WDL3A 研究", "default");
  const c3 = await nextCard(r3);
  assert.deepEqual(c3.variants, ["generalized"]);
  assert.deepEqual(c3.scope_options, ["once"]);
  await assert.rejects(inv("runs.approve", { run_id: r3, approval_id: c3.approval_id, object_hash: c3.object_hash, nonce: c3.nonce, decision: "approve", scope: "once", variant: "original" }), /该变体不可用/);
  await assert.rejects(inv("runs.approve", { run_id: r3, approval_id: c3.approval_id, object_hash: c3.object_hash, nonce: c3.nonce, decision: "approve", scope: "task" }), /只能逐次/);
  await inv("runs.approve", { run_id: r3, approval_id: c3.approval_id, object_hash: c3.object_hash, nonce: c3.nonce, decision: "approve", scope: "once", variant: "generalized" });
  const d3 = await waitRun(inv, r3, 120_000);
  assert.equal(d3.run.status, "succeeded", JSON.stringify(d3.events.map((e: any) => e.type)));
  assert.ok(!cloud.search.calls.some((c) => c.query.includes("丙投资")), "L3a 只发改写后的查询");
  cloud.model.script = null;
});

test("等待律师时宿主退出：任务离开“等待”并进入终态；确认卡与提问消失；作答接口不再受理（复核 S5-B03）", { timeout: 180_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "宿主退出", stance: "原告", basis: FULL });
  script("WDEXIT", [{ id: "q1", name: "AskUserQuestion", args: { questions: [{ question: "按哪方立场？", header: "立场", options: [{ label: "原告", description: "" }, { label: "被告", description: "" }], multi_select: false }] } }]);
  const runId = await start(matter.matter_id, "WDEXIT 起草", "default");
  let q: any = null;
  for (let i = 0; i < 300 && !q; i++) {
    const it = await inv("runs.interactions", { run_id: runId });
    q = it.questions[0] ?? null;
    if (!q) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(q, "应出现提问");
  assert.equal((await inv("runs.get", { run_id: runId })).run.status, "waiting_input");
  // 模拟宿主崩溃：结束本进程拉起的 kap-host 子进程
  const ps = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  const pids = ps
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && Number(f[1]) === process.pid && f.slice(2).join(" ").includes("kap-host/src/main.ts"))
    .map((f) => Number(f[0]));
  assert.ok(pids.length >= 1, "找到 kap-host 子进程");
  for (const pid of pids) process.kill(pid, "SIGKILL");
  const done = await waitRun(inv, runId, 60_000);
  assert.ok(["failed", "timed_out", "cancelled"].includes(done.run.status), `应进入终态而不是停在等待：${done.run.status}`);
  const it = await inv("runs.interactions", { run_id: runId });
  assert.deepEqual([it.approvals.length, it.questions.length], [0, 0], "陈旧的卡片与提问已清除");
  await assert.rejects(inv("runs.answer", { run_id: runId, question_id: q.question_id, answers: {} }), /不存在|已处理/);
  cloud.model.script = null;
});

test("律所档位上限（开发形态的本机配置项）：未设置为“默认”（自动档须律所明示开启）；取值不认识按最严“手动”（复核 S5-A13）", async () => {
  const mid = (await tk.inv("matters.create", { title: "档位上限", stance: "原告", basis: FULL })).matter.matter_id;
  const firm = (env: NodeJS.ProcessEnv) => firmPolicyInputOf(localDevPolicyBody(env));
  assert.equal(kapMatterPolicy(tk.kernel.db, mid, firm({})).maxMode, "default");
  assert.equal(kapMatterPolicy(tk.kernel.db, mid, firm({ ZR_FIRM_MAX_MODE: "autoo" })).maxMode, "manual");
  assert.equal(kapMatterPolicy(tk.kernel.db, mid, firm({ ZR_FIRM_MAX_MODE: "auto" })).maxMode, "auto");
  assert.deepEqual(kapMatterPolicy(tk.kernel.db, mid, firm({ ZR_FIRM_MAX_MODE: "auto" })).allowedPreauthorizations, ["search_generalized"]);
});

test("当事人拒绝云端处理的记录按当事人限制（L3b）处理：运行策略、事项视图、估价与问答一致；联网检索不可用（复核 S5-A15）", { timeout: 60_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "拒绝云端·私有模型", stance: "原告", counterparty: "戊建材有限公司", consent_status: "refused", model_endpoint: "private" });
  assert.equal(kapMatterPolicy(tk.kernel.db, matter.matter_id, firmPolicyInputOf(localDevPolicyBody({ ZR_FIRM_MAX_MODE: "auto" }))).dataLevel, "L3b", "宿主运行策略：L3b（检索被宿主策略拒绝）");
  const got = await inv("matters.get", { matter_id: matter.matter_id });
  assert.equal(got.matter.data_level, "L3b");
  assert.equal(got.matter.basis_complete, true, "只拒绝云端时可用律所私有端点推理（第 02 篇 §8.2 L3b 行）");
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  assert.match(est.data_where.preview, /律所自己的 AI/);
  assert.match(est.data_where.preview, /不联网检索（客户要求不上云）/);
  // 无事项问答：命中该事项当事人按 L3b 拦截
  const r = await inv("chat.send", { text: "戊建材有限公司的买卖合同违约金怎么算？" });
  assert.equal(r.blocked?.reason, "l3b_party");
  // 所内节点（律所执行器原型）：当事人限制的事项不授权、不转交（复核 A 范围外观察）
  await assert.rejects(inv("matters.node_authorize", { matter_id: matter.matter_id }), /当事人限制（L3b）/);
});

test("只改端点时复核“不适用”的约束：私有端点下“转委托与次处理者”为不适用，改成标准端点后自动改为待确认、依据不再齐备（复核 S5-A16）", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", {
    title: "端点变更",
    stance: "原告",
    model_endpoint: "private",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "not_applicable" },
  });
  assert.equal(matter.basis_complete, true);
  const r = await inv("matters.update", { matter_id: matter.matter_id, patch: { model_endpoint: "standard" } });
  assert.equal(r.matter.basis.subprocessor, "pending");
  assert.equal(r.matter.basis_complete, false);
  assert.match(r.note, /转委托与次处理者.*待确认/);
});

test("先出计划：计划卡经内核 runs.interactions 呈现，律师批准后才执行（复核 S5-A14；收敛 D-03 的整链证据）", { timeout: 180_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "先出计划", stance: "原告", basis: FULL });
  const planPath = (body: Record<string, unknown>): string | null => {
    const m = /(\/[^\s"\\]+\/plans\/[A-Za-z0-9._-]+\.md)/.exec(JSON.stringify(body.messages ?? []));
    return m ? m[1]! : null;
  };
  let afterPlan = 0;
  cloud.model.script = (body) => {
    const first = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("WDPLAN")) return null;
    const answered = new Set(msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    if (!answered.has("pl_write")) return { toolCalls: [{ id: "pl_write", name: "Write", args: { path: planPath(body) ?? "/nonexistent/plan.md", content: "# 计划\n1. 检索出资责任裁判\n2. 起草要点\n" } }] };
    if (!answered.has("pl_exit")) return { toolCalls: [{ id: "pl_exit", name: "ExitPlanMode", args: { options: [{ label: "按计划执行" }] } }] };
    afterPlan += 1;
    return { content: "已按计划完成。" };
  };
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `wd-plan-${Date.now()}`, goal: "WDPLAN 研究出资责任", mode: "default", plan_first: true });
  const card = await nextCard(run.run_id, 90_000);
  assert.equal(card.kind, "plan");
  assert.match(String(card.preview.plan ?? ""), /检索出资责任裁判/);
  assert.deepEqual(card.scope_options, ["once"]);
  assert.equal(afterPlan, 0, "计划获批前不执行");
  await inv("runs.approve", { run_id: run.run_id, approval_id: card.approval_id, object_hash: card.object_hash, nonce: card.nonce, decision: "approve", scope: "once" });
  const done = await waitRun(inv, run.run_id, 120_000);
  assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => e.type)));
  assert.ok(afterPlan >= 1, "计划获批后执行");
  cloud.model.script = null;
});

test("四项依据只有一项待确认：开放任务与审合同的真实运行零出站（复核 S5-A14）", { timeout: 180_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", {
    title: "一项待确认",
    stance: "受让方",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "pending" },
  });
  assert.equal(matter.basis_complete, false);
  const meter0 = cloud.gatewayMeter.length;
  const search0 = cloud.search.calls.length;
  // 开放任务：模型请求与检索都不出站（闸门按四项拒绝）
  cloud.model.script = null;
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  assert.equal(est.data_where.start_blocked, true, "界面禁用“确认发起”");
  // 内核发起时同样拒绝（复核 C-B13：界面禁用之外的第二层；闸门按四项拒绝出站是第三层，见 gate 用例）
  await assert.rejects(
    inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `wd-pend-${Date.now()}`, goal: "研究出资责任", mode: "default", plan_first: false }),
    (e: any) => e.code === "validation" && e.detail?.start_blocked === true && /四项依据/.test(e.message),
  );
  // 审合同（确定性工作流）：内核前置检查按四项拦截，列出待确认项
  const doc = await inv("materials.import", { matter_id: matter.matter_id, filename: "协议.txt", data_base64: Buffer.from("股权转让协议\n第七条 保密。", "utf8").toString("base64"), mime: "text/plain" });
  const est2 = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] });
  const run2 = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est2.estimate_id, idempotency_key: `wd-pend2-${Date.now()}` });
  const d2 = await waitRun(inv, run2.run_id, 120_000);
  assert.equal(d2.run.status, "failed");
  assert.match(String(d2.events.find((e: any) => e.type === "run.failed")?.payload.error ?? ""), /四项依据有“待确认”（转委托与次处理者）/);
  // 审合同的运行没有发出任何内容（开放任务在发起时已被拒绝）
  const sent = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM egress_records WHERE run_id = ? AND outcome = 'sent'`, [run2.run_id])!.n;
  assert.equal(sent, 0, "零出站记录");
  assert.equal(cloud.gatewayMeter.length, meter0, "网关零请求");
  assert.equal(cloud.search.calls.length, search0, "检索服务零请求");
});

test("对外口径与行为一致（第 06 篇 T20；复核 S5-A01/A14）：“中软看得到什么”、告知函与估价预览对检索的写法一致（逐条确认后可按原文发出、保留机构当事人名称）", async () => {
  const { inv } = tk;
  const CORE = "逐条确认，确认后可按原文发出（保留机构当事人名称；已识别的自然人姓名与证件、账号不发出）";
  const conn = readFileSync(fileURLToPath(new URL("../../../apps/desktop/src/pages/Connections.tsx", import.meta.url)), "utf8");
  assert.equal(conn.split(CORE).length - 1, 3, "设置的“资料来源”、律师版“数据去向说明”与“管理 → 诊断”的技术版去向表三处");
  const { matter } = await inv("matters.create", { title: "口径", stance: "原告", client_name: "己公司", basis: FULL });
  const notice = await inv("matters.consent_notice", { matter_id: matter.matter_id });
  const dl = await inv("artifacts.download", { artifact_version_id: notice.artifact_version_id });
  const xml = readZipEntries(Buffer.from(dl.data_base64, "base64")).get("word/document.xml")!.toString("utf8");
  assert.ok(xml.includes(`经办律师${CORE}`), "告知函");
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  assert.ok(String(est.data_where.preview).includes(CORE), "估价预览");
  assert.ok(!conn.includes("经你逐条确认"), "可截图给客户的页面不用“你”指代律师（复核 S5-A17）");
});

test("审批策略指纹（复核 S5-B18）：当事人词典与事项头当事人的增改不使批准失效；密级、依据、端点等审批相关字段变化才使指纹改变并作废批准", async () => {
  const { inv } = tk;
  const db = tk.kernel.db;
  const { matter } = await inv("matters.create", { title: "指纹", stance: "原告", client_name: "庚公司", basis: FULL });
  const mid = matter.matter_id;
  const fp = () => approvalPolicyOf(db.get<any>(`SELECT confidentiality, consent_status, basis, model_endpoint, full_pseudonym, collab_scope FROM matters WHERE matter_id = ?`, [mid])!);
  const keys = generateKeyPairSync("ed25519");
  const store = new EgressApprovalStore(db, {
    deviceId: "dev_fp",
    signer: new SoftwareSigner(keys.privateKey),
  });
  const issue = (id: string) =>
    store.issue({ approvalId: id, tenantId: matter.tenant_id, matterId: mid, runId: `run_${id}`, userId: matter.created_by, channel: "desktop", purpose: "search", reason: "search_entity_requires_confirmation", digest: null, dest: "search_service", variant: "generalized", scope: "task", policy: fp() });
  const live = (id: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM egress_approvals WHERE approval_id = ? AND revoked_at IS NULL`, [id])!.n === 1;
  const f0 = fp();
  issue("apr_fp1");
  // 当事人词典与事项头当事人的增改：指纹不变、批准不作废
  await inv("matters.parties.upsert", { matter_id: mid, name: "辛某某", kind: "person" });
  await inv("matters.update", { matter_id: mid, patch: { counterparty: "壬贸易有限公司" } });
  assert.equal(fp(), f0, "词典变化不改审批策略指纹");
  assert.equal(live("apr_fp1"), true, "词典变化不作废批准");
  // 审批相关字段变化：指纹改变、批准作废
  await inv("matters.update", { matter_id: mid, patch: { full_pseudonym: true } });
  assert.notEqual(fp(), f0, "全部化名改变指纹");
  assert.equal(live("apr_fp1"), false, "审批相关字段变化即作废");
});
