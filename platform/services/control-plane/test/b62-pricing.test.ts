/**
 * 第 62 批：模型定价与计费体系修正（契约 platform/docs/contract-b62-pricing.md）。
 *
 * 逐项与手算对账（单价元/百万 token × token = 微元）：
 * - 计费 token 四档互斥：未命中 + 命中 + 缓存写入（5 分钟 / 1 小时）= prompt_tokens；输出含推理（真实 MaaS usage 形状见 legal-gateway 用例）；
 * - 价目按上游真实型号：成本缺省取官方价，售价 = 成本 × 倍率（全局 1.0，可按型号覆盖）或显式售价；别名切到 highspeed 售价与成本跟着走；
 * - 价目版本化：下一请求起生效，历史行不改写；按别名的旧版本仍按别名计；
 * - 估算的用量（上游没给）不当作实测：不扣额度、不计售价与成本，另记估算、待对账；partial（D-194）同；上游错误不计；重发按请求编号去重；
 * - 读回迁移（第 62 批之前的状态）：价目 v2（按别名）→ 按型号；tokens 套餐 × 4.2 元/百万 token → 金额；价目生效前的行折成“迁移前已用”；
 *   幂等（再启动不重迁）、可还原（还原后不再自动迁移）；
 * - 汇总：价目生效前的行如实标出，另给“按现行价估算”（只读）；按上游型号分组。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, createControlPlane, devControlPlaneKeys, UsageBook, type ControlPlane, type StateStore } from "../src/index.ts";
import { amountOf, billedOf, bootstrapRouting, currentPrices, migratePricingToModels, modelRates, OFFICIAL_PRICES, reserveRates, resolvePrice, setPrices, setPricing, unpricedAliasesIn, upsertModel, upsertProvider, validatePricing } from "../src/routing.ts";
import { B62_CNY_PER_MTOK, catalogFromConfig, CNY_CATALOG, tokensToCny } from "../src/billing.ts";
import { call, devStaffOf, staffClient } from "./staff-fixture.ts";

const T0 = Date.parse("2026-11-24T04:00:00Z");
/** 接口里的金额（元）保留 4 位小数（微元 → 元，与 server.ts cny() 同）；逐请求的精确值看行里的 value_micro。 */
const y4 = (micro: number) => Math.round(micro / 100) / 10_000;

// ─── 纯函数：计费 token 与金额 ───

test("计费 token 四档互斥、相加 = prompt_tokens；不一致的数依次夹住；输出含推理", () => {
  // 真实 MaaS（kimi-k3.1-pro，2026-11-24）首次请求：prompt 9114，写入 8960（5 分钟），无命中
  assert.deepEqual(billedOf({ input: 9114, cached: 0, output: 125, reasoning: 86, cache_write: 8960 }), { uncached: 154, cached: 0, cache_write_5m: 8960, cache_write_1h: 0, output: 125, reasoning: 86 });
  // 第二次：命中 8960、写入 0
  assert.deepEqual(billedOf({ input: 9114, cached: 8960, output: 94, reasoning: 67 }), { uncached: 154, cached: 8960, cache_write_5m: 0, cache_write_1h: 0, output: 94, reasoning: 67 });
  // ttl=1h：写入 7168 全是 1 小时
  assert.deepEqual(billedOf({ input: 7317, cached: 0, output: 103, cache_write: 7168, cache_write_1h: 7168 }), { uncached: 149, cached: 0, cache_write_5m: 0, cache_write_1h: 7168, output: 103, reasoning: 0 });
  // 夹住：命中 + 写入 > 输入、1 小时写入 > 写入、推理 > 输出
  const b = billedOf({ input: 100, cached: 80, output: 5, reasoning: 9, cache_write: 50, cache_write_1h: 70 });
  assert.deepEqual(b, { uncached: 0, cached: 80, cache_write_5m: 0, cache_write_1h: 20, output: 5, reasoning: 5 });
  assert.equal(b.uncached + b.cached + b.cache_write_5m + b.cache_write_1h, 100);
  // 负数、小数、非数
  assert.deepEqual(billedOf({ input: -3, cached: Number.NaN, output: 2.9 }), { uncached: 0, cached: 0, cache_write_5m: 0, cache_write_1h: 0, output: 2, reasoning: 0 });
});

test("金额（微元）：未命中 × 输入价 + 命中 × 命中价 + 写入 × 写入价（5 分钟 / 1 小时）+ 输出 × 输出价；缺价回退；输入或输出价缺 = 未定价", () => {
  const k31 = { input: 13, cached_input: 1.3, cache_write: 13, cache_write_1h: 26, output: 68 };
  // 154×13 + 8960×13 + 125×68 = 2002 + 116480 + 8500
  assert.equal(amountOf(k31, billedOf({ input: 9114, cached: 0, output: 125, cache_write: 8960 })), 126_982);
  // 154×13 + 8960×1.3 + 94×68 = 2002 + 11648 + 6392
  assert.equal(amountOf(k31, billedOf({ input: 9114, cached: 8960, output: 94 })), 20_042);
  // 1 小时写入：149×13 + 7168×26 + 103×68 = 1937 + 186368 + 7004
  assert.equal(amountOf(k31, billedOf({ input: 7317, cached: 0, output: 103, cache_write: 7168, cache_write_1h: 7168 })), 195_309);
  // 回退：命中价、写入价都缺 → 按输入价；1 小时缺 → 按 5 分钟
  assert.equal(amountOf({ input: 10, cached_input: null, cache_write: null, cache_write_1h: null, output: 20 }, { uncached: 1, cached: 2, cache_write_5m: 3, cache_write_1h: 4, output: 5, reasoning: 0 }), (1 + 2 + 3 + 4) * 10 + 5 * 20);
  assert.equal(amountOf({ input: 10, cached_input: 1, cache_write: 12, cache_write_1h: null, output: 20 }, { uncached: 0, cached: 0, cache_write_5m: 0, cache_write_1h: 4, output: 0, reasoning: 0 }), 48);
  assert.equal(amountOf({ input: null, cached_input: 1, cache_write: null, cache_write_1h: null, output: 20 }, billedOf({ input: 1, output: 1 })), null);
  assert.equal(amountOf({ input: 1, cached_input: 1, cache_write: null, cache_write_1h: null, output: null }, billedOf({ input: 1, output: 1 })), null);
});

/** 生产同形的路由：legal/k3 → kimi-k3.1-pro，legal/k2.6 → kimi-k2.6。 */
const prodRouting = () => bootstrapRouting(T0, { provider: { base_url: "https://maas.jointpilot.com/v1", id: "csi-maas" }, models: { "legal/k3": "kimi-k3.1-pro", "legal/k2.6": "kimi-k2.6" } });

test("价目按上游型号：成本缺省官方价（写明来源）、售价 = 成本 × 倍率（全局 / 按型号）或显式售价；别名切到 highspeed 售价与成本跟着走", () => {
  const r = prodRouting();
  const v = setPricing(r, { markup: 1.2, models: { "kimi-k3.1-pro": {}, "kimi-k3.1-pro-highspeed": { markup: 1.5 }, "kimi-k2.6": { sale: { output: 30 } }, "my-private-1": { cost: { input: 1, output: 2 } } } }, T0, "stf_1");
  const t = currentPrices(r);
  assert.deepEqual([t.version, t.basis, t.markup], [v, "model", 1.2]);
  assert.equal(t.models!["kimi-k3.1-pro"]!.cost_source, "Kimi 官方定价 https://platform.kimi.com/docs/pricing/chat（2026-11-24 抓取）");
  assert.deepEqual(t.models!["kimi-k3.1-pro"]!.cost, { input: 13, cached_input: 1.3, cache_write: 13, cache_write_1h: 26, output: 68 });
  assert.deepEqual(modelRates(t, "kimi-k3.1-pro")!.sale, { input: 15.6, cached_input: 1.56, cache_write: 15.6, cache_write_1h: 31.2, output: 81.6 }, "全局 1.2 倍");
  assert.deepEqual(modelRates(t, "kimi-k3.1-pro-highspeed")!.sale, { input: 39, cached_input: 1.95, cache_write: 39, cache_write_1h: 78, output: 204 }, "按型号 1.5 倍");
  assert.deepEqual(modelRates(t, "kimi-k2.6")!.sale, { input: 7.8, cached_input: 1.32, cache_write: null, cache_write_1h: null, output: 30 }, "显式售价只覆盖给了的项");
  assert.equal(t.models!["my-private-1"]!.cost_source, "运营录入");
  assert.deepEqual(OFFICIAL_PRICES["kimi-k3"], { label: "Kimi K3", input: 20, cached_input: 2, cache_write: 20, cache_write_1h: 40, output: 100 });
  // 按实际服务的型号计价；记录没带型号时取别名当前首选目标
  assert.equal(resolvePrice(t, r, "legal/k3", "kimi-k3.1-pro")!.rates.sale.output, 81.6);
  assert.equal(resolvePrice(t, r, "legal/k3", null)!.key, "kimi-k3.1-pro");
  assert.equal(resolvePrice(t, r, "legal/k3", "not-priced"), null, "没定价的型号 = 未定价（不回退到别名）");
  // 派生给旧版网关的按别名格式
  assert.deepEqual([t.items["legal/k3"]!.input, t.items["legal/k3"]!.cost_input, t.items["legal/k2.6"]!.output], [15.6, 13, 30]);
  // 别名切到 highspeed：不改价目，售价与成本跟着型号走；派生格式同步
  upsertModel(r, "legal/k3", { targets: [{ provider: "csi-maas", model: "kimi-k3.1-pro-highspeed", priority: 1 }] }, T0 + 1, "stf_1");
  assert.equal(currentPrices(r).version, v, "换目标不产生新价目版本");
  assert.equal(resolvePrice(currentPrices(r), r, "legal/k3", null)!.rates.sale.output, 204);
  assert.equal(resolvePrice(currentPrices(r), r, "legal/k3", null)!.rates.cost.output, 136);
  assert.equal(currentPrices(r).items["legal/k3"]!.output, 204);
  // 校验
  assert.throws(() => validatePricing({ markup: 0, models: {} }), /加价倍率/);
  assert.throws(() => validatePricing({ models: { "bad model!": {} } }), /上游型号不合法/);
  assert.throws(() => validatePricing({ models: { "kimi-k3": { cost: { input: -1 } } } }), /成本价/);
  assert.equal(validatePricing({ models: { "unknown-x": {} } }).models["unknown-x"]!.cost.input, null, "不在官方价表的型号不给缺省（未定价）");
});

test("预占取各目标里最贵的一档、有目标没价即未定价；金额套餐要求别名的每个目标都有售价（备用目标没价会按 0 元放行）", () => {
  const r = prodRouting();
  upsertProvider(r, "backup", { label: "备用", vendor: "csi-maas", base_url: "https://maas-b.example.test/v1", use_local_key: true }, T0, null, null);
  upsertModel(r, "legal/k3", { targets: [{ provider: "csi-maas", model: "kimi-k3.1-pro", priority: 1 }, { provider: "backup", model: "kimi-k3.1-pro-highspeed", priority: 2 }] }, T0, null);
  setPricing(r, { models: { "kimi-k3.1-pro": {}, "kimi-k3.1-pro-highspeed": {}, "kimi-k2.6": {} } }, T0, null);
  assert.deepEqual(reserveRates(currentPrices(r), r, "legal/k3"), { input: 26, cached_input: 1.3, cache_write: 26, cache_write_1h: 52, output: 136 });
  assert.deepEqual(unpricedAliasesIn(r, currentPrices(r), null), []);
  setPricing(r, { models: { "kimi-k3.1-pro": {}, "kimi-k2.6": {} } }, T0, null);
  assert.equal(reserveRates(currentPrices(r), r, "legal/k3"), null);
  assert.deepEqual(unpricedAliasesIn(r, currentPrices(r), null), ["legal/k3"], "备用目标没价：列出");
  assert.deepEqual(unpricedAliasesIn(r, currentPrices(r), ["legal/k2.6"]), []);
});

test("迁移 v2（按别名）→ 按上游型号：与官方价一致的不另设覆盖；不一致的记显式售价；缓存价留空按旧口径（= 输入价）；幂等", () => {
  const r = prodRouting();
  // 线上 v2：legal/k3 13 / 1.3 / 68，legal/k2.6 6.5 / 1.1 / 27，成本全空
  setPrices(r, { "legal/k3": { input: 13, cached_input: 1.3, output: 68 }, "legal/k2.6": { input: 6.5, cached_input: 1.1, output: 27 } }, T0, "stf_1");
  const v2 = currentPrices(r).version;
  const m = migratePricingToModels(r, T0 + 1)!;
  assert.deepEqual([m.from, m.to], [v2, v2 + 1]);
  const t = currentPrices(r);
  assert.deepEqual([t.basis, t.by, t.markup], ["model", "migration:b62", 1]);
  assert.equal(t.models!["kimi-k3.1-pro"]!.sale, null, "与官方价 × 1.0 一致：不设覆盖（以后切型号即跟着型号的价走）");
  assert.equal(t.models!["kimi-k2.6"]!.sale, null);
  assert.ok(t.models!["kimi-k3.1-pro-highspeed"], "官方价表的其他型号也带上（别名切过去即有价）");
  assert.equal(migratePricingToModels(r, T0 + 2), null, "幂等：已按型号不再迁");
  // 同一份 usage，迁移前（v2 按别名）与迁移后（按型号）金额一致；旧版本仍按别名计
  const u = billedOf({ input: 9626, cached: 512, output: 6881, reasoning: 6139 });
  const before = amountOf(resolvePrice(r.prices.find((x) => x.version === v2)!, r, "legal/k3", "kimi-k3.1-pro")!.rates.sale, u);
  const after = amountOf(resolvePrice(t, r, "legal/k3", "kimi-k3.1-pro")!.rates.sale, u);
  // (9626−512)×13 + 512×1.3 + 6881×68 = 118482 + 665.6 + 467908 = 587,055.6 → 587,056（与线上 value_micro 复算同一口径）
  assert.deepEqual([before, after], [587_056, 587_056]);
  assert.equal(resolvePrice(r.prices.find((x) => x.version === v2)!, r, "legal/k3", "kimi-k3.1-pro")!.basis, "alias");
  // 售价与官方价不一致、缓存价留空：显式记下（按旧口径：命中、写入都按输入价）
  const r2 = prodRouting();
  setPrices(r2, { "legal/k3": { input: 4, output: 16, cost_input: 2, cost_output: 8 } }, T0, null);
  migratePricingToModels(r2, T0);
  const row = currentPrices(r2).models!["kimi-k3.1-pro"]!;
  assert.deepEqual(row.sale, { input: 4, cached_input: 4, cache_write: 4, cache_write_1h: null, output: 16 });
  assert.match(row.cost_source!, /迁移自第 2 版/);
  assert.deepEqual([row.cost.input, row.cost.output], [2, 8]);
  assert.equal(amountOf(modelRates(currentPrices(r2), "kimi-k3.1-pro")!.sale, billedOf({ input: 12_000, cached: 5_000, output: 3_000 })), 12_000 * 4 + 3_000 * 16, "与旧口径（命中价留空按输入价）一致");
});

test("目录：进程内缺省仍是 tokens（既有用例）；给了 billing 段（生产入口）缺省金额套餐 210 / 525 / 1,260 / 84 元；系数 4.2 = 实测混合单价 4.19 向上取一位", () => {
  assert.equal(catalogFromConfig(undefined).plans[0]!.quota_unit, "tokens");
  const c = catalogFromConfig({});
  assert.deepEqual(c.plans.map((p) => [p.id, p.quota_unit, p.seat_quota]), [["standard", "cny", 210], ["pro", "cny", 525], ["max", "cny", 1260], ["trial", "cny", 84]]);
  assert.equal(c.migrations?.b62_billing?.status, "native", "新建的目录不走读回迁移");
  assert.deepEqual(CNY_CATALOG.plans.find((p) => p.id === "trial")!.burst, { hours: 5, pct: 50 });
  // 线上 607 行：输入 6,049 万（命中 5,362 万）、输出 148 万，按 v2 价
  const yuan = ((60_490_000 - 53_620_000) * 13 + 53_620_000 * 1.3 + 1_480_000 * 68) / 1e6;
  const perM = yuan / ((60_490_000 + 1_480_000) / 1e6);
  assert.equal(Math.round(perM * 100) / 100, 4.19);
  assert.equal(B62_CNY_PER_MTOK, 4.2);
  assert.ok(B62_CNY_PER_MTOK >= perM, "向上取整：换算后的额度不少于原额度的等价金额");
  assert.deepEqual([tokensToCny(50_000_000), tokensToCny(125_000_000), tokensToCny(300_000_000), tokensToCny(20_000_000)], [210, 525, 1260, 84]);
});

// ─── 集成：读回迁移、入账口径、价目接口、汇总、还原 ───

const SECRET = "b62-pricing-service-secret-0123456789ab";
const PW = "Lawyer2026secure";

function memStore(): StateStore & { data: string | null } {
  return {
    data: null as string | null,
    load() {
      return this.data;
    },
    save(json: string) {
      this.data = json;
    },
  } as StateStore & { data: string | null };
}

/** 断言失败时也要关掉还开着的控制面（否则进程挂住）。 */
const open = new Set<() => Promise<void>>();
after(async () => {
  for (const c of [...open]) await c();
});

async function boot(o: { store: StateStore; usageDir: string; billing?: unknown }) {
  const cp = createControlPlane({
    keys: devControlPlaneKeys(),
    serviceSecret: SECRET,
    stateStore: o.store,
    usageBook: new UsageBook({ dir: o.usageDir }),
    devStaff: devStaffOf({ sys_1: ["sysadmin", "operator"], fin_1: ["finance"] }),
    routing: { bootstrap: { provider: { id: "csi-maas", base_url: "https://maas.jointpilot.com/v1" }, models: { "legal/k3": "kimi-k3.1-pro", "legal/k2.6": "kimi-k2.6" } }, key_id: "0123456789abcdef" },
    ...(o.billing !== undefined ? { billing: o.billing as never } : {}),
  });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  const ops = staffClient(() => base);
  const close = async () => {
    open.delete(close);
    cp.server.closeAllConnections();
    await new Promise<void>((r) => cp.server.close(() => r()));
  };
  open.add(close);
  return { cp, base, ops, close, service: (path: string, body: unknown) => call(base, "POST", path, body, { authorization: `Bearer ${SECRET}` }) };
}

/** 运营开通律所 → 负责人凭码注册 → 创始开通 → 登记设备（与 b44 用例同一流程）。 */
async function opsFirm(env: Awaited<ReturnType<typeof boot>>, tid: string, email: string, plan?: string) {
  const { cp, base, ops } = env;
  assert.equal((await ops("sys_1", "POST", "/v1/ops/tenants", { tid, name: `${tid} 律所`, edition: "team", seats: 3, ...(plan ? { plan } : {}) })).status, 200);
  const code = cp.ops.issueActivationCode(tid, { member: { slug: "boss" } });
  const reg = await call(base, "POST", "/v1/auth/register", { email, password: PW, name: "王主任", code: code.code });
  assert.equal(reg.status, 200, reg.text);
  const root = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  assert.equal((await call(base, "POST", "/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: reg.json.onboarding.claim.activation_id, claim_secret: reg.json.onboarding.claim.claim_secret })).status, 200);
  const k = generateDeviceKeys();
  const memberId = `usr_${tid.slice(4)}_boss`;
  const deviceId = accountDeviceId(tid.slice(4), "boss", 1);
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `c_${tid}`, memberId, deviceId, role: "admin", signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400_000 * 365).toISOString() });
  const raw = JSON.stringify({ tid, cert });
  const h = signDeviceRequest({ method: "POST", path: "/v1/devices/register", body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
  assert.equal((await fetch(`${base}/v1/devices/register`, { method: "POST", headers: { ...h, "content-type": "application/json", "x-kwl-session": reg.json.session_token }, body: raw })).status, 200);
  const sid = cp.ops.tenant(tid)!.seatsByUser.get(memberId)!.sid;
  return { tid, memberId, deviceId, sid, aid: reg.json.account.aid as string };
}

const rec = (id: string, f: { sid: string; memberId: string; deviceId: string }, lease: string, usage: Record<string, number> | null, extra: Record<string, unknown> = {}) => ({ request_id: id, client_request_id: `c_${id}`, upstream_request_id: `chatcmpl-${id}`, at: new Date().toISOString(), started_at: new Date().toISOString(), sid: f.sid, uid: f.memberId, dev: f.deviceId, alias: "legal/k3", provider: "csi-maas", upstream_model: "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", usage: usage ? { reasoning: 0, cached: 0, ...usage } : null, usage_source: usage ? "upstream" : "none", latency_ms: 900, attempts: [{ provider: "csi-maas", status: 200, error: null, ms: 900 }], lease_id: lease, ...extra });

test("读回迁移（第 62 批之前的状态）：价目改按型号、tokens 套餐 × 4.2 改金额、价目生效前的行折成迁移前已用、在途租约收回；再启动不重迁；可还原", async () => {
  const store = memStore();
  const usageDir = join(mkdtempSync(join(tmpdir(), "kwl-b62-mig-")), "usage");
  // ── 第 62 批之前：tokens 套餐、按别名价目（先无价，后 v2）──
  const e1 = await boot({ store, usageDir });
  const f = await opsFirm(e1, "ten_b62mig", "boss@b62mig.cn");
  assert.equal((await e1.ops("sys_1", "POST", `/v1/ops/accounts/${f.aid}/limits`, { quota_limit: 10_000_000 })).status, 200);
  const l1 = await e1.service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-b62", need_estimate: { alias: "legal/k3", input: 10_000, output: 1_000 } });
  assert.equal(l1.status, 200, l1.text);
  assert.equal(l1.json.unit, "tokens");
  // 价目生效前：两行（未定价）共 (900000 + 100000) + (450000 + 50000) = 150 万 token
  await e1.service("/v1/quota/settle", { tid: f.tid, lease_id: l1.json.lease_id, holder: "gw-b62", records: [rec("kwlgw_b62_u1", f, l1.json.lease_id, { input: 900_000, cached: 800_000, output: 100_000 }), rec("kwlgw_b62_u2", f, l1.json.lease_id, { input: 450_000, cached: 400_000, output: 50_000 })] });
  assert.equal((await e1.ops("sys_1", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 13, cached_input: 1.3, output: 68 }, "legal/k2.6": { input: 6.5, cached_input: 1.1, output: 27 } } })).status, 200);
  const v2 = (await e1.ops("sys_1", "GET", "/v1/ops/routing")).json.prices.version as number;
  // 价目生效后一行：(100000−80000)×13 + 80000×1.3 + 10000×68 = 260000 + 104000 + 680000 = 1,044,000 微元
  await e1.service("/v1/quota/settle", { tid: f.tid, lease_id: l1.json.lease_id, holder: "gw-b62", records: [rec("kwlgw_b62_p1", f, l1.json.lease_id, { input: 100_000, cached: 80_000, output: 10_000 }, { price_version: v2 })] });
  const l2 = await e1.service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-b62", need_estimate: { alias: "legal/k3", input: 10_000, output: 1_000 } });
  assert.equal(l2.status, 200);
  const t1 = (await e1.ops("sys_1", "GET", `/v1/ops/tenants/${f.tid}`)).json.tenant;
  assert.deepEqual([t1.unit, t1.used, t1.total], ["tokens", 1_610_000, 150_000_000]);
  await e1.close();
  // 模拟第 62 批之前写下的状态：没有迁移标记
  const st = JSON.parse(store.data!);
  delete st.catalog.migrations;
  store.data = JSON.stringify(st);

  // ── 升级后首次启动：迁移 ──
  const e2 = await boot({ store, usageDir });
  const mig = (await e2.ops("fin_1", "GET", "/v1/ops/billing/migrations")).json.b62_billing;
  assert.equal(mig.status, "applied");
  assert.deepEqual([mig.coefficient_cny_per_mtok, mig.price_version_from, mig.price_version_to], [4.2, v2, v2 + 1]);
  assert.deepEqual(mig.plans.find((p: any) => p.id === "standard"), { id: "standard", quota_unit: "tokens", seat_quota: 50_000_000, note: "每席位每月 5,000 万 token，约 25 单常规任务" }, "原值留存");
  const plans = (await e2.ops("sys_1", "GET", "/v1/ops/plans")).json.plans;
  assert.deepEqual(plans.map((p: any) => [p.id, p.quota_unit, p.seat_quota]), [["standard", "cny", 210], ["pro", "cny", 525], ["max", "cny", 1260], ["trial", "cny", 84]]);
  assert.match(plans[0].note, /原每席位 5000 万 token，按 4.2 元\/百万 token 折算/);
  // 价目：按型号的新版本，与官方价一致、无覆盖
  const pv = (await e2.ops("sys_1", "GET", "/v1/ops/pricing")).json;
  assert.deepEqual([pv.version, pv.basis, pv.markup, pv.by], [v2 + 1, "model", 1, "migration:b62"]);
  const k31 = pv.models.find((x: any) => x.model === "kimi-k3.1-pro");
  assert.deepEqual([k31.sale_override, k31.effective.sale.output, k31.cost_source, k31.used_by], [null, 68, "Kimi 官方定价 https://platform.kimi.com/docs/pricing/chat（2026-11-24 抓取）", [{ alias: "legal/k3", primary: true }]]);
  assert.deepEqual(pv.history.slice(0, 2).map((h: any) => h.basis), ["model", "alias"]);
  // 律所：本期已用 = 价目生效前 150 万 token × 4.2 微元 + 已定价行的售价 1,044,000 微元；总额 3 席 × 210 元
  const t2 = (await e2.ops("sys_1", "GET", `/v1/ops/tenants/${f.tid}`)).json.tenant;
  const legacyMicro = 1_500_000 * B62_CNY_PER_MTOK;
  assert.deepEqual([t2.unit, t2.total], ["cny", 630]);
  assert.equal(t2.used, (legacyMicro + 1_044_000) / 1e6);
  assert.equal(t2.in_flight_ratio, 0, "tokens 单位的在途租约已收回");
  const ten = e2.cp.ops.tenant(f.tid)!;
  assert.deepEqual([ten.quota.legacy?.source, ten.quota.legacy?.used_units, ten.quota.legacy?.members?.[f.memberId]], ["b62", legacyMicro, legacyMicro]);
  assert.equal(Object.values(ten.quota.leases).filter((l) => !l.closed_at).length, 0);
  // 个人上限 1,000 万 token → 42 元
  const acc = (await e2.ops("sys_1", "GET", `/v1/ops/accounts/${f.aid}`)).json.account;
  assert.equal(acc.quota_limit, 42);
  // 旧版网关回报旧租约（tokens）：照常入账（按新单位）、应答 revoked
  const late = await e2.service("/v1/quota/settle", { tid: f.tid, lease_id: l2.json.lease_id, holder: "gw-b62", records: [rec("kwlgw_b62_p2", f, l2.json.lease_id, { input: 1_000, output: 100 }, { price_version: v2 + 1 })] });
  assert.deepEqual([late.status, late.json.accepted, late.json.revoked], [200, 1, true]);
  // 新租约按金额
  const l3 = await e2.service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-b62", need_estimate: { alias: "legal/k3", input: 10_000, output: 1_000 } });
  assert.deepEqual([l3.status, l3.json.unit], [200, "cny"]);
  assert.ok(l3.json.units >= 10_000 * 13 + 1_000 * 68);
  // 旧的按别名价目接口：已按型号管理即拒绝（防止悄悄改回按别名）
  const legacyPut = await e2.ops("sys_1", "PUT", "/v1/ops/routing/prices", { items: {} });
  assert.deepEqual([legacyPut.status, legacyPut.json.error.code], [409, "pricing_basis_model"]);
  await e2.close();

  // ── 再启动：不重迁 ──
  const e3 = await boot({ store, usageDir });
  assert.equal((await e3.ops("sys_1", "GET", "/v1/ops/pricing")).json.version, v2 + 1, "幂等：价目版本不再增加");
  assert.equal((await e3.ops("sys_1", "GET", `/v1/ops/tenants/${f.tid}`)).json.tenant.total, 630);
  // ── 还原：危险操作；只财务不行 ──
  assert.equal((await e3.ops("fin_1", "POST", "/v1/ops/billing/migrations/b62/revert", {})).status, 403);
  const rv = await e3.ops("sys_1", "POST", "/v1/ops/billing/migrations/b62/revert", {});
  assert.equal(rv.status, 200, rv.text);
  assert.deepEqual([rv.json.migration.status, rv.json.skipped], ["reverted", []]);
  const t3 = (await e3.ops("sys_1", "GET", `/v1/ops/tenants/${f.tid}`)).json.tenant;
  assert.deepEqual([t3.unit, t3.total], ["tokens", 150_000_000]);
  assert.equal((await e3.ops("sys_1", "GET", `/v1/ops/accounts/${f.aid}`)).json.account.quota_limit, 10_000_000);
  assert.equal(e3.cp.ops.tenant(f.tid)!.quota.legacy, null, "迁移前已用回到迁移前的样子");
  assert.equal((await e3.ops("sys_1", "POST", "/v1/ops/billing/migrations/b62/revert", {})).json.error.code, "migration_not_applied");
  await e3.close();
  const e4 = await boot({ store, usageDir });
  assert.equal((await e4.ops("sys_1", "GET", "/v1/ops/plans")).json.plans[0].quota_unit, "tokens", "还原后读回不再自动迁移");
  await e4.close();
});

test("入账口径：估算不当作实测（不扣、不计售价与成本、另记待对账）；partial 拿到真实 usage 只记成本；上游错误不计；重发去重；1 小时写入按 1 小时价；价目变更下一请求起、历史行不改写", async () => {
  const env = await boot({ store: memStore(), usageDir: join(mkdtempSync(join(tmpdir(), "kwl-b62-row-")), "usage"), billing: {} });
  // 生产入口的新部署：金额套餐 + 按型号官方价，开箱可用
  const f = await opsFirm(env, "ten_b62row", "boss@b62row.cn", "standard");
  const lease = await env.service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-r", need_estimate: { alias: "legal/k3", input: 20_000, output: 2_000 } });
  assert.deepEqual([lease.status, lease.json.unit], [200, "cny"], lease.text);
  const v1 = lease.json.price_version as number;
  const L = lease.json.lease_id as string;
  const s = await env.service("/v1/quota/settle", {
    tid: f.tid,
    lease_id: L,
    holder: "gw-r",
    records: [
      // 真实 MaaS 首次（写入 8960，5 分钟）：126,982 微元
      rec("r_write5", f, L, { input: 9114, output: 125, reasoning: 86, cache_write: 8960 }, { price_version: v1 }),
      // 命中：20,042
      rec("r_hit", f, L, { input: 9114, cached: 8960, output: 94, reasoning: 67 }, { price_version: v1 }),
      // ttl=1h 写入：195,309
      rec("r_write1h", f, L, { input: 7317, output: 103, cache_write: 7168, cache_write_1h: 7168 }, { price_version: v1 }),
      // 上游没给 usage、网关估算：不计
      rec("r_est", f, L, { input: 5_000, output: 300 }, { price_version: v1, usage_source: "estimated", outcome: "client_gone" }),
      // 流中途出错但拿到了真实 usage：售价 0、成本按真实
      rec("r_part", f, L, { input: 2_000, output: 500 }, { price_version: v1, outcome: "upstream_error", partial: true, usage_source: "upstream" }),
      // 上游 429 / 503 / 400：没有 usage，不计
      rec("r_429", f, L, null, { status: 429, outcome: "upstream_error", attempts: [{ provider: "csi-maas", status: 429, error: "upstream_429", ms: 5 }] }),
      rec("r_503", f, L, null, { status: 503, outcome: "upstream_error" }),
      rec("r_400", f, L, null, { status: 400, outcome: "upstream_error" }),
      rec("r_hit", f, L, { input: 9114, cached: 8960, output: 94 }, { price_version: v1 }), // 重发：去重
    ],
  });
  assert.deepEqual([s.status, s.json.accepted, s.json.duplicates], [200, 8, 1], s.text);
  const rows = new Map(env.cp.usageBook.query({ tid: f.tid, limit: 50 }).rows.map((r) => [r.request_id, r]));
  const w5 = rows.get("r_write5")!;
  assert.deepEqual([w5.charge, w5.value_micro, w5.cost_micro, w5.price_basis, w5.price_key, w5.markup, w5.price_version], [126_982, 126_982, 126_982, "model", "kimi-k3.1-pro", 1, v1]);
  assert.deepEqual(w5.billed, { uncached: 154, cached: 0, cache_write_5m: 8960, cache_write_1h: 0, output: 125, reasoning: 86 });
  assert.deepEqual(w5.usage, { input: 9114, cached: 0, output: 125, reasoning: 86, cache_write: 8960 });
  assert.equal(rows.get("r_hit")!.charge, 20_042);
  assert.equal(rows.get("r_write1h")!.charge, 195_309);
  const est = rows.get("r_est")!;
  assert.deepEqual([est.usage, est.charge, est.value_micro, est.cost_micro, est.reconcile, est.est_usage?.input], [null, 0, 0, null, "pending", 5_000]);
  assert.equal(est.est_value_micro, 5_000 * 13 + 300 * 68);
  const part = rows.get("r_part")!;
  assert.deepEqual([part.partial, part.charge, part.value_micro, part.cost_micro, part.reconcile], [true, 0, 0, 2_000 * 13 + 500 * 68, undefined]);
  for (const id of ["r_429", "r_503", "r_400"]) assert.deepEqual([rows.get(id)!.charge, rows.get(id)!.value_micro, rows.get(id)!.cost_micro], [0, null, null], id);
  const usedMicro = 126_982 + 20_042 + 195_309;
  const t = (await env.ops("sys_1", "GET", `/v1/ops/tenants/${f.tid}`)).json.tenant;
  assert.deepEqual([t.unit, t.used, t.total], ["cny", y4(usedMicro), 630]);
  // 涨价（全局 1.5 倍）：下一请求起生效；已入账的行不改写；晚到的旧请求按它发起时的版本
  const put = await env.ops("sys_1", "PUT", "/v1/ops/pricing", { markup: 1.5, models: { "kimi-k3.1-pro": {}, "kimi-k3.1-pro-highspeed": {}, "kimi-k2.6": {} } });
  assert.equal(put.status, 200, put.text);
  const v2 = put.json.version as number;
  const l2 = await env.service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-r", need_estimate: { alias: "legal/k3", input: 1_000, output: 100 } });
  await env.service("/v1/quota/settle", { tid: f.tid, lease_id: l2.json.lease_id, holder: "gw-r", records: [rec("r_new", f, l2.json.lease_id, { input: 9114, cached: 8960, output: 94 }, { price_version: v2 }), rec("r_late", f, l2.json.lease_id, { input: 9114, cached: 8960, output: 94 }, { price_version: v1 }), rec("r_hs", f, l2.json.lease_id, { input: 9114, cached: 8960, output: 94 }, { price_version: v2, upstream_model: "kimi-k3.1-pro-highspeed" })] });
  const rows2 = new Map(env.cp.usageBook.query({ tid: f.tid, limit: 50 }).rows.map((r) => [r.request_id, r]));
  assert.equal(rows2.get("r_new")!.charge, Math.round(154 * 19.5 + 8960 * 1.95 + 94 * 102));
  assert.equal(rows2.get("r_late")!.charge, 20_042, "晚到的旧请求按它发起时的版本");
  assert.equal(rows2.get("r_hit")!.charge, 20_042, "历史行不改写");
  // 切到 highspeed 的那一次：按 highspeed 的售价与成本（26 / 1.3 / 136 × 1.5）
  assert.deepEqual([rows2.get("r_hs")!.price_key, rows2.get("r_hs")!.charge, rows2.get("r_hs")!.cost_micro], ["kimi-k3.1-pro-highspeed", Math.round(154 * 39 + 8960 * 1.95 + 94 * 204), Math.round(154 * 26 + 8960 * 1.3 + 94 * 136)]);
  // 撤掉 k3.1-pro 的价：在用的金额套餐会失价 → 409，版本不变
  const drop = await env.ops("sys_1", "PUT", "/v1/ops/pricing", { models: { "kimi-k2.6": {} } });
  assert.deepEqual([drop.status, drop.json.error.code], [409, "prices_required_by_plan"]);
  assert.equal((await env.ops("sys_1", "GET", "/v1/ops/pricing")).json.version, v2);
  // 汇总：按上游型号分组；待对账一行；估算金额另列、不计入
  const sum = (await env.ops("fin_1", "GET", `/v1/ops/usage/summary?${new URLSearchParams({ tid: f.tid, group: "upstream" })}`)).json;
  const hs = sum.rows.find((x: any) => x.key === "kimi-k3.1-pro-highspeed");
  assert.equal(hs.requests, 1);
  assert.deepEqual([sum.totals.pending_reconcile, sum.totals.est_value_cny, sum.totals.tokens_cache_write], [1, y4(5_000 * 13 + 300 * 68), 8960 + 7168]);
  // 本人明细：估算的行写“待核对”，比例由控制面给
  await env.close();
});

test("汇总：价目生效前的行如实标出（不改写），另给“按现行价估算”（只读）；明细与 CSV 同口径", async () => {
  const env = await boot({ store: memStore(), usageDir: join(mkdtempSync(join(tmpdir(), "kwl-b62-sum-")), "usage") });
  const f = await opsFirm(env, "ten_b62sum", "boss@b62sum.cn");
  const l = await env.service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-s", need_estimate: { alias: "legal/k3", input: 1_000, output: 100 } });
  // 无价时两行
  await env.service("/v1/quota/settle", { tid: f.tid, lease_id: l.json.lease_id, holder: "gw-s", records: [rec("s_u1", f, l.json.lease_id, { input: 9626, cached: 512, output: 6881, reasoning: 6139 }), rec("s_u2", f, l.json.lease_id, { input: 1_000, output: 100 }, { alias: "legal/k2.6", upstream_model: "kimi-k2.6" })] });
  assert.equal((await env.ops("sys_1", "PUT", "/v1/ops/pricing", { models: { "kimi-k3.1-pro": {}, "kimi-k2.6": {} } })).status, 200);
  const sum = (await env.ops("fin_1", "GET", `/v1/ops/usage/summary?${new URLSearchParams({ tid: f.tid, group: "model" })}`)).json;
  const k3 = sum.rows.find((x: any) => x.key === "legal/k3");
  // 按现行价（官方价 × 1.0）：(9626−512)×13 + 512×1.3 + 6881×68 = 587,056 微元
  assert.deepEqual([k3.unpriced, k3.unpriced_note, k3.value_cny, k3.unpriced_est_value_cny], [1, "价目生效前", 0, y4(587_056)]);
  const k26 = sum.rows.find((x: any) => x.key === "legal/k2.6");
  assert.equal(k26.unpriced_est_value_cny, y4(1_000 * 6.5 + 100 * 27));
  assert.equal(sum.totals.unpriced_est_value_cny, y4(587_056 + 9_200));
  assert.match(sum.notes.unpriced, /只读/);
  const recs = (await env.ops("fin_1", "GET", `/v1/ops/usage/records?tid=${f.tid}`)).json.records;
  const r1 = recs.find((x: any) => x.request_id === "s_u1");
  assert.deepEqual([r1.value_cny, r1.billing_note, r1.unpriced_est_value_cny, r1.value_micro], [null, "价目生效前（未定价）", y4(587_056), null]);
  const month = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
  const bill = (await env.ops("fin_1", "GET", `/v1/ops/billing?period=${month}`)).json.rows.find((x: any) => x.tid === f.tid);
  assert.deepEqual([bill.unpriced_rows, bill.unpriced_note, bill.unpriced_est_value_cny], [2, "价目生效前", y4(587_056 + 9_200)]);
  const csv = await fetch(`${env.base}/v1/ops/usage/records.csv?tid=${f.tid}`, { headers: { authorization: `Bearer ${await env.ops.tokenOf("fin_1")}` } });
  const text = await csv.text();
  assert.match(text, /计价依据/);
  assert.match(text, /价目生效前（未定价）/);
  await env.close();
});

test("并发回报与重放：4 路同时报、编号互相重叠，每个请求编号只入账一次；估算行出告警（每上游每小时一条）；账期按北京时间", async () => {
  const env = await boot({ store: memStore(), usageDir: join(mkdtempSync(join(tmpdir(), "kwl-b62-cc-")), "usage"), billing: {} });
  const f = await opsFirm(env, "ten_b62cc", "boss@b62cc.cn", "standard");
  const l = await env.service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-c", need_estimate: { alias: "legal/k3", input: 1_000, output: 100 } });
  const L = l.json.lease_id as string;
  const v = l.json.price_version as number;
  const ids = Array.from({ length: 12 }, (_, i) => `cc_${i}`);
  // 4 路：每路报 8 条，与其他路重叠（网关重发、两实例重放同一份预写日志）
  const batches = [0, 1, 2, 3].map((k) => ids.slice(k * 2, k * 2 + 8).map((id) => rec(id, f, L, { input: 1_000, cached: 500, output: 100 }, { price_version: v })));
  const rs = await Promise.all(batches.map((records) => env.service("/v1/quota/settle", { tid: f.tid, lease_id: L, holder: "gw-c", records })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.reduce((n, r) => n + r.json.accepted, 0), 12, "12 个不同编号各入账一次");
  assert.equal(rs.reduce((n, r) => n + r.json.duplicates, 0), batches.flat().length - 12);
  const one = Math.round(500 * 13 + 500 * 1.3 + 100 * 68);
  const t = (await env.ops("sys_1", "GET", `/v1/ops/tenants/${f.tid}`)).json.tenant;
  assert.equal(t.used, y4(12 * one));
  // 估算行：告警一条（同一上游一小时内不重复）
  await env.service("/v1/quota/settle", { tid: f.tid, lease_id: L, holder: "gw-c", records: [rec("cc_est1", f, L, { input: 10, output: 1 }, { usage_source: "estimated" }), rec("cc_est2", f, L, { input: 10, output: 1 }, { usage_source: "estimated" })] });
  const al = (await env.ops("sys_1", "GET", "/v1/ops/alerts")).json.alerts.filter((x: any) => x.kind === "usage_missing");
  assert.equal(al.length, 1);
  assert.match(al[0].message, /待对账（不计入额度）/);
  // 北京时间 11 月 1 日 0:30（UTC 10-31 16:30）的请求记在 11 月 1 日（账期与额度周期同为北京时间）
  await env.service("/v1/quota/settle", { tid: f.tid, lease_id: L, holder: "gw-c", records: [rec("cc_bj", f, L, { input: 10, output: 1 }, { at: "2026-10-31T16:30:00.000Z" })] });
  const row = env.cp.usageBook.query({ tid: f.tid, request_id: "cc_bj", from: "2026-10-01", to: "2026-12-31" }).rows[0];
  assert.equal(row?.day ?? "", "2026-11-01");
  await env.close();
});
