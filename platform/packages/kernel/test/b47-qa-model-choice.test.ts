/**
 * 第 47 批：无事项问答按次选模型（K3 / K2.6）与“模型请求被网关按身份拒绝”的识别。
 * - 可选模型只列模型路由实际配置了的别名；律师选了不可选的模型即拒绝（说清能选什么），不静默改用别的模型；
 * - 每条回答（含“未能取得回答”）记下实际用的别名，列消息时带回 route / route_label；旧记录（无该列的值）为 null；
 * - 所选模型未定价、没有路由、已停用、套餐不含：说“这个模型暂不可用”，选的不是 K3 时建议换 K3；不说成额度用完或连不上；
 * - identityRejectionOf：只有账号停用、登录失效这类确定的身份拒绝才算；额度、限流、5xx、网络、授权续期中、席位收回都不算；
 * - 闸门 provider 在网关拒绝时回调 onRejection（状态码 + 网关错误代码），4xx 错误的 detail 带代码。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "@zr-legal/domain";
import { buildRoutes, createGateProvider } from "@zr-legal/model-broker";
import { makeKernel } from "./helpers.ts";
import { QaChatService, qaErrorMessage, qaFailureText, qaModelChoices, qaRouteLabel } from "../src/services/qa-chat.ts";
import { identityRejectionOf, modelRejectionProblem, SESSION_REJECTION_GRACE_MS } from "../src/account-session.ts";

const k = await makeKernel({}, "b47-qa-model");
after(() => k.kernel.close());
const TID = "ten_b47-qa-model";
const UID = "usr_b47-qa-model_test-lawyer";
const noParties = { partiesIn: () => [] } as any;

test("可选模型：只列配置了的别名、缺省那一个说明前加“缺省，”；律师名 K3 / K2.6（纯函数）", () => {
  assert.deepEqual(qaModelChoices(["legal/k3", "legal/k2.6", "legal/other"], "legal/k3"), [
    // thinking（第 49 批）：不给 thinkingOf 时按“不可控”
    { alias: "legal/k3", label: "K3", note: "缺省，适合复杂问题", default: true, thinking: "none" },
    { alias: "legal/k2.6", label: "K2.6", note: "更快、更省额度，复杂问题效果略弱", default: false, thinking: "none" },
  ]);
  // 给了 thinkingOf：K3 调推理强度、K2.6 开关思考
  assert.deepEqual(
    qaModelChoices(["legal/k3", "legal/k2.6"], "legal/k3", (a) => (a === "legal/k3" ? "effort" : "toggle")).map((c) => c.thinking),
    ["effort", "toggle"],
  );
  assert.deepEqual(
    qaModelChoices(["legal/k3"], "legal/k3").map((c) => c.alias),
    ["legal/k3"],
    "没配置 K2.6 就不列",
  );
  assert.equal(qaModelChoices(["legal/k3", "legal/k2.6"], "legal/k2.6").find((c) => c.default)?.label, "K2.6");
  assert.equal(qaRouteLabel("legal/k2.6"), "K2.6");
  assert.equal(qaRouteLabel(null), null);
  assert.equal(qaRouteLabel("legal/other"), null);
});

test("kernel.status 与 chat.models 给出可选模型；chat.send 按 route 选模型并在回答上记下别名，缺省 K3，不可选的拒绝", async () => {
  const st = (await k.inv("kernel.status")) as any;
  assert.deepEqual(
    st.model_choices.map((c: any) => [c.alias, c.label, c.default]),
    [
      ["legal/k3", "K3", true],
      ["legal/k2.6", "K2.6", false],
    ],
  );
  const models = (await k.inv("chat.models")) as any;
  assert.deepEqual(models.choices, st.model_choices);
  assert.equal(models.default, "legal/k3");

  // 缺省：K3
  const r1 = (await k.inv("chat.send", { text: "合同解除的法定事由有哪些？" })) as any;
  const a1 = r1.messages.filter((m: any) => m.role !== "user").at(-1);
  assert.equal(a1.role, "assistant", JSON.stringify(r1.messages));
  assert.deepEqual([a1.route, a1.route_label], ["legal/k3", "K3"]);
  const q1 = r1.messages.find((m: any) => m.role === "user");
  assert.deepEqual([q1.route, q1.route_label], [null, null], "问题本身不记模型");

  // 同一会话这一问选 K2.6
  const r2 = (await k.inv("chat.send", { conversation_id: r1.conversation_id, text: "那么约定解除呢？", route: "legal/k2.6" })) as any;
  const a2 = r2.messages.filter((m: any) => m.role !== "user").at(-1);
  assert.deepEqual([a2.role, a2.route, a2.route_label], ["assistant", "legal/k2.6", "K2.6"]);
  // 列消息时带回（重新读一遍）
  const got = (await k.inv("chat.get", { conversation_id: r1.conversation_id })) as any;
  assert.deepEqual(
    got.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.route_label),
    ["K3", "K2.6"],
  );

  // 空串 / null = 不选 → 缺省
  const r3 = (await k.inv("chat.send", { conversation_id: r1.conversation_id, text: "第三问", route: null })) as any;
  assert.equal(r3.messages.at(-1).route, "legal/k3");

  // 不认识、不在问答可选列表里的别名：拒绝，说清能选什么；会话里不多出问题
  const before = got.messages.length + 2;
  for (const bad of ["legal/k9", "gpt-4o", "LEGAL/K3", 123]) {
    await assert.rejects(k.inv("chat.send", { conversation_id: r1.conversation_id, text: "第四问", route: bad }), (e: any) => {
      assert.equal(e.code, "validation", String(bad));
      assert.match(e.message, /所选模型不可用：问答只能选 K3、K2\.6/);
      return true;
    });
  }
  const after4 = (await k.inv("chat.get", { conversation_id: r1.conversation_id })) as any;
  assert.equal(after4.messages.length, before, "被拒的问题没有写进会话");

  // 旧记录（迁移 0069 之前写入，route 列为 NULL）：route / route_label 为 null
  k.kernel.db.run(`UPDATE qa_messages SET route = NULL WHERE conversation_id = ?`, [r1.conversation_id]);
  const old = (await k.inv("chat.get", { conversation_id: r1.conversation_id })) as any;
  assert.ok(old.messages.every((m: any) => m.route === null && m.route_label === null));
});

test("问答失败：所选模型未定价或路由不可用说“这个模型暂不可用”，K2.6 建议换 K3；额度与登录照旧（纯函数）", () => {
  assert.equal(qaFailureText("模型通道 503（该模型尚未定价，暂不能使用：请联系平台运营；交编排层有界退避，不切换端点） [kwl:price_unconfigured]", "legal/k2.6"), "K2.6 这个模型暂不可用，这次没有取得回答：请换 K3 再问，或联系律所管理员");
  assert.equal(qaFailureText("模型通道错误 400：模型未登记 [kwl:model_not_routed]", "legal/k2.6"), "K2.6 这个模型暂不可用，这次没有取得回答：请换 K3 再问，或联系律所管理员");
  assert.equal(qaFailureText("模型通道错误 400：该模型已停用 [kwl:model_disabled]", "legal/k2.6"), "K2.6 这个模型暂不可用，这次没有取得回答：请换 K3 再问，或联系律所管理员");
  assert.equal(qaFailureText("x [kwl:model_not_allowed]", "legal/k2.6"), "本所的套餐不含 K2.6，这次没有取得回答：请换 K3 再问，或联系律所管理员");
  assert.equal(qaFailureText("x [kwl:upstream_unavailable]", "legal/k3"), "K3 这个模型暂不可用，这次没有取得回答：请稍后再问，或联系律所管理员", "K3 本身不可用时不说“换 K3”");
  assert.equal(qaFailureText("x [kwl:price_unconfigured]"), "这个模型暂不可用，这次没有取得回答：请稍后再问，或联系律所管理员", "不带模型（旧调用）");
  assert.doesNotMatch(qaFailureText("x [kwl:price_unconfigured]", "legal/k2.6"), /连不上|额度/);
  // 第 46 批的口径不变
  assert.match(qaFailureText("402 本所本期 AI 额度不足（预占失败） [kwl:quota_exhausted]", "legal/k2.6"), /^你的 AI 额度暂时用到限制/);
  assert.equal(qaFailureText("模型通道错误 402：账号已停用 [kwl:account_disabled]", "legal/k2.6"), "你的账号已被停用，这次没有取得回答：请联系律所管理员或中软客服");
  // 429/5xx 的说明里没有代码：从错误的 detail.code 补上
  const e503 = new DomainError("provider_unavailable", "模型通道 503（该模型尚未定价，暂不能使用：请联系平台运营；交编排层有界退避，不切换端点）", 503, { status: 503, code: "price_unconfigured" });
  assert.match(qaErrorMessage(e503), /\[kwl:price_unconfigured\]$/);
  assert.equal(qaErrorMessage(new DomainError("internal", "a [kwl:x_y]", 502, { code: "z" })), "a [kwl:x_y]", "已有代码不重复补");
  assert.equal(qaErrorMessage(new Error("超时")), "超时");
});

test("问答取不到回答：所选 K2.6 未定价（网关 503）→“未能取得回答：K2.6 这个模型暂不可用……”，并记下用的是 K2.6", async () => {
  const qa = new QaChatService({
    db: k.kernel.db,
    tokens: noParties,
    routes: () => ["legal/k3", "legal/k2.6"],
    defaultRoute: "legal/k3",
    ask: async (input) => {
      if (input.route === "legal/k2.6") throw new DomainError("provider_unavailable", "模型通道 503（该模型尚未定价，暂不能使用：请联系平台运营；交编排层有界退避，不切换端点）", 503, { status: 503, code: "price_unconfigured" });
      return "依据《民法典》第五百六十三条。";
    },
  });
  const r = await qa.send({ text: "合同解除的法定事由有哪些？", route: "legal/k2.6" }, TID, UID);
  const n = r.messages.at(-1)!;
  assert.equal(n.role, "notice");
  assert.equal(n.text, "未能取得回答：K2.6 这个模型暂不可用，这次没有取得回答：请换 K3 再问，或联系律所管理员");
  assert.deepEqual([n.route, n.route_label], ["legal/k2.6", "K2.6"]);
  const ok = await qa.send({ conversationId: r.conversation_id, text: "那换 K3 呢？", route: "legal/k3" }, TID, UID);
  assert.deepEqual([ok.messages.at(-1)!.role, ok.messages.at(-1)!.route_label], ["assistant", "K3"]);
  // 只配置了 K3 的电脑：选 K2.6 拒绝
  const only = new QaChatService({ db: k.kernel.db, tokens: noParties, routes: () => ["legal/k3"], ask: async () => "答" });
  await assert.rejects(only.send({ text: "问", route: "legal/k2.6" }, TID, UID), /所选模型不可用：问答只能选 K3$/);
});

test("identityRejectionOf：账号停用、登录失效才算身份拒绝；额度、限流、5xx、网络、授权续期中、席位收回都不算（纯函数）", () => {
  // 网关 402 + account_disabled（控制面拒发额度租约）
  assert.equal(identityRejectionOf("模型通道错误 402：账号已停用 [kwl:account_disabled]"), "account_disabled");
  assert.equal(identityRejectionOf("account_disabled"), "account_disabled", "闸门 provider 回调给的是代码本身");
  assert.equal(identityRejectionOf("402 账号已停用 [kwl:account_disabled]"), "account_disabled", "助手宿主报的“状态码 + 说明”");
  // 网关 401 seat_session_inactive（订阅把这台设备列为暂停：退出登录、会话过期、账号停用）
  assert.equal(identityRejectionOf("401 登录已失效，请重新登录 [kwl:seat_session_inactive]"), "session_invalid");
  assert.equal(identityRejectionOf("seat_session_inactive"), "session_invalid");
  assert.equal(identityRejectionOf("x [kwl:session_expired]"), "session_expired");
  // 不算
  for (const s of [
    "402 本所本期 AI 额度不足（预占失败） [kwl:quota_exhausted]",
    "x [kwl:quota_seat_limit]",
    "x [kwl:quota_burst]",
    "模型通道 429（模型通道繁忙，请稍后重试；交编排层有界退避，不切换端点）",
    "upstream_busy",
    "模型通道 503（暂时无法确认本所 AI 额度，请稍后再试；交编排层有界退避，不切换端点） [kwl:quota_unavailable]",
    "模型通道 502（模型服务连接失败（可重试））",
    "出站闸门连接失败：connect ECONNREFUSED /tmp/x.sock",
    "fetch failed ETIMEDOUT",
    "x [kwl:seat_unavailable]",
    "x [kwl:seat_device_revoked]",
    "x [kwl:seat_seat_revoked]",
    "x [kwl:price_unconfigured]",
    "账号已停用", // 没有代码不按中文说明猜
    "not_account_disabled_really",
    "",
    null,
    undefined,
  ]) {
    assert.equal(identityRejectionOf(s), null, String(s));
  }
  // 带了别的代码时以代码为准（说明里碰巧出现的词不算）
  assert.equal(identityRejectionOf("quota 说明提到 account_disabled [kwl:quota_exhausted]"), null);
});

test("刚重新登录后的宽限：网关按旧暂停名单回 seat_session_inactive 不再踢回登录框；account_disabled 不设宽限（纯函数）", () => {
  assert.equal(modelRejectionProblem("x [kwl:seat_session_inactive]", 5_000), null);
  assert.equal(modelRejectionProblem("x [kwl:seat_session_inactive]", SESSION_REJECTION_GRACE_MS), "session_invalid");
  assert.equal(modelRejectionProblem("x [kwl:seat_session_inactive]", Number.POSITIVE_INFINITY), "session_invalid");
  assert.equal(modelRejectionProblem("x [kwl:account_disabled]", 5_000), "account_disabled");
  assert.equal(modelRejectionProblem("x [kwl:quota_exhausted]", Number.POSITIVE_INFINITY), null);
});

test("闸门 provider：网关拒绝时回调 onRejection（状态码 + 错误代码），4xx 错误的 detail 带代码；本机闸门拦截不回调", async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "kwl-b47-gate-")), "gate.sock");
  const replies: { status: number; body: unknown }[] = [];
  const srv: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const r = replies.shift()!;
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => srv.listen(sock, resolve));
  after(() => new Promise<void>((resolve) => srv.close(() => resolve())));
  const seen: { status: number; code: string | null }[] = [];
  const gp = createGateProvider({ socket: async () => sock, token: () => "t", onRejection: (r) => seen.push(r) });
  const route = buildRoutes({ ZR_MODEL_PROVIDER: "upstream" } as any)["legal/k2.6"]!;
  const meta = { nonce: "n", clientIdempotencyId: "qa_1", task: { tid: "t", uid: "u", mid: "qa" }, routePrefix: "/q/c1" } as any;
  const req = { model: "legal/k2.6", messages: [{ role: "user", content: "问" }] } as any;

  replies.push({ status: 402, body: { error: { type: "kwl_gateway", code: "account_disabled", message: "账号已停用" } } });
  await assert.rejects(gp.chat(route, req, meta), (e: any) => {
    assert.equal(e.detail?.code, "account_disabled");
    assert.equal(identityRejectionOf(qaErrorMessage(e)), "account_disabled");
    return true;
  });
  replies.push({ status: 503, body: { error: { type: "kwl_gateway", code: "price_unconfigured", message: "该模型尚未定价，暂不能使用：请联系平台运营" } } });
  await assert.rejects(gp.chat(route, req, meta), (e: any) => {
    assert.equal(qaFailureText(qaErrorMessage(e), "legal/k2.6"), "K2.6 这个模型暂不可用，这次没有取得回答：请换 K3 再问，或联系律所管理员");
    return true;
  });
  replies.push({ status: 403, body: { error: { type: "kwl_gate_denied", code: "seat_unavailable", message: "这台电脑暂时没有取得 AI 使用授权" } } });
  await assert.rejects(gp.chat(route, req, meta), (e: any) => e.code === "egress_blocked");
  assert.deepEqual(seen, [
    { status: 402, code: "account_disabled" },
    { status: 503, code: "price_unconfigured" },
  ]);
  // 回调抛错不影响原错误
  const gp2 = createGateProvider({
    socket: async () => sock,
    token: () => "t",
    onRejection: () => {
      throw new Error("boom");
    },
  });
  replies.push({ status: 401, body: { error: { type: "kwl_gateway", code: "seat_session_inactive", message: "登录已失效，请重新登录" } } });
  await assert.rejects(gp2.chat(route, req, meta), (e: any) => e.detail?.code === "seat_session_inactive" && /模型通道错误 401/.test(e.message));
});
