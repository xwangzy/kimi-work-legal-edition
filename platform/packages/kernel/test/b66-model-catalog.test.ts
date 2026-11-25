/**
 * 第 66 批（V40）：云端模型目录在内核——验签、(version, issued_at) 只进不退、缓存读回重验、离线用最后一版、从未取到用内置两项；
 * 模型路由按目录补别名（自带密钥 / 私有端点只认内置两项）；问答可选列表与失败说明读目录；
 * models.list / models.select；runs.start 的 model：不在任务入口、不认识的拒绝，合格的写进 runs.model 并交给助手宿主。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b66-model-catalog-secret-0123456789ab";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEnvelope, sealEnvelope } from "@zr-legal/firm-trust";
import { ModelBroker } from "@zr-legal/model-broker";
import { BUILTIN_CATALOG, catalogNewer, isModelRejection, ModelCatalogService, sanitizeCatalog } from "../src/services/model-catalog.ts";
import { qaFailureText, qaModelChoices, qaRouteLabel } from "../src/services/qa-chat.ts";
import { buildEngineConfig, sanitizeTaskModel } from "../../kap-host/src/engine-config.ts";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

const TID = "ten_b66";
const key = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const open = (pub = key.publicKey) => (e: unknown) => {
  const o = openEnvelope(e, "kwl-model-catalog", new Map([["k1", pub]]));
  return o.ok ? o.body : null;
};
const model = (id: string, o: Record<string, unknown> = {}) => ({ id, label: id.replace("legal/", "").toUpperCase(), description: null, sort: 50, thinking: "effort", efforts: ["low", "high"], capabilities: ["tool_use", "thinking"], scopes: ["qa", "task"], max_context: 131072, default: false, available: true, reason: null, ...o });
const doc = (version: number, at: string, models: Record<string, unknown>[], tid = TID) => ({ version, issued_at: at, tid, uid: "usr_x", default: "legal/k3", models });
const seal = (body: unknown) => sealEnvelope("kwl-model-catalog", body, { kid: "k1", privateKey: key.privateKey });

const V5 = doc(5, "2026-11-26T08:00:00.000Z", [
  model("legal/k3", { label: "K3", sort: 10, capabilities: ["tool_use", "thinking", "long_context"], efforts: ["low", "high", "max"], max_context: 262144 }),
  { ...model("legal/k3-fast", { label: "K3 高速", sort: 15, description: "更快" }), targets: [{ provider: "maas", model: "kimi-k3.1-pro-highspeed" }] },
  model("legal/k2.6", { label: "K2.6", sort: 20, thinking: "toggle", efforts: [], scopes: ["qa"] }),
  model("legal/qa-lite", { label: "问答轻量", sort: 30, thinking: "none", efforts: [], capabilities: [], scopes: ["qa"] }),
  model("legal/notool", { label: "无工具", sort: 40, capabilities: [], scopes: ["qa", "task"] }),
  model("legal/blocked", { label: "未开通", sort: 45, available: false, reason: "not_in_plan" }),
]);

test("目录服务：验签、丢弃未知字段、只进不退（同版本按签发时刻）、篡改与别家租户不收、取不到用最后一版、缓存读回重验", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-b66-cat-"));
  const cacheFile = join(dir, "model-catalog.json");
  const queue: unknown[] = [];
  const changes: number[] = [];
  const svc = new ModelCatalogService({ pull: async () => { const x = queue.shift(); if (x instanceof Error) throw x; return x; }, open: open(), tenantId: TID, cacheFile, onChange: (d) => changes.push(d?.version ?? -1) });
  // 从未取到：内置两项（问答 K3 / K2.6，任务只有 K3）
  assert.deepEqual(svc.list("qa").map((m) => m.id), ["legal/k3", "legal/k2.6"]);
  assert.deepEqual(svc.list("task").map((m) => m.id), ["legal/k3"]);
  assert.equal(svc.state().source, "builtin");

  queue.push(seal(V5));
  assert.equal(await svc.refresh("test"), "updated");
  assert.deepEqual(changes, [5]);
  assert.equal(svc.state().source, "cloud");
  assert.equal(JSON.stringify(svc.models()).includes("targets"), false, "未知字段（目标）不进本机");
  assert.ok(existsSync(cacheFile));
  assert.deepEqual(svc.list("task").map((m) => [m.id, m.available, m.reason_text]), [
    ["legal/k3", true, null],
    ["legal/k3-fast", true, null],
    ["legal/notool", false, "这个模型不支持任务需要的工具调用，只能在问答里用"],
    ["legal/blocked", false, "本所套餐不含这个模型"],
  ]);
  assert.deepEqual(svc.list("qa").filter((m) => m.available).map((m) => m.id), ["legal/k3", "legal/k3-fast", "legal/k2.6", "legal/qa-lite", "legal/notool"]);
  assert.equal(svc.check("legal/k2.6", "task").ok, false, "K2.6 不在任务入口");
  assert.equal(svc.check("legal/nope", "qa").ok, false);
  assert.equal(svc.defaultFor("task"), "legal/k3");

  // 旧版本：不采用；同一份：unchanged；同版本更晚签发（套餐变化）：采用
  queue.push(seal(doc(4, "2026-11-26T09:00:00.000Z", [model("legal/k3", { label: "K3" })])));
  assert.equal(await svc.refresh("test"), "stale");
  assert.equal(svc.state().version, 5);
  queue.push(seal(V5));
  assert.equal(await svc.refresh("test"), "unchanged");
  queue.push(seal(doc(5, "2026-11-26T07:59:00.000Z", [model("legal/k3", { label: "K3" })])));
  assert.equal(await svc.refresh("test"), "stale", "同版本、更早签发：重放");
  const v5b = doc(5, "2026-11-26T08:05:00.000Z", V5.models.map((m) => (m.id === "legal/k3-fast" ? { ...m, available: false, reason: "not_in_plan" } : m)));
  queue.push(seal(v5b));
  assert.equal(await svc.refresh("test"), "updated");
  assert.equal(svc.check("legal/k3-fast", "task").ok, false);

  // 篡改、别家租户、换了密钥：不收；取不到：用最后一版
  const forged = seal(doc(9, "2026-11-26T10:00:00.000Z", [model("legal/k3")])) as any;
  forged.body.version = 10;
  queue.push(forged);
  assert.equal(await svc.refresh("test"), "invalid");
  queue.push(seal(doc(9, "2026-11-26T10:00:00.000Z", [model("legal/k3")], "ten_other")));
  assert.equal(await svc.refresh("test"), "invalid");
  queue.push(new Error("cp_unreachable"));
  assert.equal(await svc.refresh("test"), "failed");
  assert.equal(svc.state().issued_at, "2026-11-26T08:05:00.000Z");

  // 重启：缓存读回重验（来源 cache）；公钥换了即不采用缓存
  const again = new ModelCatalogService({ pull: async () => null, open: open(), tenantId: TID, cacheFile });
  assert.deepEqual([again.state().source, again.state().version, again.check("legal/k3-fast", "task").ok], ["cache", 5, false]);
  const rotated = new ModelCatalogService({ pull: async () => null, open: open(other.publicKey), tenantId: TID, cacheFile });
  assert.equal(rotated.state().source, "builtin");
  // 没有控制面：只有内置两项，refresh 不发请求
  const dev = new ModelCatalogService({ pull: null, open: open(), tenantId: TID, cacheFile: null });
  assert.equal(await dev.refresh("test"), "no_source");
  assert.deepEqual(dev.models(), BUILTIN_CATALOG);
});

test("纯函数：sanitizeCatalog 整份不合格即不收；catalogNewer；isModelRejection", () => {
  assert.equal(sanitizeCatalog({ ...V5, models: [{ ...V5.models[0], thinking: "auto" }] }, TID), null);
  assert.equal(sanitizeCatalog({ ...V5, models: [V5.models[0], V5.models[0]] }, TID), null, "重复 id");
  assert.equal(sanitizeCatalog(V5, "ten_other"), null);
  assert.equal(catalogNewer({ version: 5, issued_at: "2026-11-26T08:00:00Z" }, { version: 5, issued_at: "2026-11-26T08:00:00Z" }), false);
  assert.equal(catalogNewer({ version: 6, issued_at: "2026-11-26T07:00:00Z" }, { version: 5, issued_at: "2026-11-26T08:00:00Z" }), true);
  assert.equal(isModelRejection("模型通道错误 403：x [kwl:model_not_allowed]"), true);
  assert.equal(isModelRejection("[kwl:quota_exhausted]"), false);
});

test("模型路由按目录补别名：只收可用的非内置项；内置两项始终在；思考控制取目录；自带密钥端点拒绝非内置别名", async () => {
  const store = { run() {}, get() { return undefined; }, all() { return []; } } as any;
  const egress = { assertMatterAllowsModel() {}, recordMock() { return "x"; } } as any;
  const broker = new ModelBroker(store, egress, { ZR_MODEL_PROVIDER: "upstream" }, { gate: { socket: async () => "/nonexistent.sock", token: () => "t" } as any });
  const sv = sanitizeCatalog(V5, TID)!;
  broker.setCatalog(sv.models);
  assert.equal(broker.resolveRoute("legal/k3-fast").thinkingControl, "effort");
  assert.deepEqual(broker.resolveRoute("legal/k3-fast").allowedEfforts, ["low", "high"]);
  assert.equal(broker.resolveRoute("legal/qa-lite").thinkingControl, "none");
  assert.throws(() => broker.resolveRoute("legal/blocked"), /未知模型路由/, "不可用的不进路由");
  assert.equal(broker.resolveRoute("legal/k3").providerModel, "kimi-k3", "内置项仍按本机配置");
  const matter = { matter_id: "m1", model_endpoint: "byok" } as any;
  await assert.rejects(broker.chat({ matter, task: { tid: TID, uid: "u", mid: "m1" } as any, route: "legal/k3-fast", messages: [{ role: "user", content: "x" }] }), /只能用内置的 K3 或 K2\.6/);
  broker.setCatalog([]);
  assert.throws(() => broker.resolveRoute("legal/k3-fast"));
  assert.deepEqual(broker.routeAliases().sort(), ["legal/k2.6", "legal/k3"]);
});

test("问答读目录：可选列表、显示名、失败说明建议换缺省模型（显示名随目录）", () => {
  const sv = sanitizeCatalog(V5, TID)!;
  const choices = qaModelChoices(["legal/k3", "legal/k2.6", "legal/k3-fast", "legal/qa-lite", "legal/notool"], "legal/k3", undefined, sv.models);
  assert.deepEqual(choices.map((c) => c.alias), ["legal/k3", "legal/k3-fast", "legal/k2.6", "legal/qa-lite", "legal/notool"]);
  assert.equal(choices.find((c) => c.alias === "legal/k3-fast")!.note, "更快");
  assert.equal(qaRouteLabel("legal/k3-fast", sv.models), "K3 高速");
  assert.equal(qaFailureText("x [kwl:model_disabled]", "legal/qa-lite", { labelOf: (a) => qaRouteLabel(a, sv.models), defaultAlias: "legal/k3-fast" }), "问答轻量 这个模型暂不可用，这次没有取得回答：请换 K3 高速 再问，或联系律所管理员");
  assert.equal(qaFailureText("x [kwl:model_not_allowed]", "legal/k2.6"), "本所的套餐不含 K2.6，这次没有取得回答：请换 K3 再问，或联系律所管理员", "不给目录：缺省 K3（与第 47 批口径一致）");
});

test("助手宿主：引擎配置按所选别名加一项（能力取目录）；规格不合格按“只给工具调用”", () => {
  const spec = sanitizeTaskModel("legal/k3-fast", { capabilities: ["tool_use", "thinking", "long_context"], max_context: 131072, thinking: "effort" })!;
  const cfg = buildEngineConfig({ matterId: "m1", execDomainAvailable: false, legalMcpTools: [], searchConfigured: false, fetchConfigured: false, taskModels: [spec] }).config as any;
  assert.deepEqual(cfg.models["legal/k3-fast"], { provider: "kwl-gate", model: "legal/k3-fast", max_context_size: 131072, capabilities: ["tool_use", "thinking"] });
  assert.deepEqual(Object.keys(cfg.models).sort(), ["legal/k2.6", "legal/k3", "legal/k3-fast"]);
  assert.equal(cfg.secondary_model.default_model, "legal/k2.6", "子 Agent 仍强制 K2.6");
  assert.equal(sanitizeTaskModel("Legal/K3!", {}), null);
  assert.deepEqual(sanitizeTaskModel("legal/x", "bogus"), { id: "legal/x", capabilities: ["tool_use"], max_context: null, thinking: "none" });
});

// ─── 内核方法（开发形态：没有控制面 → 内置两项） ───

let tk: TestKernel;
let cloud: CloudV0;
before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b66-model-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "b66-model-firm");
});
after(async () => {
  await tk?.kernel.close();
  await cloud?.close();
});

test("models.list / models.select：任务只列 K3、问答 K3 / K2.6；不在入口的不能选；选了记在本机、按入口分开", async () => {
  const { inv } = tk;
  const task = await inv("models.list", { scope: "task" });
  assert.deepEqual([task.source, task.default, task.selected, task.models.map((m: any) => m.id)], ["builtin", "legal/k3", "legal/k3", ["legal/k3"]]);
  assert.equal(JSON.stringify(task).includes("kimi-k3"), false, "不出上游型号");
  const qa = await inv("models.list", { scope: "qa" });
  assert.deepEqual(qa.models.map((m: any) => [m.id, m.label, m.thinking]), [["legal/k3", "K3", "effort"], ["legal/k2.6", "K2.6", "toggle"]]);
  await assert.rejects(inv("models.select", { scope: "task", id: "legal/k2.6" }), /这个模型不能用于任务/);
  await assert.rejects(inv("models.select", { scope: "qa", id: "legal/nope" }), /没有这个模型/);
  await assert.rejects(inv("models.list", { scope: "chat" }), /scope 须为/);
  assert.deepEqual(await inv("models.select", { scope: "qa", id: "legal/k2.6" }), { ok: true, scope: "qa", selected: "legal/k2.6", label: "K2.6" });
  assert.equal((await inv("models.list", { scope: "qa" })).selected, "legal/k2.6");
  assert.equal((await inv("models.list", { scope: "task" })).selected, "legal/k3", "按入口分开");
  // chat.models 与之同源（仍是 K3 / K2.6）
  assert.deepEqual((await inv("chat.models")).choices.map((c: any) => c.alias), ["legal/k3", "legal/k2.6"]);
});

test("runs.start 的 model：不在任务入口、不认识的拒绝；合格的写进 runs.model 并随发起交给助手宿主；追问不能换模型", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "模型选择", stance: "原告", consent_status: "not_required" });
  const est = async () => (await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] })).estimate_id;
  const start = async (extra: Record<string, unknown>) => inv("runs.start", { matter_id: matter.matter_id, estimate_id: await est(), idempotency_key: `b66-${Date.now()}-${Math.random()}`, goal: "B66 请简要回答", plan_first: false, mode: "default", ...extra });
  await assert.rejects(start({ model: "legal/k2.6" }), /不能用于这次任务：这个模型不能用于任务/);
  await assert.rejects(start({ model: "legal/nope" }), /没有这个模型/);
  await assert.rejects(start({ model: 42 }), /model 须为模型编号/);

  const client = tk.kernel.agentClient as any;
  const seen: any[] = [];
  const orig = client.start.bind(client);
  client.start = async (id: unknown, req: any) => {
    seen.push(req);
    return orig(id, req);
  };
  try {
    const r = await start({ model: "legal/k3" });
    assert.deepEqual([r.model, r.model_label], ["legal/k3", "K3"]);
    const row = tk.kernel.db.get<{ model: string }>(`SELECT model FROM runs WHERE run_id = ?`, [r.run_id]);
    assert.equal(row?.model, "legal/k3");
    const done = await waitRun(inv, r.run_id, 90_000);
    assert.equal(seen[0]?.model, "legal/k3", "执行器把任务记录里的模型交给助手宿主");
    assert.equal((await inv("runs.get", { run_id: r.run_id })).run.model_label, "K3");
    assert.ok(["succeeded", "partial"].includes(done.run.status), done.run.status);
    // 助手宿主按所选模型发起：宿主的 run.started（内核记为 agent.started）带着它
    assert.equal(done.events.find((e: any) => e.type === "agent.started")?.payload?.model, "legal/k3");
    await assert.rejects(inv("runs.start", { matter_id: matter.matter_id, estimate_id: await est(), idempotency_key: `b66-f-${Date.now()}`, goal: "再详细些", followup_of: r.run_id, model: "legal/k2.6" }), /沿用上一轮的模型（K3），不能中途换/);
  } finally {
    client.start = orig;
  }
});
