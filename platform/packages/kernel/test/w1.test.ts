/**
 * 阶段 5（W1 桌面）的内核与闸门接口（v9 第 02 篇 §9.3、§9.5、§8.1；第 03 篇 §8；第 04 篇 §3.3、§5.3）：
 * - 确认卡：宿主预筛出含当事人的检索 → 律师在可信界面“改写后允许 / 原文放行” → 内核签发设备签名凭据 → 闸门独立核验后按所选变体发出；
 *   提问卡作答；去向卡计数（收敛偏离 D-04、D-16）；
 * - 批准凭据的防重放与防篡改（闸门侧核验：签名、主体与事项与运行、用途、目的地、期限、摘要；“本次”一次用尽；图像按首次使用绑定）；
 * - 运行模式按事项策略钳制；四项依据分项记录（收敛偏离 D-21）；无事项问答的当事人词典检查与问答路由。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "w1-test-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { egressDigest, verifyApproval, type SignedApproval } from "@zr-legal/egress-gate";
import { makeKernel, importText, waitRunAnswering, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { EgressApprovalStore } from "../src/services/egress-approvals.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_w1-firm" });
  // 律所明示允许“自动”档（缺省上限为“默认”）
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_AGENT_ENGINE: "kap", ZR_FIRM_MAX_MODE: "auto" }, "w1-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const toolText = (body: Record<string, unknown>, id: string): string => {
  const m = msgs(body).find((x) => x.role === "tool" && x.tool_call_id === id);
  return m ? (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) : "";
};

test("W1 确认卡：含当事人的检索——改写后允许（闸门核验凭据后发出泛化查询）、原文放行（只保留机构名称、自然人改为“某人”）；提问卡作答；去向卡计数", { timeout: 240_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", {
    title: "增资纠纷",
    stance: "原告",
    client_name: "孙悦",
    counterparty: "甲科技有限公司",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
    model_endpoint: "standard",
  });
  assert.equal(matter.basis_complete, true);
  const doc = await importText(inv, matter.matter_id, "起诉状.txt", "原告孙悦诉被告甲科技有限公司增资纠纷。");
  const M = "W1CARDS";
  const calls = [
    { id: "ws_a", name: "WebSearch", args: { query: "甲科技有限公司 孙悦 股东未实缴出资" } },
    { id: "ws_b", name: "WebSearch", args: { query: "甲科技有限公司 增资纠纷 裁判" } },
    { id: "q_c", name: "AskUserQuestion", args: { questions: [{ question: "研究范围限于近三年吗？", header: "范围", options: [{ label: "近三年", description: "" }, { label: "不限", description: "" }], multi_select: false }] } },
  ];
  let last: Record<string, unknown> | null = null;
  cloud.model.script = (body) => {
    const first = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
    if (!first.includes(M)) return null;
    last = body;
    const answered = new Set(msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    const next = calls.find((c) => !answered.has(c.id));
    return next ? { toolCalls: [next] } : { content: "研究完成。" };
  };
  try {
    const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    assert.match(est.data_where.preview, /替换为代号/);
    const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `w1-${Date.now()}`, goal: `${M} 研究增资纠纷中股东出资责任`, mode: "default", plan_first: false });
    let n = 0;
    const { run: fin, cards } = await waitRunAnswering(
      inv,
      run.run_id,
      (c) => {
        if (c.kind !== "search") return { decision: "reject" };
        n += 1;
        return n === 1 ? { decision: "approve", scope: "once", variant: "generalized" } : { decision: "approve", scope: "once", variant: "original" };
      },
      200_000,
      (q) => Object.fromEntries(q.questions.map((x: any) => [x.id, { kind: "single", option_id: x.options[0].id }])),
    );
    assert.equal(fin.status, "succeeded", JSON.stringify(fin));
    const search = cards.filter((c: any) => c.kind === "search");
    assert.equal(search.length, 2);
    // 卡片上的预览与闸门实际发出的一致（同一份筛查代码）
    assert.ok(!search[0].preview.send_generalized.includes("甲科技") && !search[0].preview.send_generalized.includes("孙悦"), search[0].preview.send_generalized);
    assert.ok(search[1].preview.send_original.includes("甲科技有限公司") && !search[1].preview.send_original.includes("孙悦"), search[1].preview.send_original);
    const sent = cloud.search.calls.map((c) => c.query);
    assert.ok(sent.includes(search[0].preview.send_generalized), JSON.stringify(sent));
    assert.ok(sent.includes(search[1].preview.send_original), JSON.stringify(sent));
    assert.ok(!sent.some((q) => q.includes("孙悦")), "自然人姓名永不发给检索服务");
    // 两次检索的结果都回到了模型；提问已作答
    assert.ok(last);
    assert.ok(toolText(last!, "ws_a").length > 0 && toolText(last!, "ws_b").length > 0);
    assert.match(toolText(last!, "q_c"), /近三年/);
    // 去向记录：两条检索都带批准凭据编号与所用变体；凭据各用一次
    const eg = await inv("egress.records", { run_id: run.run_id });
    const searchSent = eg.records.filter((r: any) => r.destination_kind === "search_service" && r.outcome === "sent").map((r: any) => JSON.parse(r.note));
    assert.equal(searchSent.length, 2);
    assert.deepEqual(searchSent.map((x: any) => x.query.decision).sort(), ["confirmed_original", "generalized"]);
    assert.ok(searchSent.every((x: any) => typeof x.approval_id === "string"));
    const uses = tk.kernel.db.all<{ uses: number; scope: string; variant: string }>(`SELECT uses, scope, variant FROM egress_approvals WHERE run_id = ? ORDER BY created_at`, [run.run_id]);
    assert.deepEqual(uses.map((u) => [u.uses, u.scope, u.variant]), [[1, "once", "generalized"], [1, "once", "original"]]);
    // 去向卡
    const sum = await inv("egress.summary", { run_id: run.run_id });
    assert.equal(sum.search.sent, 2);
    assert.equal(sum.search.confirmed, 2);
    assert.equal(sum.search.generalized, 1);
    assert.equal(sum.search.confirmed_original, 1);
    // 一句话如实区分：改写后发出 1 条、经你逐条确认按原文发出 1 条（含机构当事人名称）——原文放行不计为“令牌化查询”（复核 S5-A01）
    assert.match(sum.sentence, /中软检索服务发送 2 条查询（1 条改写后发出，1 条经你逐条确认按原文发出（含机构当事人名称））/);
    // 运行结束：凭据作废
    const live = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM egress_approvals WHERE run_id = ? AND revoked_at IS NULL`, [run.run_id])!.n;
    assert.equal(live, 0);
  } finally {
    cloud.model.script = null;
  }
});

test("W1 批准凭据：闸门侧独立核验——伪造签名、他人运行或事项、批准人、渠道、策略版本、过期、摘要不符、未知设备一律拒绝；“本次”一次用尽；“本任务内”可复用（检索只能改写后）；图像按首次使用绑定并重新签名；宿主拒收或事项策略变化即作废", () => {
  const db = tk.kernel.db;
  const keys = generateKeyPairSync("ed25519");
  const signer = { deviceId: "dev_test", signPrivateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), signPublicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const store = new EgressApprovalStore(db, signer);
  const pub = store.publicKeys();
  const mid = db.get<{ matter_id: string }>(`SELECT matter_id FROM matters LIMIT 1`)!.matter_id;
  const tid = tk.kernel.identity.tenantId;
  const uid = tk.kernel.identity.userId;
  const base = { tenantId: tid, matterId: mid, userId: uid, channel: "desktop", reason: "search_entity_requires_confirmation", policy: "fp-7" };
  const D = egressDigest("WebSearch", "甲公司 合同纠纷");
  const exp = (rid: string, digest = D) => ({ tid, uid, mid, rid, purpose: "search" as const, digest, dest: "search_service", pol: "fp-7" });

  // “本次”：取到即用尽
  store.issue({ ...base, approvalId: "apr_once", runId: "run_A", purpose: "search", digest: D, dest: "search_service", variant: "original", scope: "once" });
  assert.equal(store.take({ tenantId: tid, matterId: mid, runId: "run_A", purpose: "search", digest: egressDigest("WebSearch", "别的查询"), dest: "search_service" }), null, "摘要不符取不到");
  const s1 = store.take({ tenantId: tid, matterId: mid, runId: "run_A", purpose: "search", digest: D, dest: "search_service" })!;
  assert.ok(s1);
  assert.equal(verifyApproval(s1, pub, exp("run_A")).ok, true);
  assert.equal(store.take({ tenantId: tid, matterId: mid, runId: "run_A", purpose: "search", digest: D, dest: "search_service" }), null, "一次用尽");

  // 闸门侧核验：他人运行、他人事项、摘要不符、伪造、未知设备、用途与目的地
  const reasons = (s: SignedApproval, e: Parameters<typeof verifyApproval>[2], k = pub) => {
    const r = verifyApproval(s, k, e);
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(reasons(s1, exp("run_B")), "approval_scope_mismatch");
  assert.equal(reasons(s1, { ...exp("run_A"), uid: "usr_other" }), "approval_subject_mismatch");
  assert.equal(reasons(s1, { ...exp("run_A"), channels: ["office"] }), "approval_channel_not_allowed");
  assert.equal(reasons(s1, { ...exp("run_A"), pol: "fp-8" }), "approval_policy_changed", "事项审批策略变化后旧批准失效");
  assert.equal(reasons(s1, { ...exp("run_A"), mid: "mat_other" }), "approval_scope_mismatch");
  assert.equal(reasons(s1, exp("run_A", egressDigest("WebSearch", "x"))), "approval_digest_mismatch");
  assert.equal(reasons(s1, { ...exp("run_A"), dest: "evil.example" }), "approval_destination_mismatch");
  assert.equal(reasons(s1, { ...exp("run_A"), purpose: "fetch" }), "approval_purpose_mismatch");
  assert.equal(reasons({ ...s1, credential: { ...s1.credential, scope: "task", digest: null } }, exp("run_A")), "approval_bad_signature", "改字段即验签失败");
  assert.equal(reasons(s1, exp("run_A"), {}), "approval_unknown_device");
  assert.equal(reasons(null as unknown as SignedApproval, exp("run_A")), "approval_missing");
  // 过期
  const old = store.issue({ ...base, approvalId: "apr_exp", runId: "run_E", purpose: "search", digest: D, dest: "search_service", variant: "generalized", scope: "once", ttlMs: 1 });
  assert.equal(reasons(old, { ...exp("run_E"), now: Date.now() + 10 }), "approval_expired");

  // “本任务内”：同一运行、同一用途与目的地的任意查询
  store.issue({ ...base, approvalId: "apr_task", runId: "run_T", purpose: "search", digest: null, dest: "search_service", variant: "generalized", scope: "task" });
  for (const q of ["甲公司 a", "甲公司 b"]) {
    const s = store.take({ tenantId: tid, matterId: mid, runId: "run_T", purpose: "search", digest: egressDigest("WebSearch", q), dest: "search_service" })!;
    assert.equal(verifyApproval(s, pub, { ...exp("run_T"), digest: egressDigest("WebSearch", q) }).ok, true);
  }
  assert.equal(store.take({ tenantId: tid, matterId: mid, runId: "run_X", purpose: "search", digest: D, dest: "search_service" }), null, "不跨运行");

  // 检索的“本任务内”只能改写后放行（第 02 篇 §8.3）：签发即拒绝原文变体
  assert.throws(() => store.issue({ ...base, approvalId: "apr_task_orig", runId: "run_T2", purpose: "search", digest: null, dest: "search_service", variant: "original", scope: "task" }), /只能是改写后放行/);

  // 图像：首次使用绑定载荷摘要并重新签名（绑定值在签名之内）；同一运行重发同一张放行，另一张不行；有效期按运行总时长
  const issued = store.issue({ ...base, approvalId: "apr_img", runId: "run_I", purpose: "media", digest: null, dest: "model", variant: null, scope: "once", reason: "image_to_model" });
  assert.ok(Date.parse(issued.credential.exp) - Date.now() > 60 * 60_000, "图像凭据按运行总时长签发（复核 S5-B07）");
  const mexp = (digest: string) => ({ tid, uid, mid, rid: "run_I", purpose: "media" as const, digest, dest: "model", pol: "fp-7" });
  assert.equal(reasons(issued, mexp("a".repeat(64))), "approval_unbound", "未绑定的图像凭据闸门不受理");
  const img1 = store.take({ tenantId: tid, matterId: mid, runId: "run_I", purpose: "media", digest: "a".repeat(64), dest: "model" })!;
  assert.equal(img1.credential.digest, "a".repeat(64), "绑定后摘要写入凭据");
  assert.equal(verifyApproval(img1, pub, mexp("a".repeat(64))).ok, true);
  assert.equal(reasons({ ...img1, credential: { ...img1.credential, digest: "b".repeat(64) } }, mexp("b".repeat(64))), "approval_bad_signature", "改绑定摘要即验签失败");
  const again = store.take({ tenantId: tid, matterId: mid, runId: "run_I", purpose: "media", digest: "a".repeat(64), dest: "model" })!;
  assert.equal(verifyApproval(again, pub, mexp("a".repeat(64))).ok, true, "重发同一张");
  assert.equal(store.take({ tenantId: tid, matterId: mid, runId: "run_I", purpose: "media", digest: "b".repeat(64), dest: "model" }), null, "另一张须另行批准");

  // 宿主拒收律师的决定：单张作废；事项策略变化：该事项全部作废
  store.issue({ ...base, approvalId: "apr_one", runId: "run_O", purpose: "search", digest: D, dest: "search_service", variant: "generalized", scope: "once" });
  assert.equal(store.revoke("apr_one"), 1);
  assert.equal(store.take({ tenantId: tid, matterId: mid, runId: "run_O", purpose: "search", digest: D, dest: "search_service" }), null);
  store.issue({ ...base, approvalId: "apr_m", runId: "run_M", purpose: "search", digest: null, dest: "search_service", variant: "generalized", scope: "task" });
  assert.ok(store.revokeMatter(mid) >= 1);
  assert.equal(store.take({ tenantId: tid, matterId: mid, runId: "run_M", purpose: "search", digest: D, dest: "search_service" }), null);

  // 运行终止：全部作废
  store.issue({ ...base, approvalId: "apr_rev", runId: "run_R", purpose: "search", digest: D, dest: "search_service", variant: "original", scope: "once" });
  assert.equal(store.revokeRun("run_R"), 1);
  assert.equal(store.take({ tenantId: tid, matterId: mid, runId: "run_R", purpose: "search", digest: D, dest: "search_service" }), null);
});

test("W1 运行模式按事项策略钳制：L2 允许自动档与预授权；L3a 最高默认档、不得预授权；越级请求被拒绝", { timeout: 60_000 }, async () => {
  const { inv } = tk;
  const full = { engagement: "confirmed", personal_info: "confirmed", sensitive: "confirmed", subprocessor: "confirmed" };
  const l2 = (await inv("matters.create", { title: "L2 事项", stance: "原告", basis: full })).matter;
  const l3a = (await inv("matters.create", { title: "L3a 事项", stance: "原告", confidentiality: "high", basis: full })).matter;
  const p2 = (await inv("matters.get", { matter_id: l2.matter_id })).run_policy;
  const p3 = (await inv("matters.get", { matter_id: l3a.matter_id })).run_policy;
  assert.deepEqual(p2.allowed_modes, ["chat", "manual", "default", "auto"]);
  // 白名单站点抓取在默认与自动档都自动放行（不需预授权）；可预授权的只有“泛化后放行的检索”
  assert.deepEqual(p2.preauthorizations, ["search_generalized"]);
  assert.deepEqual(p3.allowed_modes, ["chat", "manual", "default"]);
  assert.deepEqual(p3.preauthorizations, []);
  const doc = await importText(inv, l3a.matter_id, "a.txt", "材料");
  const est = await inv("runs.estimate", { matter_id: l3a.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  await assert.rejects(inv("runs.start", { matter_id: l3a.matter_id, estimate_id: est.estimate_id, idempotency_key: `m-${Date.now()}`, goal: "x", mode: "auto" }), /上限/);
  await assert.rejects(inv("runs.start", { matter_id: l3a.matter_id, estimate_id: est.estimate_id, idempotency_key: `m2-${Date.now()}`, goal: "x", mode: "default", preauthorizations: ["search_generalized"] }), /自动/);
});

test("W1 四项依据分项记录：任一待确认即不齐备（consent_status 派生）；补齐后齐备；估价提示改为四项依据口径", { timeout: 60_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "依据", stance: "原告", basis: { engagement: "confirmed", personal_info: "pending", sensitive: "not_applicable", subprocessor: "confirmed" } });
  assert.equal(matter.basis_complete, false);
  assert.equal(matter.consent_status, "pending");
  assert.equal(matter.basis.personal_info, "pending");
  const doc = await importText(inv, matter.matter_id, "a.txt", "材料");
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  assert.match(est.data_where.warning, /四项依据/);
  const upd = await inv("matters.update", { matter_id: matter.matter_id, patch: { basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" } } });
  assert.equal(upd.matter.basis_complete, true);
  assert.equal(upd.matter.consent_status, "agreed");
  await assert.rejects(inv("matters.update", { matter_id: matter.matter_id, patch: { basis: { engagement: "yes" } } }), /basis/);
});

test("W1 无事项问答：命中当事人限制（L3b）事项的当事人即拦截、命中其他事项当事人同样拦截并给出事项链接（D-22）；一般问题经闸门问答路由发往网关（不带事项编号，问题中的电话替换为代号）；历史只在本机", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  await inv("matters.create", { title: "借款", stance: "原告", client_name: "王小明" });
  await inv("matters.create", { title: "限制事项", stance: "被告", counterparty: "乙山贸易有限公司", confidentiality: "strict" });
  const meterBefore = cloud.gatewayMeter.length;
  const a = await inv("chat.send", { text: "王小明的借款纠纷怎么处理" });
  assert.equal(a.blocked.reason, "matter_party");
  assert.ok(a.blocked.matters.some((m: any) => m.title === "借款"));
  const b = await inv("chat.send", { text: "乙山贸易有限公司 合同违约" });
  assert.equal(b.blocked.reason, "l3b_party");
  assert.equal(cloud.gatewayMeter.length, meterBefore, "被拦截的问题没有到网关");
  let seen: Record<string, unknown> | null = null;
  cloud.model.script = (body) => {
    const sys = JSON.stringify(msgs(body)[0]?.content ?? "");
    if (!sys.includes("无事项问答")) return null;
    seen = body;
    return { content: "未实缴出资的股东在未出资本息范围内承担补充赔偿责任（须核验现行有效）。" };
  };
  try {
    const r = await inv("chat.send", { text: "股东未实缴出资的补足责任如何认定？我的电话是 13800138000" });
    assert.equal(r.blocked, undefined, JSON.stringify(r));
    assert.equal(r.messages.length, 2);
    assert.match(r.messages[1].text, /补充赔偿责任/);
    // 界面看到的是原文（本机还原）；网关收到的是代号
    assert.match(r.messages[0].text, /13800138000/);
    assert.ok(seen && !JSON.stringify(seen).includes("13800138000"), "电话以代号出站");
    // 网关计量：问答路由、无事项编号
    const qaMeter = cloud.gatewayMeter.filter((m) => m.anonMatter === "qa");
    assert.ok(qaMeter.length >= 1, JSON.stringify(cloud.gatewayMeter.slice(-3)));
    const list = await inv("chat.list", {});
    assert.ok(list.conversations.some((c: any) => c.conversation_id === r.conversation_id));
    const got = await inv("chat.get", { conversation_id: r.conversation_id });
    assert.equal(got.messages.length, 2);
  } finally {
    cloud.model.script = null;
  }
});
