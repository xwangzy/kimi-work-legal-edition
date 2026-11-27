/**
 * 第 71 批（V45）：控制台“以客户为主轴”重构所需的运营接口增量（research/2026-11-26-V45…/03-控制台信息架构分析.md §5.8）。
 * - I-1 客户行 personal（只读判断，不把 t.personal 写回）；
 * - I-2 账号行 devices_signed_in / device_limit_custom / device_limit_source / locked_s；账号详情 uid、seat；
 * - I-3 账号详情 tenant 摘要（只给有 tenant.read 的）与 join_requests_pending；
 * - I-4 / B-8 客户列表与详情按权限裁剪（金额要 billing.read，成员与电脑清单要 account.read），hidden 写明；详情 join_requests；
 * - I-5 / B-1 GET /v1/ops/tenants/{tid}/audit（原先控制台读 /v1/ops/system 的 access_log，控制面早已不给）；
 * - I-6 / B-4 收回席位认席位编号；B-5 按 fp:<指纹> 移除电脑不再 400。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";
import { devStaffOf, staffClient } from "./staff-fixture.ts";

let cp: ControlPlane;
let base = "";
const ops = staffClient(() => base);
before(async () => {
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "b71-console-ia-secret-0000000000", devStaff: devStaffOf({ op_0201: ["operator"], op_0202: ["finance"], op_0203: ["support"], op_0204: ["issuer"] }), opsAccessLog: () => {} });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const ok = <T extends { status: number; text: string }>(r: T, what: string) => (assert.equal(r.status, 200, `${what}：${r.text}`), r);
let firmAdmin = "";
let soloAdmin = "";

test("开通两家客户：律所（多人）与个人；客户行带 personal（I-1），个人客户的判断不改写状态", async () => {
  ok(await ops("op_0201", "POST", "/v1/ops/tenants", { tid: "ten_b71firm", name: "第七一律师事务所", seats: 5, subscription_days: 365, edition: "team" }), "开通律所");
  ok(await ops("op_0201", "POST", "/v1/ops/tenants", { tid: "ten_b71solo", name: "王某某", seats: 1, subscription_days: 30, edition: "team" }), "开通个人");
  firmAdmin = ok(await ops("op_0201", "POST", "/v1/ops/accounts", { tid: "ten_b71firm", email: "admin@b71firm.example", name: "所主任", role: "admin" }), "律所管理员").json.account.aid;
  soloAdmin = ok(await ops("op_0201", "POST", "/v1/ops/accounts", { tid: "ten_b71solo", email: "solo@b71.example", name: "王律师", role: "admin" }), "个人账号").json.account.aid;
  // 第 72 批（D-305）：类型是显式字段 kind（personal 只是兼容字段）；用例直接把这家定为个人
  Object.assign(cp.ops.tenant("ten_b71solo")!, { personal: true, kind: "personal" });
  const list = ok(await ops("op_0201", "GET", "/v1/ops/tenants"), "客户列表").json;
  const row = (tid: string) => list.tenants.find((t: { tid: string }) => t.tid === tid);
  assert.equal(row("ten_b71firm").personal, false);
  assert.equal(row("ten_b71solo").personal, true);
  assert.deepEqual(list.hidden, [], "客户运营有 billing.read");
  assert.ok("value_cny" in row("ten_b71firm"));
  assert.equal(cp.ops.tenant("ten_b71solo")!.personal, true, "读客户行不把 personal 写回");
});

test("B-8：客户列表与详情按权限裁剪——没有 billing.read 不给金额与账单；没有 account.read 不给成员姓名、邮箱与电脑清单", async () => {
  // 客服：有 account.read，没有 billing.read
  const sl = ok(await ops("op_0203", "GET", "/v1/ops/tenants"), "客服看列表").json;
  assert.deepEqual(sl.hidden, ["billing"]);
  for (const t of sl.tenants) assert.ok(!("value_cny" in t) && !("cost_cny" in t), "客服不该拿到金额");
  const sd = ok(await ops("op_0203", "GET", "/v1/ops/tenants/ten_b71firm"), "客服看详情").json;
  assert.deepEqual(sd.hidden, ["billing"]);
  assert.equal(sd.bill, null);
  assert.ok(!("value_cny" in sd.tenant));
  assert.equal(sd.members.find((m: { aid: string | null }) => m.aid === firmAdmin)?.email, "admin@b71firm.example", "客服照常看到成员");
  assert.deepEqual(sd.join_requests, []);
  // 财务：有 billing.read，没有 account.read
  const fd = ok(await ops("op_0202", "GET", "/v1/ops/tenants/ten_b71firm"), "财务看详情").json;
  assert.deepEqual(fd.hidden, ["accounts"]);
  assert.ok(fd.bill && "revenue_cny" in fd.bill);
  assert.ok(fd.members.length >= 1, "人数照给");
  for (const m of fd.members) assert.deepEqual([m.aid, m.email, m.name], [null, null, null]);
  assert.deepEqual(fd.devices, []);
  assert.equal((await ops("op_0202", "GET", `/v1/ops/accounts/${firmAdmin}`)).status, 403, "财务进不了账号详情");
  // 开通专员：两样都不全
  const id = ok(await ops("op_0204", "GET", "/v1/ops/tenants/ten_b71solo"), "开通专员看详情").json;
  assert.deepEqual(id.hidden, ["billing", "usage"], "开通专员没有 billing.read 与 usage.read（第三轮 S-04 起用量也按 usage.read 裁剪）");
});

test("I-2 / I-3：账号行与账号详情——登录中的电脑数、电脑上限的单设值与来源、席位、所属客户摘要（按 tenant.read）、待批准入组", async () => {
  const d = ok(await ops("op_0203", "GET", `/v1/ops/accounts/${soloAdmin}`), "账号详情").json;
  assert.equal(d.account.devices_signed_in, 0);
  assert.equal(d.account.device_limit_custom, null);
  assert.ok(["plan", "default"].includes(d.account.device_limit_source));
  assert.equal(typeof d.account.device_limit, "number");
  assert.equal(typeof d.account.locked_s, "number");
  assert.equal(d.uid, "usr_b71solo_" + d.account.member_slug);
  assert.equal(d.seat, null);
  assert.deepEqual([d.tenant.tid, d.tenant.personal, d.tenant.status], ["ten_b71solo", true, "pending"]);
  assert.deepEqual(d.join_requests_pending, []);
  // B-2：单设一次、再恢复按套餐；来源随之变化
  ok(await ops("op_0201", "POST", `/v1/ops/accounts/${soloAdmin}/limits`, { device_limit: 3 }), "单设电脑数");
  let a = ok(await ops("op_0201", "GET", `/v1/ops/accounts?tid=ten_b71solo`), "账号列表").json.accounts[0];
  assert.deepEqual([a.device_limit_custom, a.device_limit_source], [3, "account"]);
  ok(await ops("op_0201", "POST", `/v1/ops/accounts/${soloAdmin}/limits`, { device_limit: null }), "恢复按套餐");
  a = ok(await ops("op_0201", "GET", `/v1/ops/accounts?tid=ten_b71solo`), "账号列表").json.accounts[0];
  assert.equal(a.device_limit_custom, null);
  assert.notEqual(a.device_limit_source, "account");
});

test("I-5 / B-1：客户的操作记录（审计链）——运营的代建账号、改个人上限都在；after 游标翻页；没有这家客户 404", async () => {
  const r = ok(await ops("op_0203", "GET", "/v1/ops/tenants/ten_b71solo/audit"), "操作记录").json;
  const actions = r.records.map((x: { action: string }) => x.action);
  assert.ok(actions.includes("account.create"), actions.join(","));
  assert.ok(actions.filter((x: string) => x === "account.limits").length >= 2, actions.join(","));
  assert.equal(r.head.seq, r.records.at(-1).seq);
  const page = ok(await ops("op_0203", "GET", "/v1/ops/tenants/ten_b71solo/audit?after=1&limit=1"), "翻页").json;
  assert.deepEqual(page.records.map((x: { seq: number }) => x.seq), [2]);
  assert.equal((await ops("op_0203", "GET", "/v1/ops/tenants/ten_nobody/audit")).status, 404);
});

test("B-4 / B-5：收回席位认席位编号（不认识的 404 seat_unknown，不再 400）；按 fp:<指纹> 移除电脑找不到时 404 device_unknown（原先 400 编号不合法）", async () => {
  const s = await ops("op_0201", "POST", "/v1/ops/tenants/ten_b71firm/seats/seat_nope0000/revoke");
  assert.deepEqual([s.status, s.json?.error?.code], [404, "seat_unknown"]);
  const f = await ops("op_0201", "POST", `/v1/ops/tenants/ten_b71firm/devices/${encodeURIComponent("fp:abcdef0123456789")}/revoke`);
  assert.deepEqual([f.status, f.json?.error?.code], [404, "device_unknown"], f.text);
});

test("第二轮：账号列表给各状态计数并支持“已锁定”筛选；电脑列表单列待批准的新电脑；操作记录给可读名称并可往前翻", async () => {
  const l = ok(await ops("op_0203", "GET", "/v1/ops/accounts?tid=ten_b71firm"), "账号列表").json;
  assert.deepEqual(Object.keys(l.counts).sort(), ["active", "all", "disabled", "locked", "unseated"]);
  // 第四轮（05）：账号行带“是否占席”与“待批准的新电脑台数”；“未占席”可筛
  for (const x of l.accounts) assert.ok(typeof x.seat_used === "boolean" && typeof x.devices_pending === "number", JSON.stringify(x));
  const un = ok(await ops("op_0203", "GET", "/v1/ops/accounts?tid=ten_b71firm&status=unseated"), "未占席").json;
  assert.equal(un.accounts.length, l.counts.unseated);
  assert.equal(l.counts.all, l.total);
  assert.equal(ok(await ops("op_0203", "GET", "/v1/ops/accounts?status=locked"), "已锁定").json.accounts.length, 0);
  const dv = ok(await ops("op_0203", "GET", "/v1/ops/devices"), "电脑列表").json;
  assert.ok(Array.isArray(dv.pending), "待批准单列");
  const a = ok(await ops("op_0203", "GET", "/v1/ops/tenants/ten_b71solo/audit"), "操作记录").json;
  const create = a.records.find((x: { action: string }) => x.action === "account.create");
  assert.match(a.labels[create.actor.id] ?? "", /^平台人员 · /, JSON.stringify(a.labels));
  assert.match(a.labels[create.target] ?? "", /王律师/);
  const older = ok(await ops("op_0203", "GET", `/v1/ops/tenants/ten_b71solo/audit?before=${a.records.at(-1).seq}&limit=1`), "往前翻").json;
  assert.deepEqual(older.records.map((x: { seq: number }) => x.seq), [a.records.at(-1).seq - 1]);
});

test("第二轮：本所管理员在网页上让本所成员的一台电脑退出登录——只认本所成员与本人名下的电脑；成员列表带席位与电脑状态", async () => {
  // 律所管理员用运营发的设置密码码设好密码，再以网页会话登录（与本所页同一套鉴权）
  const code = ok(await ops("op_0201", "POST", `/v1/ops/accounts/${firmAdmin}/reset-code`), "设置密码码").json.reset_code;
  const pw = "B71-Firm-Boss-2026x";
  const r = await fetch(`${base}/v1/auth/password-reset/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@b71firm.example", code, password: pw }) });
  assert.equal(r.status, 200, await r.text());
  const li: any = await (await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@b71firm.example", password: pw, client: { platform: "web" } }) })).json();
  const auth = { authorization: `Bearer ${li.session_token}` };
  const mem = await fetch(`${base}/v1/firm/members`, { headers: auth });
  assert.equal(mem.status, 200);
  const mj: any = await mem.json();
  assert.equal(typeof mj.seats.total, "number");
  assert.ok(mj.members.every((m: { seat_used: unknown }) => typeof m.seat_used === "boolean"));
  const so = await fetch(`${base}/v1/firm/members/${firmAdmin}/devices/dev_b71firm_nobody/signout`, { method: "POST", headers: auth });
  assert.equal(so.status, 404);
  assert.equal(((await so.json()) as any).error.code, "device_unknown");
  const other = await fetch(`${base}/v1/firm/members/${soloAdmin}/devices/dev_x/signout`, { method: "POST", headers: auth });
  assert.equal(other.status, 404, "别的律所的成员");
});

test("第三轮 S-04：没有 billing.read 时按金额计额度的套餐不露金额（客户列表与详情的 used / total / daily / by_account / history 只留比例）；客户详情的用量按 usage.read 给", async () => {
  // 按金额计额度的套餐（quota_unit = cny）：建一个并换给这家律所
  ok(await ops("op_0201", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 4, cached_input: 1, output: 16, cost_input: 2, cost_cached_input: 0.5, cost_output: 8 } } }), "给模型定价");
  ok(await ops("op_0201", "PUT", "/v1/ops/plans/b71-cny", { label: "金额版", quota_unit: "cny", seat_quota: 100, models: ["legal/k3"] }), "建金额套餐");
  ok(await ops("op_0201", "POST", "/v1/ops/tenants/ten_b71firm/plan", { plan: "b71-cny" }), "换套餐");
  const op = ok(await ops("op_0201", "GET", "/v1/ops/tenants"), "客户运营看列表").json.tenants.find((t: { tid: string }) => t.tid === "ten_b71firm");
  assert.equal(op.unit, "cny", "按金额计额度（本用例要覆盖的情形）");
  assert.ok("used" in op && "total" in op, "有 billing.read 的照给");
  const sup = ok(await ops("op_0203", "GET", "/v1/ops/tenants"), "客服看列表").json.tenants.find((t: { tid: string }) => t.tid === "ten_b71firm");
  for (const k of ["used", "total", "value_cny", "cost_cny"]) assert.ok(!(k in sup), `客服不该拿到 ${k}`);
  assert.equal(typeof sup.used_ratio, "number", "比例照给");
  const sd = ok(await ops("op_0203", "GET", "/v1/ops/tenants/ten_b71firm"), "客服看详情").json;
  assert.ok(!("used" in sd.tenant) && !("total" in sd.tenant));
  assert.ok(sd.usage && !("used" in sd.usage) && !("total" in sd.usage), "详情 usage 不给金额");
  for (const arr of [sd.usage.daily ?? [], sd.usage.by_account ?? [], sd.usage.history ?? []]) for (const x of arr) assert.ok(!("used" in x) && !("total" in x), JSON.stringify(x));
  // 开通专员：没有 usage.read，用量整块不给，hidden 写明
  const id = ok(await ops("op_0204", "GET", "/v1/ops/tenants/ten_b71firm"), "开通专员看详情").json;
  assert.equal(id.usage, null);
  assert.ok(id.hidden.includes("usage") && id.hidden.includes("billing"));
  assert.ok(!("requests" in id.tenant), "请求数只给 usage.read");
});

test("第三轮 S-05：没有 account.read 的人员看操作记录，账号与电脑只给泛称，不给姓名与邮箱", async () => {
  const full = ok(await ops("op_0203", "GET", "/v1/ops/tenants/ten_b71firm/audit"), "客服看操作记录").json;
  assert.ok(Object.values(full.labels).some((v) => /@b71firm\.example/.test(String(v))), "有 account.read 的给姓名（邮箱）");
  const fin = ok(await ops("op_0202", "GET", "/v1/ops/tenants/ten_b71firm/audit"), "财务看操作记录").json;
  for (const v of Object.values(fin.labels)) assert.ok(!/@|所主任/.test(String(v)), `财务不该拿到姓名或邮箱：${v}`);
  const acctLabels = Object.entries(fin.kinds).filter(([, k]) => k === "account").map(([id]) => fin.labels[id]);
  assert.ok(acctLabels.length > 0 && acctLabels.every((v) => v === "成员"), JSON.stringify(fin.labels));
  for (const r of fin.records) assert.ok(!String(r.target ?? "").startsWith("dev_") && !String(r.actor?.id ?? "").startsWith("dev_"), "设备编号换成 fp: 指纹");
});
