/**
 * 支持与诊断服务 v0（第 9 批 S13）：律所策略未开启即拒绝；单次上传令牌（只能用一次、10 分钟、只给申请的那台设备）；
 * 摘要须一致、≤ 2 MiB；每台设备每天至多 10 张工单；运营列出、下载、删除都记访问审计；7 天后清扫删除。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createSupportApi, SUPPORT_MAX_BYTES, TICKETS_PER_DEVICE_PER_DAY, type SupportAccessRecord } from "../src/index.ts";

const { privateKey, publicKey } = devSeatKeyPair();
const keys = new Map([["k1", publicKey]]);
const OPS = "ops-secret-0123456789";
const allowed = new Set(["t_ok"]);
const revoked = new Set<string>();
const feed = { revokedDevice: (_t: string, d: string) => revoked.has(d), revokedSeat: () => false, supportUploadAllowed: (t: string) => allowed.has(t) };
const access: SupportAccessRecord[] = [];
let clock = Date.parse("2026-10-15T08:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "kwl-support-"));
const api = createSupportApi({ dir, keys, feed, opsSecret: OPS, accessLog: (r) => void access.push(r), now: () => clock });
let base = "";
before(async () => {
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(() => api.close());

const seat = (tid = "t_ok", dev = "dev_a") => issueSeatToken({ tid, uid: "u1", sid: `s-${tid}-${dev}`, dev, kid: "k1" }, privateKey, 96 * 3600, clock);
const ticket = (tok = seat()) => fetch(`${base}/v1/support/tickets`, { method: "POST", headers: { authorization: `Bearer ${tok}` } });
const upload = (t: string, token: string, body: Buffer, o: { seat?: string; sha?: string } = {}) =>
  fetch(`${base}/v1/support/packages/${t}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${o.seat ?? seat()}`, "x-kwl-upload-token": token, "x-kwl-content-sha256": o.sha ?? createHash("sha256").update(body).digest("hex") },
    body,
  });
const ops = (path: string, method = "GET", who = "ops.zhang") => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${OPS}`, "x-kwl-operator": who } });

test("律所策略未开启：不发工单；没有席位令牌 401", async () => {
  assert.equal((await ticket(seat("t_off"))).status, 403);
  assert.equal((await fetch(`${base}/v1/support/tickets`, { method: "POST" })).status, 401);
});

test("上传：单次令牌只给申请的那台设备、只能用一次；摘要不符与超限拒收；成功后得到 7 天到期时间", async () => {
  const t = (await (await ticket()).json()) as any;
  assert.match(t.ticket, /^SUP-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(t.max_bytes, SUPPORT_MAX_BYTES);
  const body = Buffer.from(JSON.stringify({ format: "kwl-diagnostics/1", ok: true }));
  assert.equal((await upload(t.ticket, t.upload_token, body, { seat: seat("t_ok", "dev_b") })).status, 404, "别的设备拿不到这张工单");
  assert.equal((await upload(t.ticket, "x".repeat(43), body)).status, 401);
  assert.equal((await upload(t.ticket, t.upload_token, body, { sha: "0".repeat(64) })).status, 400);
  const ok = await upload(t.ticket, t.upload_token, body);
  assert.equal(ok.status, 200);
  const j = (await ok.json()) as any;
  assert.equal(Date.parse(j.expires_at) - clock, 7 * 24 * 3600_000);
  assert.equal((await upload(t.ticket, t.upload_token, body)).status, 409, "同一工单只收一次");
  const t2 = (await (await ticket()).json()) as any;
  assert.equal((await upload(t2.ticket, t2.upload_token, Buffer.alloc(SUPPORT_MAX_BYTES + 1, 0x20))).status, 413);
  // 令牌 10 分钟过期
  const t3 = (await (await ticket()).json()) as any;
  clock += 11 * 60_000;
  assert.equal((await upload(t3.ticket, t3.upload_token, body)).status, 401);
  // 访问审计只有工单号、租户、设备 HMAC、字节数与结果
  const rec = access.find((r) => r.ticket === t.ticket && r.result === "ok")!;
  assert.equal(rec.action, "upload");
  assert.equal(rec.bytes, body.byteLength);
  assert.match(rec.dev!, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(access).includes("dev_a"), "访问审计不存设备编号原文");
});

test("运营：列出、下载、删除都记访问审计（谁、哪张工单）；凭据与操作人缺一不可", async () => {
  assert.equal((await fetch(`${base}/v1/support/ops/packages`, { headers: { authorization: `Bearer ${OPS}` } })).status, 400, "须写明操作人");
  assert.equal((await fetch(`${base}/v1/support/ops/packages`, { headers: { authorization: "Bearer wrong", "x-kwl-operator": "x1" } })).status, 401);
  const list = (await (await ops("/v1/support/ops/packages")).json()) as any;
  assert.ok(list.packages.length >= 1);
  assert.equal("upload_token_sha256" in list.packages[0], false);
  const tk = list.packages[0].ticket;
  const dl = await ops(`/v1/support/ops/packages/${tk}`);
  assert.equal(dl.status, 200);
  assert.match(await dl.text(), /kwl-diagnostics/);
  assert.equal((await ops(`/v1/support/ops/packages/${tk}`, "DELETE")).status, 200);
  assert.equal((await ops(`/v1/support/ops/packages/${tk}`)).status, 404);
  const mine = access.filter((r) => r.operator === "ops.zhang").map((r) => `${r.action}:${r.result}`);
  assert.deepEqual(mine.slice(-4), [`list:ok:${list.packages.length}`, "download:ok", "delete:ok", "download:not_found"]);
});

test("每台设备每天至多 10 张工单；吊销设备 401；7 天后清扫删除（工单与包）", async () => {
  const dev = "dev_quota";
  let last = 0;
  for (let i = 0; i <= TICKETS_PER_DEVICE_PER_DAY; i++) last = (await ticket(seat("t_ok", dev))).status;
  assert.equal(last, 429);
  revoked.add("dev_rv");
  assert.equal((await ticket(seat("t_ok", "dev_rv"))).status, 401);
  const t = (await (await ticket(seat("t_ok", "dev_sweep"))).json()) as any;
  const body = Buffer.from("{}");
  assert.equal((await upload(t.ticket, t.upload_token, body, { seat: seat("t_ok", "dev_sweep") })).status, 200);
  assert.ok(readdirSync(dir).some((f) => f.startsWith(t.ticket)));
  clock += 7 * 24 * 3600_000 + 1;
  assert.ok(api.sweep() >= 1);
  assert.equal(readdirSync(dir).some((f) => f.startsWith(t.ticket)), false);
  assert.ok(access.some((r) => r.action === "expire" && r.ticket === t.ticket));
});
