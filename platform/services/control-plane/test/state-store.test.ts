/**
 * 控制面状态持久化（试点形态，state-store.ts；调研 Y1 §5.2）：重启后租户、许可、策略、吊销与订阅版本仍在；
 * 文件存储原子写、可封装；封装文件被改动、密钥不符、明文文件配了密钥一律拒绝启动（不静默从空状态开始）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createControlPlane, devControlPlaneKeys, fileStateStore, memoryStateStore } from "../src/index.ts";

test("重启后租户、许可、策略版本、订阅版本仍在；只读操作不重复写盘", () => {
  const keys = devControlPlaneKeys();
  const store = memoryStateStore();
  const a = createControlPlane({ keys, serviceSecret: "s".repeat(24), stateStore: store });
  const t = a.ops.createTenant({ activationRequired: false, tid: "ten_persist", edition: "firm", seats: 5 });
  const salt = t.salt_b64;
  const policyVersion = t.policy!.doc.version;
  a.ops.terminateLicense("ten_persist");
  a.ops.touch();
  const saves = store.saves;
  a.ops.tenant("ten_persist");
  assert.equal(store.saves, saves, "只读操作不写盘");
  // “重启”：同一存储再建一次
  const b = createControlPlane({ keys, serviceSecret: "s".repeat(24), stateStore: store });
  const t2 = b.ops.tenant("ten_persist")!;
  assert.ok(t2, "租户仍在");
  assert.equal(t2.salt_b64, salt, "租户盐不变（网关匿名摘要按它计算）");
  assert.equal(t2.policy!.doc.version, policyVersion);
  assert.ok(Date.parse(t2.license.expires_at) <= Date.now(), "终止后的许可仍是已到期");
  assert.ok(t2.devices instanceof Map && t2.anon instanceof Map, "集合类型恢复为 Map");
  assert.throws(() => b.ops.createTenant({ activationRequired: false, tid: "ten_persist", edition: "firm", seats: 5 }), /已存在/);
});

test("文件存储（复核 B4-R04）：两代交替写、可封装；最新一代写坏回退上一代；两代都坏、密钥不符、明文配了密钥一律拒绝；生产形态无密钥拒绝构造", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-cp-state-"));
  const key = randomBytes(32);
  const path = join(dir, "state.json");
  const s = fileStateStore(path, { key });
  assert.equal(s.load(), null);
  s.save('{"v":1,"probe":"租户盐不应明文","n":1}');
  s.save('{"v":1,"probe":"租户盐不应明文","n":2}');
  for (const f of [`${path}.1`, `${path}.2`]) {
    const raw = readFileSync(f, "utf8");
    assert.ok(!raw.includes("租户盐") && JSON.parse(raw).sealed === true, "封装后盘上无明文");
  }
  assert.equal(fileStateStore(path, { key }).load(), '{"v":1,"probe":"租户盐不应明文","n":2}', "取序号最大的一代");
  // 最新一代（.2）写到一半掉电：回退到上一代（.1）
  writeFileSync(`${path}.2`, readFileSync(`${path}.2`, "utf8").slice(0, 40));
  const r = fileStateStore(path, { key });
  assert.equal(r.load(), '{"v":1,"probe":"租户盐不应明文","n":1}');
  // 回退之后再写：写到坏的那一份（较旧/损坏），序号继续单调
  r.save('{"v":1,"n":3}');
  assert.equal(JSON.parse(readFileSync(`${path}.2`, "utf8")).seq, 2);
  assert.equal(fileStateStore(path, { key }).load(), '{"v":1,"n":3}');
  // 篡改两代 → 拒绝启动（不静默从空状态开始）
  for (const f of [`${path}.1`, `${path}.2`]) {
    const doc = JSON.parse(readFileSync(f, "utf8"));
    doc.data = Buffer.from("tampered").toString("base64");
    writeFileSync(f, JSON.stringify(doc));
  }
  assert.throws(() => fileStateStore(path, { key }).load(), /两代都无法校验/);
  // 密钥不符同样两代都校验不过
  const p2 = join(dir, "k.json");
  fileStateStore(p2, { key }).save("{}");
  assert.throws(() => fileStateStore(p2, { key: randomBytes(32) }).load(), /两代都无法校验/);
  const plainPath = join(dir, "plain.json");
  fileStateStore(plainPath).save("{}");
  assert.equal(fileStateStore(plainPath).load(), "{}");
  assert.throws(() => fileStateStore(plainPath, { key }).load(), /明文/);
  writeFileSync(`${plainPath}.1`, '{"format":"kwl-cp-state/1","seq":1,"sealed":false,"sha256":"00","data":"{}"}');
  assert.throws(() => fileStateStore(plainPath).load(), /两代都无法校验/, "明文形态有校验和");
  assert.throws(() => fileStateStore(path, { key: randomBytes(16) }), /32 字节/);
  assert.throws(() => fileStateStore(join(dir, "prod.json"), { requireKey: true }), /必须封装/);
});

test("写入顺序（复核 B4-R04）：写入 → fsync 文件 → 关闭；新建文件后对目录 fsync；不经改名", () => {
  const calls: string[] = [];
  const files = new Map<string, string>();
  let fdSeq = 10;
  const fds = new Map<number, string>();
  const fs = {
    readFileSync: (p: string) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    existsSync: (p: string) => files.has(p),
    mkdirSync: () => {},
    openSync: (p: string, flags: string) => {
      const fd = fdSeq++;
      fds.set(fd, p);
      calls.push(`open ${p.endsWith(".1") ? "gen1" : p.endsWith(".2") ? "gen2" : "dir"} ${flags}`);
      if (flags === "w") files.set(p, "");
      return fd;
    },
    writeSync: (fd: number, d: string) => {
      files.set(fds.get(fd)!, d);
      calls.push("write");
      return d.length;
    },
    fsyncSync: (fd: number) => void calls.push(`fsync ${fds.get(fd)!.endsWith("state.json") ? "file" : fds.get(fd)!.match(/\.\d$/) ? "file" : "dir"}`),
    closeSync: () => void calls.push("close"),
  };
  const s = fileStateStore("/x/state.json", { fs: fs as never });
  s.save("{}");
  assert.deepEqual(calls, ["open gen1 w", "write", "fsync file", "close", "open dir r", "fsync dir", "close"]);
  calls.length = 0;
  s.save("{}");
  assert.deepEqual(calls, ["open gen2 w", "write", "fsync file", "close", "open dir r", "fsync dir", "close"]);
  calls.length = 0;
  s.save("{}");
  assert.deepEqual(calls, ["open gen1 w", "write", "fsync file", "close"], "已存在的文件不再对目录 fsync");
});

test("写盘失败（复核 B4-R01）：运维操作抛错且内存回滚；恢复后看不到失败那次的改动", () => {
  const keys = devControlPlaneKeys();
  const store = memoryStateStore();
  const a = createControlPlane({ keys, serviceSecret: "s".repeat(24), stateStore: store });
  a.ops.createTenant({ activationRequired: false, tid: "ten_fail", edition: "firm", seats: 5 });
  const untilBefore = a.ops.tenant("ten_fail")!.subscription_until;
  store.failNext = 1;
  assert.throws(() => a.ops.renewLicense("ten_fail", 400), /写盘失败/);
  assert.equal(a.ops.tenant("ten_fail")!.subscription_until, untilBefore, "内存回滚：没写成就等于没发生");
  const b = createControlPlane({ keys, serviceSecret: "s".repeat(24), stateStore: store });
  assert.equal(b.ops.tenant("ten_fail")!.subscription_until, untilBefore);
});

test("写盘失败（复核 B4-R01）：HTTP 请求得到 500、进程不退出、改动不生效；只读请求不写盘；恢复后照常", async () => {
  const { generateFirmRoot, generateDeviceKeys, issueDeviceCertificate } = await import("@zr-legal/keys");
  const { enrollProofBytes, signDeviceRequest } = await import("@zr-legal/firm-trust");
  const { sign } = await import("node:crypto");
  const keys = devControlPlaneKeys();
  const store = memoryStateStore();
  const cp = createControlPlane({ keys, serviceSecret: "s".repeat(24), stateStore: store });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(cp.server.address() as import("node:net").AddressInfo).port}`;
  try {
    const tid = "ten_http_fail";
    const root = generateFirmRoot();
    cp.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 3 });
    const ts = Date.now();
    const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
    assert.equal((await fetch(`${base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts, proof }) })).status, 200);
    const device = (role: "admin" | "lawyer", member: string, id: string) => {
      const k = generateDeviceKeys();
      const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `cert_${id}`, memberId: member, deviceId: id, role, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
      const call = async (method: string, path: string, body?: unknown) => {
        const raw = body === undefined ? "" : JSON.stringify(body);
        const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: id, signPrivateKeyPem: k.signPrivateKeyPem });
        const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
        return { status: r.status, json: (await r.json()) as any };
      };
      return { call, register: () => call("POST", "/v1/devices/register", { tid, cert }) };
    };
    const admin = device("admin", "usr_a", "dev_a");
    const lawyer = device("lawyer", "usr_l", "dev_l");
    assert.equal((await admin.register()).status, 200);
    assert.equal((await lawyer.register()).status, 200);
    // 只读请求（只记了 nonce）不触发整份重写（复核 B4-R14）
    const saves = store.saves;
    assert.equal((await admin.call("GET", "/v1/directory")).status, 200);
    assert.equal(store.saves, saves, "只读请求不写盘");
    // 写盘失败：吊销席位得到 500，进程仍在，吊销未生效
    store.failNext = 1;
    const failed = await admin.call("POST", "/v1/seats/usr_l/revoke", {});
    assert.equal(failed.status, 500);
    assert.equal(failed.json.error.code, "state_persist_failed");
    assert.equal((await lawyer.call("POST", "/v1/seat-token", {})).status, 200, "没写成就等于没发生：席位仍有效");
    assert.equal(cp.ops.tenant(tid)!.seatsByUser.get("usr_l")?.revoked_at ?? null, null, "内存也已回滚");
    // 恢复后照常
    assert.equal((await admin.call("POST", "/v1/seats/usr_l/revoke", {})).status, 200);
    assert.equal((await lawyer.call("POST", "/v1/seat-token", {})).json.error.code, "seat_revoked");
    const again = createControlPlane({ keys, serviceSecret: "s".repeat(24), stateStore: store });
    assert.ok(again.ops.tenant(tid)!.seatsByUser.get("usr_l")?.revoked_at, "重启后吊销仍在");
  } finally {
    cp.server.closeAllConnections();
    await new Promise<void>((r) => cp.server.close(() => r()));
  }
});
