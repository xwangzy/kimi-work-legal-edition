/**
 * 在线内容更新（第 8 批；v9.2 §5.1 S6 法规库签名增量包、S7 方法模板分发）：内核 → 出站闸门分发通道 → 分发服务 v0（回环）。
 *
 * 覆盖：增量链安装后法规库即时换用（新增的法规能查到）、重启后按账本选用、本机文件被改动即回到随包版本、通道清单回退不采用、
 * 撤回后回到随包、分阶段推送未轮到、清单签名不符拒绝、包文件摘要不符拒绝、方法模板包下次打开生效、随包信封定 seq、
 * 以及“不从数据目录取法规库与公钥”的更正。发布走 scripts/dist-publish.mjs（离线签名）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createDistApi, type DistMeterRecord } from "@zr-legal/dist-api";
import { sha256B64, signBytes } from "@zr-legal/keys";
import { loadConfig } from "../src/config.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "kwl-test-secret-0123456789abcdef";

const platform = fileURLToPath(new URL("../../../", import.meta.url));
const LAWDB_DIST = join(platform, "content", "lawdb", "dist");
const INCR = join(LAWDB_DIST, "incr", "lawdb-incr-arbitration.sqlite");
const SKILLS_DIST = join(platform, "content", "skills", "dist");
const store = mkdtempSync(join(tmpdir(), "kwl-dist-store-"));
const meter: DistMeterRecord[] = [];
let server: Server;
let seat: string;
let distBase: string;

function publish(args: string[]): void {
  execFileSync(process.execPath, [join(platform, "scripts", "dist-publish.mjs"), "--dir", store, ...args], { stdio: "pipe" });
}

before(async () => {
  const { privateKey, publicKey } = devSeatKeyPair();
  seat = issueSeatToken({ tid: "ten_content-firm", uid: "u", sid: "s", dev: "dev_content", kid: "k1" }, privateKey);
  server = createDistApi({ dir: store, keys: new Map([["k1", publicKey]]), meter: { append: (r) => void meter.push(r) } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  distBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function kernelAt(dir: string, extra: Record<string, string> = {}) {
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({
    dataDir: dir,
    firmSlug: "content-firm",
    userSlug: "test-lawyer",
    env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off", ZR_DIST_BASE: distBase, ZR_SEAT_TOKEN: seat, ZR_CONTENT_CHECK_MS: "off", ...extra },
  });
  return { kernel, inv: (m: string, p: Record<string, unknown> = {}) => kernel.invoke(m, p) as Promise<any> };
}

const bundledVersion = JSON.parse(readFileSync(join(LAWDB_DIST, "lawdb.manifest.json"), "utf8")).package_version as string;
const incrVersion = JSON.parse(readFileSync(join(LAWDB_DIST, "incr", "lawdb-incr-arbitration.manifest.json"), "utf8")).package_version as string;

test("法规库：增量包安装后即时换用（新增法规可查）；重启后按账本选用；分发服务只收到席位令牌与文件名", async () => {
  publish(["--kind", "lawdb", "--channel", "stable", "--seq", "3", "--incr", INCR]);
  const dir = mkdtempSync(join(tmpdir(), "kwl-content-"));
  const k = await kernelAt(dir);
  try {
    const before = await k.inv("lawdb.status");
    assert.equal(before.package_version, bundledVersion);
    const r = await k.inv("content.check", { kind: "lawdb" });
    assert.equal(r.results[0].outcome, "installed", JSON.stringify(r.results[0]));
    assert.equal(r.results[0].seq, 3);
    const st = await k.inv("lawdb.status");
    assert.equal(st.package_version, incrVersion, "即时换用：同一个内核进程里法规库已是增量后的版本");
    assert.equal(st.laws_count, before.laws_count + 1, "增量新增的一部法规可查");
    assert.equal(r.status.lawdb.source, "installed");
    // 再查一次：已是最新
    assert.equal((await k.inv("content.check", { kind: "lawdb" })).results[0].outcome, "up_to_date");
    // 计量：只有清单与包文件名，没有事项信息
    assert.ok(meter.some((m) => m.file === "latest") && meter.some((m) => m.file.startsWith("lawdb-incr-")));
    // 审计：content.installed 与 lawdb.load 入签名链（链完整）
    const acts = k.kernel.db.all<{ action: string; object_id: string }>(`SELECT action, object_id FROM audit_events WHERE object_kind = 'content' OR action = 'lawdb.load' ORDER BY audit_event_id`, []);
    assert.ok(acts.some((a) => a.action === "content.installed" && a.object_id === "lawdb:stable:3"));
    assert.equal(acts.filter((a) => a.action === "lawdb.load").length, 2, "启动加载一次 + 换用后一次");
    assert.equal((await k.inv("audit.verifyChain")).ok, true);
  } finally {
    await k.kernel.close();
  }
  const k2 = await kernelAt(dir);
  try {
    assert.equal((await k2.inv("lawdb.status")).package_version, incrVersion, "重启后按账本选用已装版本");
    assert.equal((await k2.inv("content.status")).lawdb.source, "installed");
  } finally {
    await k2.kernel.close();
  }
  // 本机已装文件被改动：启动时核验失败 → 回到随包版本并记下问题，不再选用
  const installed = join(dir, "content-firm", "content", "lawdb", "stable-3", "lawdb.manifest.json");
  const mf = JSON.parse(readFileSync(installed, "utf8"));
  writeFileSync(installed, JSON.stringify({ ...mf, content_sha256: "B".repeat(43) }));
  const k3 = await kernelAt(dir);
  try {
    assert.equal((await k3.inv("lawdb.status")).package_version, bundledVersion);
    assert.equal((await k3.inv("content.status")).lawdb.source, "bundled");
  } finally {
    await k3.kernel.close();
  }
});

test("防回退与撤回：通道清单回退到更低 seq 不采用；当前版本被撤回且没有更新的 → 回到随包；分阶段 0% 不安装", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-content-"));
  publish(["--kind", "lawdb", "--channel", "stable", "--seq", "5", "--incr", INCR]);
  const k = await kernelAt(dir);
  try {
    assert.equal((await k.inv("content.check", { kind: "lawdb" })).results[0].outcome, "installed");
    publish(["--kind", "lawdb", "--channel", "stable", "--seq", "4", "--incr", INCR]);
    const rb = (await k.inv("content.check", { kind: "lawdb" })).results[0];
    assert.equal(rb.outcome, "rollback_ignored");
    publish(["--kind", "lawdb", "--channel", "stable", "--seq", "6", "--incr", INCR, "--revoke", "5", "--staging", "0"]);
    const rv = (await k.inv("content.check", { kind: "lawdb" })).results[0];
    assert.equal(rv.outcome, "reverted", JSON.stringify(rv));
    assert.equal((await k.inv("lawdb.status")).package_version, bundledVersion, "撤回后即时换回随包版本");
    publish(["--kind", "lawdb", "--channel", "stable", "--seq", "7", "--incr", INCR, "--staging", "0"]);
    assert.equal((await k.inv("content.check", { kind: "lawdb" })).results[0].outcome, "staged_rollout");
    publish(["--kind", "lawdb", "--channel", "stable", "--seq", "8", "--incr", INCR]);
    const again = (await k.inv("content.check", { kind: "lawdb" })).results[0];
    assert.equal(again.outcome, "installed");
    assert.equal(again.seq, 8);
  } finally {
    await k.kernel.close();
  }
});

test("核验：清单签名不符、包文件被换（摘要不符）都拒绝且不换用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-content-"));
  publish(["--kind", "lawdb", "--channel", "beta", "--seq", "2", "--incr", INCR]);
  const latest = join(store, "lawdb", "beta", "latest.json");
  const env = JSON.parse(readFileSync(latest, "utf8"));
  writeFileSync(latest, JSON.stringify({ ...env, manifest: { ...env.manifest, seq: 9 } }));
  const k = await kernelAt(dir, { ZR_DIST_CHANNEL: "beta" });
  try {
    const bad = (await k.inv("content.check", { kind: "lawdb" })).results[0];
    assert.equal(bad.outcome, "rejected");
    assert.equal(bad.reason, "manifest_signature");
    writeFileSync(latest, JSON.stringify(env));
    const file = env.manifest.packages[0].file as string;
    const pkgPath = join(store, "lawdb", "beta", "files", file);
    const orig = readFileSync(pkgPath);
    writeFileSync(pkgPath, Buffer.concat([orig, Buffer.from("x")]));
    const swapped = (await k.inv("content.check", { kind: "lawdb" })).results[0];
    assert.equal(swapped.outcome, "rejected");
    assert.equal(swapped.reason, "file_digest_mismatch");
    writeFileSync(pkgPath, orig);
    assert.equal((await k.inv("lawdb.status")).package_version, bundledVersion);
    assert.equal((await k.inv("content.check", { kind: "lawdb" })).results[0].outcome, "installed");
  } finally {
    await k.kernel.close();
  }
});

/** 复制随包方法模板并改一处内容、按开发内容签名密钥重签（模拟中软发布的新版本）。 */
function newerSkills(): string {
  const d = mkdtempSync(join(tmpdir(), "kwl-skills-new-"));
  execFileSync("cp", ["-R", `${SKILLS_DIST}/.`, d]);
  const m = JSON.parse(readFileSync(join(d, "skills.manifest.json"), "utf8"));
  const agents = join(d, "trusted", "AGENTS.md");
  writeFileSync(agents, `${readFileSync(agents, "utf8")}\n<!-- 第 8 批测试：新版本 -->\n`);
  m.files = m.files.map((f: { path: string; sha256: string }) => (f.path === "AGENTS.md" ? { ...f, sha256: sha256B64(new Uint8Array(readFileSync(agents))) } : f));
  const canonical = [...m.files].sort((a: any, b: any) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f: any) => `${f.sha256}  ${f.path}`).join("\n");
  m.content_sha256 = sha256B64(new TextEncoder().encode(canonical));
  const key = JSON.parse(readFileSync(join(platform, "content", "keys", "content-signing-dev.json"), "utf8"));
  m.signature = signBytes(key.privateKeyPem, new TextEncoder().encode(m.content_sha256));
  writeFileSync(join(d, "skills.manifest.json"), JSON.stringify(m, null, 2));
  return d;
}

test("方法模板包：内容相同只算最新；新内容安装后下次打开生效；随包信封给随包内容定 seq，低于它的在线包不采用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-content-"));
  publish(["--kind", "skills", "--channel", "stable", "--seq", "3", "--skills", SKILLS_DIST]);
  const k0 = await kernelAt(dir);
  try {
    assert.equal((await k0.inv("content.check", { kind: "skills" })).results[0].outcome, "up_to_date", "与随包内容相同");
  } finally {
    await k0.kernel.close();
  }
  publish(["--kind", "skills", "--channel", "stable", "--seq", "4", "--skills", newerSkills()]);
  const k = await kernelAt(dir);
  try {
    const r = (await k.inv("content.check", { kind: "skills" })).results[0];
    assert.equal(r.outcome, "installed", JSON.stringify(r));
    assert.equal(r.restart_required, true);
    const st = await k.inv("content.status");
    assert.equal(st.skills.source, "bundled", "本次运行仍用启动时的方法模板");
    assert.equal(st.skills.pending.seq, 4);
  } finally {
    await k.kernel.close();
  }
  const k2 = await kernelAt(dir);
  try {
    const st = await k2.inv("content.status");
    assert.equal(st.skills.source, "installed");
    assert.equal(st.skills.seq, 4);
    assert.ok((await k2.inv("skills.list")).ok);
  } finally {
    await k2.kernel.close();
  }
  // 随包信封：把随包方法模板复制到临时位置并写 seq=9 的信封 → 在线 seq 4 的已装包不再选用
  const bundle = newerSkills();
  publish(["--kind", "skills", "--channel", "stable", "--seq", "9", "--skills", bundle, "--bundled-out", join(bundle, "skills.release.json")]);
  const k3 = await kernelAt(dir, { ZR_SKILLS_MANIFEST_FILE: join(bundle, "skills.manifest.json") });
  try {
    const st = await k3.inv("content.status");
    assert.equal(st.skills.source, "bundled");
    assert.equal(st.skills.seq, 9);
  } finally {
    await k3.kernel.close();
  }
});

test("未配置分发地址：不检查在线更新；通道未发布算最新；更正——法规库与内容签名公钥不从数据目录取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-content-"));
  const k = await kernelAt(dir, { ZR_DIST_BASE: "" });
  try {
    assert.equal((await k.inv("content.check", {})).results[0].outcome, "not_configured");
  } finally {
    await k.kernel.close();
  }
  // 配置了分发地址、但 beta 通道还没发布过方法模板：算“已是最新”，不是连不上
  const kb = await kernelAt(mkdtempSync(join(tmpdir(), "kwl-content-")), { ZR_DIST_CHANNEL: "beta" });
  try {
    const r = (await kb.inv("content.check", { kind: "skills" })).results[0];
    assert.equal(r.outcome, "up_to_date");
    assert.equal(r.reason, "not_published");
  } finally {
    await kb.kernel.close();
  }
  // 数据目录里放一份法规库与“公钥”：配置不选用它们（原先工作区 lawdb/ 优先，写数据目录者可同时换掉法规库与核验公钥）
  const ws = join(dir, "content-firm", "lawdb");
  mkdirSync(ws, { recursive: true });
  copyFileSync(join(LAWDB_DIST, "lawdb.sqlite"), join(ws, "lawdb.sqlite"));
  writeFileSync(join(ws, "content-signing.pub.json"), JSON.stringify({ publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n" }));
  const env = { ...process.env };
  delete env.ZR_LAWDB_FILE;
  delete env.ZR_LAWDB_SIGNER_PUB;
  const cfg = loadConfig({ dataDir: dir, firmSlug: "content-firm", env });
  assert.ok(!cfg.lawdbFile.startsWith(dir), cfg.lawdbFile);
  assert.ok(!cfg.lawdbSignerPub.includes("AAAAAAAAAAAAAAAA"));
  rmSync(dir, { recursive: true, force: true });
});
