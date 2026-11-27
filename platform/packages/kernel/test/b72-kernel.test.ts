/**
 * 第 72 批（V46）内核：
 * - D-299 第 4 条（A1 M3）：内核自发的模型调用在所选模型已不可用时明确失败（记运行记录、给律师话），不再静默改用 K3；
 * - D-299 第 6 条（A1 M7）：模型目录信封的纪元——纪元不同按签发时刻比（云端路由状态重建后版本号从头数起），旧纪元的旧信封重放仍不采用；
 *   原因 same_upstream 收下并说明；内置口径 K2.6 进任务入口、内置本机型号 K3 → kimi-k3.1-pro；
 * - 问答“记住所选”走 models.select("qa")，没带 route 时 chat.send 用它；
 * - A1 S3：闸门运行时摘要按元数据记一次（主进程交来 / 本进程算过），文件变了就重算；
 * - A1 S7：关闭本机端点不被空闲长连接拖住；
 * - A1 H2：首次同步是否“成了”的判定；
 * - 契约 §7 纯函数：工作空间列表（local_profile）、邀请码、团队名称、账号元数据。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b72-kernel-secret-0123456789abcdef";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEnvelope, sealEnvelope } from "@zr-legal/firm-trust";
import { buildRoutes } from "@zr-legal/model-broker";
import { BUILTIN_CATALOG, catalogNewer, catalogReasonText, ModelCatalogService, sanitizeCatalog } from "../src/services/model-catalog.ts";
import { isModelGone, kernelRouteOf, MODEL_GONE_TEXT, reviewFailureReason } from "../src/executor/executor.ts";
import { gateUpstreamsFromEnv } from "../src/egress/kernel-gate.ts";
import { attestRuntime, forgetRuntimeStamps, rememberRuntime, runtimeAlreadyVerified, runtimeStampOf, sanitizeRuntimeStamp } from "../src/egress/runtime-stamp.ts";
import { closeServerPromptly } from "../src/index.ts";
import { firstSyncDone } from "../src/control-plane/client.ts";
import { accountMetaOf, inviteCodeOf, readAccountMeta, teamNameOf, workspaceItems, writeAccountMeta } from "../src/services/workspaces.ts";
import { makeKernel, type TestKernel } from "./helpers.ts";

// ─── M3：所选模型已不可用 → 明确失败 ───

test("内核自发调用：所选别名本机路由已不认 → 记运行记录并抛“所选模型已停用，请重新发起”，不改用 K3", () => {
  const ops: unknown[][] = [];
  const db = {
    get: (sql: string) => (sql.includes("FROM runs") ? { model: "legal/k3-fast" } : sql.includes("FROM tool_operations") ? undefined : undefined),
    run: (_sql: string, params: unknown[]) => {
      ops.push(params);
      return { changes: 1 };
    },
  } as any;
  const broker = { resolveRoute: (a: string) => (a === "legal/k3" ? {} : (() => { throw new Error(`未知模型路由 "${a}"`); })()) } as any;
  let err: unknown = null;
  try {
    kernelRouteOf({ db, broker }, "run_1", "att_1", "independent_review");
  } catch (e) {
    err = e;
  }
  assert.ok(err, "不再静默返回 legal/k3");
  assert.equal(isModelGone(err), true);
  assert.match((err as Error).message, /所选模型已停用，请重新发起/);
  assert.deepEqual((err as any).detail, { reason: "model_unavailable", model: "legal/k3-fast", step: "independent_review", retryable: false });
  // 运行记录：tool_operations(model / route_unavailable, failed)
  const row = ops.find((p) => p.includes("route_unavailable"));
  assert.ok(row && row.includes("failed") && row.includes("run_1") && row.includes("att_1"), JSON.stringify(ops));
  // 别名仍认得：原样返回
  const ok = { db: { ...db, get: () => ({ model: "legal/k3" }) }, broker };
  assert.equal(kernelRouteOf(ok, "run_2", "att_2", "review_analysis"), "legal/k3");
  // 复核没做成的原因：如实写给律师
  assert.equal(reviewFailureReason(MODEL_GONE_TEXT), MODEL_GONE_TEXT);
  assert.equal(reviewFailureReason("upstream 500"), "AI 服务调用失败");
});

// ─── M7：纪元 ───

const TID = "ten_b72";
const key = generateKeyPairSync("ed25519");
const open = (e: unknown) => {
  const o = openEnvelope(e, "kwl-model-catalog", new Map([["k1", key.publicKey]]));
  return o.ok ? o.body : null;
};
const seal = (body: unknown) => sealEnvelope("kwl-model-catalog", body, { kid: "k1", privateKey: key.privateKey });
const model = (id: string, o: Record<string, unknown> = {}) => ({ id, label: id.replace("legal/", "").toUpperCase(), description: null, sort: 50, thinking: "effort", efforts: ["low", "high"], capabilities: ["tool_use", "thinking"], scopes: ["qa", "task"], max_context: 131072, default: false, available: true, reason: null, ...o });
const doc = (version: number, at: string, models: Record<string, unknown>[], epoch?: string) => ({ version, ...(epoch ? { epoch } : {}), issued_at: at, tid: TID, uid: "usr_x", default: "legal/k3", models });

test("目录纪元：纯函数——同纪元照旧比版本；纪元不同按签发时刻；格式不对的纪元整份不收；same_upstream 收下并说明", () => {
  const a = { version: 40, issued_at: "2026-11-27T08:00:00Z", epoch: "EpochAAAAAAAAAAAAAAAAA" };
  assert.equal(catalogNewer({ version: 3, issued_at: "2026-11-27T09:00:00Z", epoch: "EpochAAAAAAAAAAAAAAAAA" }, a), false, "同纪元版本低不采用");
  assert.equal(catalogNewer({ version: 3, issued_at: "2026-11-27T09:00:00Z", epoch: "EpochBBBBBBBBBBBBBBBBB" }, a), true, "新纪元：版本从头数起也采用");
  assert.equal(catalogNewer({ version: 99, issued_at: "2026-11-27T07:00:00Z", epoch: "EpochOLDOLDOLDOLDOLDOL" }, a), false, "旧纪元的旧信封重放：签发时刻早于本机这份，不采用");
  assert.equal(catalogNewer({ version: 3, issued_at: "2026-11-27T09:00:00Z", epoch: "EpochBBBBBBBBBBBBBBBBB" }, { version: 40, issued_at: "2026-11-27T08:00:00Z" }), true, "旧云端（无纪元）→ 新云端（有纪元）");
  assert.equal(catalogNewer({ version: 3, issued_at: "2026-11-27T09:00:00Z" }, { version: 40, issued_at: "2026-11-27T08:00:00Z" }), false, "两边都没有纪元：与第 66 批相同");
  assert.equal(sanitizeCatalog(doc(1, "2026-11-27T08:00:00Z", [model("legal/k3")], "bad epoch!"), TID), null);
  const sv = sanitizeCatalog(doc(1, "2026-11-27T08:00:00Z", [model("legal/k3"), model("legal/k2.6", { available: false, reason: "same_upstream" })], "EpochAAAAAAAAAAAAAAAAA"), TID)!;
  assert.equal(sv.epoch, "EpochAAAAAAAAAAAAAAAAA");
  const k26 = sv.models.find((m) => m.id === "legal/k2.6")!;
  assert.deepEqual([k26.available, k26.reason], [false, "same_upstream"]);
  assert.equal(catalogReasonText("same_upstream"), "运营尚未给它配置独立的模型");
  assert.equal(sanitizeCatalog(doc(1, "2026-11-27T08:00:00Z", [model("legal/k3")]), TID)!.epoch, null, "旧云端没有纪元");
});

test("目录服务：云端路由状态重建（新纪元、版本变小）后采用新目录；之后重放旧纪元的信封不采用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-b72-cat-"));
  let next: unknown = seal(doc(40, "2026-11-27T08:00:00.000Z", [model("legal/k3"), model("legal/old")], "EpochAAAAAAAAAAAAAAAAA"));
  const svc = new ModelCatalogService({ pull: async () => next, open, tenantId: TID, cacheFile: join(dir, "model-catalog.json") });
  assert.equal(await svc.refresh("t"), "updated");
  next = seal(doc(2, "2026-11-27T09:00:00.000Z", [model("legal/k3"), model("legal/new")], "EpochBBBBBBBBBBBBBBBBB"));
  assert.equal(await svc.refresh("t"), "updated", "此前会一直 stale（版本 2 < 40）");
  assert.deepEqual(svc.models().map((m) => m.id), ["legal/k3", "legal/new"]);
  assert.equal(svc.state().epoch, "EpochBBBBBBBBBBBBBBBBB");
  next = seal(doc(41, "2026-11-27T08:30:00.000Z", [model("legal/k3"), model("legal/old")], "EpochAAAAAAAAAAAAAAAAA"));
  assert.equal(await svc.refresh("t"), "stale", "旧纪元重放回来不采用");
  // 缓存读回：仍是新纪元那份
  const again = new ModelCatalogService({ pull: async () => next, open, tenantId: TID, cacheFile: join(dir, "model-catalog.json") });
  assert.equal(again.state().epoch, "EpochBBBBBBBBBBBBBBBBB");
});

test("内置口径：K2.6 进任务入口；内置本机型号 K3 → kimi-k3.1-pro、K2.6 → kimi-k2.6（模型路由与自带密钥映射同口径）", () => {
  assert.deepEqual(BUILTIN_CATALOG.find((m) => m.id === "legal/k2.6")!.scopes, ["qa", "task"]);
  assert.ok(BUILTIN_CATALOG.find((m) => m.id === "legal/k2.6")!.capabilities.includes("tool_use"));
  const r = buildRoutes({});
  assert.deepEqual([r["legal/k3"]!.providerModel, r["legal/k2.6"]!.providerModel], ["kimi-k3.1-pro", "kimi-k2.6"]);
  assert.equal(buildRoutes({ ZR_MODEL_K3: "kimi-k3" })["legal/k3"]!.providerModel, "kimi-k3", "本机配置仍可覆盖");
  const up = gateUpstreamsFromEnv({ ZR_BYOK_BASE: "https://byok.example/v1", ZR_BYOK_API_KEY: "k" } as any, null);
  assert.deepEqual(up.byok?.models, { "legal/k3": "kimi-k3.1-pro", "legal/k2.6": "kimi-k2.6" });
  // 不在任务入口的仍不能用于任务（目录里只进问答的模型）
  const svc = new ModelCatalogService({ pull: null, open, tenantId: TID, cacheFile: null });
  assert.equal(svc.check("legal/k2.6", "task").ok, true);
  const qaOnly = sanitizeCatalog(doc(1, "2026-11-27T08:00:00Z", [model("legal/k3"), model("legal/qa-lite", { scopes: ["qa"], capabilities: [] })]), TID)!;
  const svc2 = new ModelCatalogService({ pull: async () => seal(qaOnly), open, tenantId: TID, cacheFile: null });
  return svc2.refresh("t").then(() => {
    const c = svc2.check("legal/qa-lite", "task");
    assert.equal(c.ok, false);
    assert.equal((c as { reason: string }).reason, "no_tool_use");
  });
});

// ─── 问答记住所选：models.select("qa") → chat.send 不带 route 时用它 ───

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "b72-kernel-firm");
});
after(async () => {
  await tk?.kernel.close();
});

test("问答记住所选：models.select({scope:qa}) 之后 chat.send 不带 route 用记住的模型；带了 route 仍按所带", async () => {
  const { inv } = tk;
  assert.deepEqual(await inv("models.select", { scope: "qa", id: "legal/k2.6" }), { ok: true, scope: "qa", selected: "legal/k2.6", label: "K2.6" });
  const r1 = (await inv("chat.send", { text: "合同解除的法定事由有哪些？" })) as any;
  assert.equal(r1.messages.at(-1).route, "legal/k2.6", "没带 route：用 model_prefs(qa)");
  const r2 = (await inv("chat.send", { conversation_id: r1.conversation_id, text: "那么约定解除呢？", route: "legal/k3" })) as any;
  assert.equal(r2.messages.at(-1).route, "legal/k3");
  await inv("models.select", { scope: "qa", id: "legal/k3" });
  const r3 = (await inv("chat.send", { conversation_id: r1.conversation_id, text: "第三问" })) as any;
  assert.equal(r3.messages.at(-1).route, "legal/k3");
});

test("kernel.status：开发形态的工作空间类型未知为 null；这台电脑的证书由律所根签发（firm_root）", async () => {
  const st = (await tk.inv("kernel.status")) as any;
  assert.equal(st.workspace_kind, null);
  assert.equal(st.device_issuer, "firm_root");
});

// ─── S3：闸门运行时摘要按元数据记一次 ───

test("闸门运行时：主进程交来的核对结果在元数据不变时免重算；文件一变（大小、修改时刻、变更时刻）就作废、重算", () => {
  forgetRuntimeStamps();
  const dir = mkdtempSync(join(tmpdir(), "kwl-b72-rt-"));
  const bin = join(dir, "kwl-egress-node");
  writeFileSync(bin, "node-binary-v1");
  const sha = "a".repeat(64);
  const meta = runtimeStampOf(bin)!;
  assert.ok(meta && /^\d+$/.test(meta.ino) && /^\d+$/.test(meta.ctime_ns));
  assert.equal(sanitizeRuntimeStamp({ path: bin, sha256: "xyz", ...meta }), null, "摘要格式不对不收");
  assert.equal(runtimeAlreadyVerified(bin, sha), null, "没交过");
  assert.equal(attestRuntime({ path: bin, sha256: sha, ...meta }), true);
  assert.equal(runtimeAlreadyVerified(bin, sha), "attested");
  assert.equal(runtimeAlreadyVerified(bin, "b".repeat(64)), null, "期望摘要不同不认");
  // 改了内容（大小变）→ 作废
  writeFileSync(bin, "node-binary-v2-tampered");
  assert.equal(runtimeAlreadyVerified(bin, sha), null);
  assert.equal(runtimeAlreadyVerified(bin, sha), null, "作废后不再认");
  // 本进程算过：算前算后元数据一致才记
  const before2 = runtimeStampOf(bin);
  rememberRuntime(bin, sha, before2);
  assert.equal(runtimeAlreadyVerified(bin, sha), "cached");
  // 只改修改时刻（同大小、同 inode）也作废
  utimesSync(bin, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
  assert.equal(runtimeAlreadyVerified(bin, sha), null);
  // 算的过程中文件变了：不记
  const stale = runtimeStampOf(bin)!;
  writeFileSync(bin, "node-binary-v3-changed-during-hash");
  rememberRuntime(bin, sha, stale);
  assert.equal(runtimeAlreadyVerified(bin, sha), null);
  forgetRuntimeStamps();
});

// ─── S7：关闭本机端点不被空闲长连接拖住 ───

test("关闭本机端点：有空闲 keep-alive 连接时也在 1 秒内关完（原来要等连接自然超时）", async () => {
  const srv = createServer({ keepAliveTimeout: 60_000 }, (_req, res) => res.end("ok"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  const agent = new (await import("node:http")).Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.end();
  });
  const t0 = Date.now();
  await closeServerPromptly(srv);
  assert.ok(Date.now() - t0 < 1_000, `用了 ${Date.now() - t0} 毫秒`);
  agent.destroy();
});

// ─── H2：首次同步是否“成了” ───

test("首次同步判定：登记上且席位令牌在手才算成；许可还没取到要重试；因吊销 / 到期跳过的不再重试", () => {
  const rep = (steps: Record<string, string>) => ({ at: "", ok: false, steps });
  assert.equal(firstSyncDone(rep({ register: "error:cp_unreachable" })), false);
  assert.equal(firstSyncDone(rep({ register: "ok", seat: "accepted" })), true);
  assert.equal(firstSyncDone(rep({ register: "ok", seat: "valid" })), true);
  assert.equal(firstSyncDone(rep({ register: "ok", seat: "error:cp_unreachable" })), false);
  assert.equal(firstSyncDone(rep({ register: "ok", seat: "skipped:license_missing" })), false, "许可没取到：重试");
  assert.equal(firstSyncDone(rep({ register: "ok", seat: "skipped:device_revoked" })), true, "吊销：重试也不会好");
  assert.equal(firstSyncDone(rep({ register: "ok" })), false);
});

// ─── 契约 §7 纯函数 ───

test("工作空间列表：只取已知字段、个人在前；local_profile 按（律所编号 + 成员标识）对，云端不带成员标识时按律所编号", () => {
  const profiles = [
    { tid: "ten_personal_a", member_slug: "wang" },
    { tid: "ten_team_x", member_slug: "wang" },
  ];
  const cur = { tid: "ten_personal_a", member_slug: "wang" };
  const items = workspaceItems(
    [
      { aid: "acc_t2", tid: "ten_team_y", kind: "team", name: "乙律师事务所", role: "lawyer", status: "active", current: false },
      { aid: "acc_t1", tid: "ten_team_x", kind: "team", name: "甲律师事务所", role: "admin", status: "active", current: false, member_slug: "wang" },
      { aid: "acc_p", tid: "ten_personal_a", kind: "personal", name: "王律师的工作室", role: "admin", status: "active", current: true, secret: "x" },
      { aid: "bad aid", tid: "ten_z", kind: "team" },
      { aid: "acc_k", tid: "ten_k", kind: "org" },
    ],
    profiles,
    cur,
  );
  assert.deepEqual(items.map((w) => [w.aid, w.kind, w.current, w.local_profile]), [
    ["acc_p", "personal", true, true],
    ["acc_t1", "team", false, true],
    ["acc_t2", "team", false, false],
  ]);
  assert.equal(JSON.stringify(items).includes("secret"), false, "不认识的字段丢掉");
  assert.equal(workspaceItems([{ aid: "acc_t1", tid: "ten_team_x", kind: "team", name: "甲", member_slug: "li" }], profiles, cur)[0]!.local_profile, false, "同一律所别人的档案不算");
});

test("邀请码、团队名称、账号元数据：规整与本机小记录", () => {
  assert.equal(inviteCodeOf(" abcd-efgh-2345-6789 "), "ABCD-EFGH-2345-6789");
  assert.equal(inviteCodeOf("ABCDEFGH23456789"), "ABCD-EFGH-2345-6789");
  assert.equal(inviteCodeOf("ABCD-EFGH-2345"), null);
  assert.equal(teamNameOf(" 某某律师事务所 "), "某某律师事务所");
  assert.equal(teamNameOf("某"), null);
  assert.equal(teamNameOf("x".repeat(41)), null);
  assert.deepEqual(accountMetaOf({ workspace: { kind: "team" }, onboarding: { state: "ready" } }), { workspace_kind: "team" }, "登记状态不是上手状态");
  assert.deepEqual(accountMetaOf({ onboarding: { state: "ready", completed_at: "2026-11-27T08:00:00Z", dismissed_at: null } }), { onboarding: { completed_at: "2026-11-27T08:00:00Z", dismissed_at: null } });
  assert.deepEqual(accountMetaOf({ account_onboarding: { completed_at: null, dismissed_at: "2026-11-27T08:00:00Z" } }), { onboarding: { completed_at: null, dismissed_at: "2026-11-27T08:00:00Z" } });
  assert.equal(accountMetaOf({ account: {} }), null);
  const dir = mkdtempSync(join(tmpdir(), "kwl-b72-meta-"));
  assert.equal(readAccountMeta(dir), null);
  const m1 = writeAccountMeta(dir, null, { workspace_kind: "personal" });
  const m2 = writeAccountMeta(dir, m1, { onboarding: { completed_at: null, dismissed_at: "2026-11-27T08:00:00Z" } });
  assert.deepEqual([m2.workspace_kind, m2.onboarding?.dismissed_at], ["personal", "2026-11-27T08:00:00Z"], "合并写");
  assert.deepEqual(readAccountMeta(dir)?.workspace_kind, "personal");
});
