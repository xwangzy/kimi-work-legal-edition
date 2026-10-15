/**
 * 内容分发服务 v0（第 8 批 S6/S7）：凭据、路径白名单、计量只记摘要。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createDistApi, type DistMeterRecord } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "kwl-dist-"));
mkdirSync(join(dir, "lawdb", "stable", "files"), { recursive: true });
writeFileSync(join(dir, "lawdb", "stable", "latest.json"), '{"manifest":1}');
writeFileSync(join(dir, "lawdb", "stable", "files", "pkg.sqlite"), "PKG");
writeFileSync(join(dir, "secret.txt"), "不该被读到");
symlinkSync(join(dir, "secret.txt"), join(dir, "lawdb", "stable", "files", "link.sqlite"));

const { privateKey, publicKey } = devSeatKeyPair();
const keys = new Map([["k1", publicKey]]);
const seat = issueSeatToken({ tid: "ten_a", uid: "u", sid: "s1", dev: "dev_a_u", kid: "k1" }, privateKey);
const meter: DistMeterRecord[] = [];
const revoked = new Set<string>();
const server = createDistApi({ dir, keys, meter: { append: (r) => void meter.push(r) }, feed: { revokedDevice: (_t, d) => revoked.has(d), revokedSeat: () => false } });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => new Promise<void>((r) => server.close(() => r())));

const get = (path: string, token: string | null = seat, method = "GET") => fetch(`${base}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
/** 原样发送路径（fetch 会在客户端先把 .. 归一化掉，测不到服务端）。 */
const raw = (path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path, method: "GET", headers: { authorization: `Bearer ${seat}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

test("凭据：无令牌 401、令牌无效 401、设备已吊销 401；有效令牌取到清单与包文件", async () => {
  assert.equal((await get("/dist/lawdb/stable/latest.json", null)).status, 401);
  assert.equal((await get("/dist/lawdb/stable/latest.json", "zst1.bad.sig")).status, 401);
  const ok = await get("/dist/lawdb/stable/latest.json");
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '{"manifest":1}');
  assert.match(ok.headers.get("cache-control") ?? "", /max-age=60/);
  const f = await get("/dist/lawdb/stable/files/pkg.sqlite");
  assert.equal(f.status, 200);
  assert.equal(await f.text(), "PKG");
  revoked.add("dev_a_u");
  const r = await get("/dist/lawdb/stable/latest.json");
  assert.equal(r.status, 401);
  assert.equal(((await r.json()) as { reason: string }).reason, "device_revoked");
  revoked.clear();
});

test("路径白名单：未知类别/通道、上级目录、编码路径、查询串、符号链接、非 GET 一律拒绝", async () => {
  for (const p of ["/dist/other/stable/latest.json", "/dist/lawdb/dev/latest.json", "/dist/lawdb/stable/files/../latest.json", "/dist/lawdb/stable/files/%2e%2e%2fsecret.txt", "/dist/lawdb/stable/latest.json?x=1", "/dist/lawdb/stable/files/.hidden", "/secret.txt"]) {
    assert.equal(await raw(p), 404, p);
  }
  assert.equal((await get("/dist/lawdb/stable/files/link.sqlite")).status, 404, "符号链接不跟随");
  assert.equal((await get("/dist/lawdb/stable/files/missing.sqlite")).status, 404);
  assert.equal((await get("/dist/lawdb/stable/latest.json", seat, "POST")).status, 405);
});

test("计量只记租户、设备编号摘要、类别、通道与文件名（不记设备编号原文与来源地址）", async () => {
  meter.length = 0;
  await get("/dist/lawdb/stable/files/pkg.sqlite");
  assert.equal(meter.length, 1);
  const m = meter[0]!;
  assert.deepEqual(Object.keys(m).sort(), ["at", "bytes", "channel", "dev", "file", "kind", "tid"]);
  assert.equal(m.file, "pkg.sqlite");
  assert.notEqual(m.dev, "dev_a_u");
  assert.match(m.dev, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(m).includes("127.0.0.1"));
});
