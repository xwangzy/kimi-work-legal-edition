/**
 * 支持与诊断服务 v0（第 9 批 S13 + 复核 S9B-03/05/07/08/09/10/13）：只收“只限支持服务”的短期凭据；律所策略未开启即拒绝（拒绝前按需刷新订阅）；
 * 单次上传令牌（只能用一次、并发只放行一个、10 分钟、只给申请的那台设备）；只收诊断包（格式相符、包内签名设备 = 凭据设备）；
 * 摘要须一致、≤ 2 MiB；每台设备每天至多 10 张（按存储计，重启不清零）；运营列出、下载、删除先记访问审计；到期即取不到；清扫临时文件。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createSupportApi, SUPPORT_MAX_BYTES, TICKETS_PER_DEVICE_PER_DAY, type SupportAccessRecord } from "../src/index.ts";

const { privateKey, publicKey } = devSeatKeyPair();
const keys = new Map([["k1", publicKey]]);
const OPS = "ops-secret-0123456789";
const METER = Buffer.alloc(32, 7);
const allowed = new Set(["t_ok"]);
const revoked = new Set<string>();
let refreshes = 0;
const feed = {
  revokedDevice: (_t: string, d: string) => revoked.has(d),
  revokedSeat: () => false,
  supportUploadAllowed: (t: string) => allowed.has(t),
  refresh: async () => {
    refreshes++;
    if (pendingAllow) allowed.add(pendingAllow);
  },
};
let pendingAllow: string | null = null;
const access: SupportAccessRecord[] = [];
let clock = Date.parse("2026-10-15T08:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "kwl-support-"));
const api = createSupportApi({ dir, keys, feed, opsSecret: OPS, meterKey: METER, accessLog: (r) => void access.push(r), now: () => clock });
let base = "";
before(async () => {
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(() => api.close());

/** 只限支持服务的短期凭据（控制面 /v1/support-token 签发的形态）。 */
const cred = (tid = "t_ok", dev = "dev_a", aud: string[] | null = ["support"]) =>
  issueSeatToken({ tid, uid: "u1", sid: `s-${tid}-${dev}`, dev, kid: "k1", ...(aud ? { aud } : {}) }, privateKey, 900, clock);
const pkg = (dev = "dev_a") => Buffer.from(JSON.stringify({ format: "kwl-diagnostics/1", content: { ok: true }, signer_device: dev, signature: "x" }));
const ticket = (tok = cred()) => fetch(`${base}/v1/support/tickets`, { method: "POST", headers: { authorization: `Bearer ${tok}` } });
const upload = (t: string, token: string, body: Buffer, o: { cred?: string; sha?: string } = {}) =>
  fetch(`${base}/v1/support/packages/${t}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${o.cred ?? cred()}`, "x-kwl-upload-token": token, "x-kwl-content-sha256": o.sha ?? createHash("sha256").update(body).digest("hex") },
    body,
  });
const ops = (path: string, method = "GET", who = "ops.zhang") => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${OPS}`, "x-kwl-operator": who } });

test("凭据：只收受众含 support 的短期凭据——通用席位令牌（无受众）与给别的服务的凭据一律 401；律所未开启 403", async () => {
  assert.equal((await ticket(cred("t_ok", "dev_a", null))).status, 401, "通用席位令牌不交给支持服务（复核 S9B-03）");
  assert.equal((await ticket(cred("t_ok", "dev_a", ["gateway"]))).status, 401);
  assert.equal((await ticket(cred("t_off"))).status, 403);
  assert.equal((await fetch(`${base}/v1/support/tickets`, { method: "POST" })).status, 401);
});

test("刚开启时：不允许即按需刷新一次订阅再判（复核 S9B-07），不误报“律所未开启”", async () => {
  pendingAllow = "t_new";
  const before = refreshes;
  assert.equal((await ticket(cred("t_new", "dev_n"))).status, 200);
  assert.equal(refreshes, before + 1);
});

test("上传：单次令牌只给申请的那台设备、只能用一次；摘要不符、超限、不是诊断包、冒称别的设备一律拒收；成功后 7 天到期", async () => {
  const t = (await (await ticket()).json()) as any;
  assert.match(t.ticket, /^SUP-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(t.max_bytes, SUPPORT_MAX_BYTES);
  const body = pkg();
  assert.equal((await upload(t.ticket, t.upload_token, body, { cred: cred("t_ok", "dev_b") })).status, 404, "别的设备拿不到这张工单");
  assert.equal((await upload(t.ticket, "x".repeat(43), body)).status, 401);
  assert.equal((await upload(t.ticket, t.upload_token, body, { sha: "0".repeat(64) })).status, 400);
  assert.equal((await upload(t.ticket, t.upload_token, Buffer.from("not a package"))).status, 400, "只收诊断包（复核 S9B-13）");
  assert.equal((await upload(t.ticket, t.upload_token, pkg("dev_other"))).status, 400, "包内签名设备须等于凭据设备");
  const ok = await upload(t.ticket, t.upload_token, body);
  assert.equal(ok.status, 200);
  const j = (await ok.json()) as any;
  assert.equal(Date.parse(j.expires_at) - clock, 7 * 24 * 3600_000);
  assert.equal((await upload(t.ticket, t.upload_token, body)).status, 409, "同一工单只收一次");
  const t2 = (await (await ticket()).json()) as any;
  assert.equal((await upload(t2.ticket, t2.upload_token, Buffer.alloc(SUPPORT_MAX_BYTES + 1, 0x20))).status, 413);
  const t3 = (await (await ticket()).json()) as any;
  clock += 11 * 60_000;
  assert.equal((await upload(t3.ticket, t3.upload_token, body, { cred: cred() })).status, 401, "上传令牌 10 分钟过期");
  const rec = access.find((r) => r.ticket === t.ticket && r.result === "ok")!;
  assert.equal(rec.action, "upload");
  assert.equal(rec.bytes, body.byteLength);
  assert.match(rec.dev!, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(access).includes("dev_a"), "访问审计不存设备编号原文");
});

test("并发：同一工单的两个 PUT 恰好一个成功（复核 S9B-05）", async () => {
  const t = (await (await ticket(cred("t_ok", "dev_c"))).json()) as any;
  const body = pkg("dev_c");
  const rs = await Promise.all([upload(t.ticket, t.upload_token, body, { cred: cred("t_ok", "dev_c") }), upload(t.ticket, t.upload_token, body, { cred: cred("t_ok", "dev_c") })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
});

test("运营：列出、下载、删除都记访问审计（先记后做）；凭据与操作人缺一不可；访问审计写不进去即不删除", async () => {
  assert.equal((await fetch(`${base}/v1/support/ops/packages`, { headers: { authorization: `Bearer ${OPS}` } })).status, 400, "须写明操作人");
  assert.equal((await fetch(`${base}/v1/support/ops/packages`, { headers: { authorization: "Bearer wrong", "x-kwl-operator": "x1" } })).status, 401);
  const list = (await (await ops("/v1/support/ops/packages")).json()) as any;
  assert.ok(list.packages.length >= 1);
  assert.equal("upload_token_sha256" in list.packages[0], false);
  const tk = list.packages[0].ticket;
  const dl = await ops(`/v1/support/ops/packages/${tk}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
  assert.match(await dl.text(), /kwl-diagnostics/);
  assert.equal((await ops(`/v1/support/ops/packages/${tk}`, "DELETE")).status, 200);
  assert.equal((await ops(`/v1/support/ops/packages/${tk}`)).status, 404);
  const mine = access.filter((r) => r.operator === "ops.zhang").map((r) => `${r.action}:${r.result}`);
  assert.deepEqual(mine.slice(-4), [`list:ok:${list.packages.length}`, "download:ok", "delete:ok", "download:not_found"]);

  // 访问审计不可用：删除不执行
  const d2 = mkdtempSync(join(tmpdir(), "kwl-support-"));
  const broken = createSupportApi({ dir: d2, keys, feed, opsSecret: OPS, meterKey: METER, accessLog: (r) => { if (r.action === "delete") throw new Error("disk full"); }, now: () => clock });
  await new Promise<void>((r) => broken.listen(0, "127.0.0.1", () => r()));
  const b2 = `http://127.0.0.1:${(broken.address() as AddressInfo).port}`;
  const t = (await (await fetch(`${b2}/v1/support/tickets`, { method: "POST", headers: { authorization: `Bearer ${cred("t_ok", "dev_d")}` } })).json()) as any;
  const body = pkg("dev_d");
  assert.equal((await fetch(`${b2}/v1/support/packages/${t.ticket}`, { method: "PUT", headers: { authorization: `Bearer ${cred("t_ok", "dev_d")}`, "x-kwl-upload-token": t.upload_token, "x-kwl-content-sha256": createHash("sha256").update(body).digest("hex") }, body })).status, 200);
  assert.equal((await fetch(`${b2}/v1/support/ops/packages/${t.ticket}`, { method: "DELETE", headers: { authorization: `Bearer ${OPS}`, "x-kwl-operator": "ops.li" } })).status, 500);
  assert.ok(readdirSync(d2).includes(`${t.ticket}.bin`), "审计写不进去：包仍在");
  broken.close();
});

test("每设备每天 10 张按存储计（重启同一密钥不清零）；吊销设备 401；到期即取不到；清扫删除到期工单、孤立包与旧临时文件；生产形态缺密钥拒绝启动", async () => {
  const dev = "dev_quota";
  let last = 0;
  for (let i = 0; i <= TICKETS_PER_DEVICE_PER_DAY; i++) last = (await ticket(cred("t_ok", dev))).status;
  assert.equal(last, 429);
  // 同一目录、同一密钥重建服务：今天的计数仍在（复核 S9B-08）
  const again = createSupportApi({ dir, keys, feed, opsSecret: OPS, meterKey: METER, accessLog: () => {}, now: () => clock });
  await new Promise<void>((r) => again.listen(0, "127.0.0.1", () => r()));
  const r2 = await fetch(`http://127.0.0.1:${(again.address() as AddressInfo).port}/v1/support/tickets`, { method: "POST", headers: { authorization: `Bearer ${cred("t_ok", dev)}` } });
  assert.equal(r2.status, 429);
  again.close();
  revoked.add("dev_rv");
  assert.equal((await ticket(cred("t_ok", "dev_rv"))).status, 401);

  const t = (await (await ticket(cred("t_ok", "dev_sweep"))).json()) as any;
  assert.equal((await upload(t.ticket, t.upload_token, pkg("dev_sweep"), { cred: cred("t_ok", "dev_sweep") })).status, 200);
  writeFileSync(join(dir, "SUP-ZZZZ-ZZZZ.bin.tmp-abcd"), "half");
  writeFileSync(join(dir, "SUP-YYYY-YYYY.bin"), "orphan");
  const old = (clock - 2 * 3600_000) / 1000;
  utimesSync(join(dir, "SUP-ZZZZ-ZZZZ.bin.tmp-abcd"), old, old);
  utimesSync(join(dir, "SUP-YYYY-YYYY.bin"), old, old);
  clock += 7 * 24 * 3600_000 + 1;
  assert.equal((await ops(`/v1/support/ops/packages/${t.ticket}`)).status, 404, "到期后、清扫前也取不到（复核 S9B-09）");
  assert.ok(api.sweep() >= 3);
  const left = readdirSync(dir);
  assert.equal(left.some((f) => f.startsWith(t.ticket) || f.startsWith("SUP-ZZZZ") || f.startsWith("SUP-YYYY")), false);
  assert.ok(access.some((r) => r.action === "expire" && r.ticket === t.ticket));
  assert.throws(() => createSupportApi({ dir, keys, opsSecret: OPS, production: true }), /meterKey/);
});
