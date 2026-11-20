/**
 * 公网 IP 部署与地址切换（偏离 D-212、D-213）：
 * - release.json 可带中软云端私有 CA（cloud_ca_pem），只许测试/演示构建、只收 CA 证书；
 * - 签名的云端地址配置（cloud-endpoints.json）：发布方私钥签名、部署标识一致、三项齐全才生效；只能改地址、钉住与（测试构建的）私有 CA，
 *   信任锚不可改；任何一项不合格整份不生效（沿用随包地址）；
 * - make-release-config / endpoint-profile 两个脚本端到端：离线钉住、IP 地址、签发与核验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
type Rel = { env: Record<string, string>; problems: string[]; endpointProfile: { keys: Record<string, string>; deployment: string; testBuild: boolean } | null };
const { loadReleaseConfig, applyEndpointProfile } = require("../electron/release-config.cjs") as {
  loadReleaseConfig: (file: string) => Rel;
  applyEndpointProfile: (r: Rel, file: string) => { release: Rel; applied: { seq: number; deployment: string } | null; problems: string[] };
};

const root = fileURLToPath(new URL("../../..", import.meta.url));
const fx = (n: string) => readFileSync(join(root, "packages/egress-gate/test/fixtures", n), "utf8");
const DEMO_CA = fx("demo-ca.pem");
const LEAF = fx("demo-leaf-ip.pem");
const LEAF_KEY = fx("demo-leaf-ip.key.pem");
const P1 = `sha256/${Buffer.alloc(32, 1).toString("base64")}`;
const P2 = `sha256/${Buffer.alloc(32, 2).toString("base64")}`;
const P3 = `sha256/${Buffer.alloc(32, 3).toString("base64")}`;
const dir = mkdtempSync(join(tmpdir(), "kwl-ipdeploy-"));
const write = (name: string, v: unknown) => {
  const f = join(dir, name);
  writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
  return f;
};
const edPem = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const CP_KEYS = { "cp-1": edPem(), "cp-2": edPem() };
const SEAT_KEYS = { "seat-1": edPem() };
const IP = "203.0.113.10";
const BASE = {
  control_plane_base: `https://${IP}:8443`,
  control_plane_pins: [P1, P2],
  gateway_base: `https://${IP}:8444/v1`,
  gateway_pins: [P1, P2],
  search_base: `https://${IP}:8445/v1/search`,
  search_pins: [P1, P2],
  control_plane_keys: CP_KEYS,
  seat_keys: SEAT_KEYS,
};

test("IP 地址的上游照常进入内核环境（https + 两把钉住）", () => {
  const r = loadReleaseConfig(write("ip.json", BASE));
  assert.deepEqual(r.problems, []);
  assert.equal(r.env.ZR_CONTROL_PLANE_BASE, `https://${IP}:8443`);
  assert.equal(r.env.ZR_GATEWAY_BASE, `https://${IP}:8444/v1`);
  assert.equal(r.env.ZR_CLOUD_CA_PEM, undefined);
});

test("私有 CA：只许测试构建；只收 CA 证书、不收私钥与叶子证书", () => {
  const ok = loadReleaseConfig(write("ca-ok.json", { ...BASE, test_build: true, cloud_ca_pem: DEMO_CA }));
  assert.deepEqual(ok.problems, []);
  assert.match(ok.env.ZR_CLOUD_CA_PEM!, /BEGIN CERTIFICATE/);
  const prod = loadReleaseConfig(write("ca-prod.json", { ...BASE, cloud_ca_pem: DEMO_CA }));
  assert.equal(prod.env.ZR_CLOUD_CA_PEM, undefined);
  assert.match(prod.problems.join("；"), /只用于演示\/测试构建/);
  const leaf = loadReleaseConfig(write("ca-leaf.json", { ...BASE, test_build: true, cloud_ca_pem: LEAF }));
  assert.equal(leaf.env.ZR_CLOUD_CA_PEM, undefined);
  assert.equal(leaf.problems.length, 1);
  const withKey = loadReleaseConfig(write("ca-key.json", { ...BASE, test_build: true, cloud_ca_pem: `${DEMO_CA}\n${LEAF_KEY}` }));
  assert.equal(withKey.env.ZR_CLOUD_CA_PEM, undefined);
  assert.equal(withKey.problems.length, 1);
});

// ── 签名的云端地址配置 ──────────────────────────────────────────────
const signer = generateKeyPairSync("ed25519");
const SIGNER_PUB = signer.publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("ed25519");
const signDoc = (payload: unknown, key = signer.privateKey, kid = "ep-1") => {
  const body = Buffer.from(JSON.stringify(payload));
  return { v: 1, kid, payload: body.toString("base64"), sig: edSign(null, body, key).toString("base64") };
};
const NEW = {
  kind: "kwl-endpoints",
  deployment: "demo-ip",
  seq: 2,
  issued_at: "2026-11-20T00:00:00Z",
  control_plane_base: "https://cp.kwl.example.cn",
  control_plane_pins: [P2, P3],
  gateway_base: "https://gw.kwl.example.cn/v1",
  gateway_pins: [P2, P3],
  search_base: "https://search.kwl.example.cn/v1/search",
  search_pins: [P2, P3],
};
const relWith = (extra: Record<string, unknown> = {}) =>
  loadReleaseConfig(write(`rel-${Math.random()}.json`, { ...BASE, endpoint_profile: { deployment: "demo-ip", keys: { "ep-1": SIGNER_PUB } }, ...extra }));

test("地址配置：签名有效、部署一致 → 地址与钉住改写；信任锚（控制面/席位公钥）不变", () => {
  const rel = relWith();
  assert.deepEqual(rel.problems, []);
  const r = applyEndpointProfile(rel, write("ep-ok.json", signDoc({ ...NEW, control_plane_keys: { evil: edPem() } })));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.applied, { seq: 2, deployment: "demo-ip" });
  assert.equal(r.release.env.ZR_CONTROL_PLANE_BASE, "https://cp.kwl.example.cn");
  assert.equal(r.release.env.ZR_GATEWAY_PINS, `${P2},${P3}`);
  assert.equal(r.release.env.ZR_CONTROL_PLANE_KEYS, rel.env.ZR_CONTROL_PLANE_KEYS, "控制面公钥表只随安装包");
  assert.equal(r.release.env.ZR_SEAT_KEYS, rel.env.ZR_SEAT_KEYS);
  // 原对象不被改动（失败时沿用）
  assert.equal(rel.env.ZR_CONTROL_PLANE_BASE, `https://${IP}:8443`);
});

test("地址配置：没有文件 → 静默沿用；release.json 不带验签公钥 → 不读", () => {
  const rel = relWith();
  const none = applyEndpointProfile(rel, join(dir, "missing.json"));
  assert.equal(none.applied, null);
  assert.deepEqual(none.problems, []);
  const plain = loadReleaseConfig(write("plain.json", BASE));
  const r = applyEndpointProfile(plain, write("ep-plain.json", signDoc(NEW)));
  assert.equal(r.applied, null);
  assert.equal(r.release.env.ZR_CONTROL_PLANE_BASE, `https://${IP}:8443`);
});

test("地址配置失败关闭：别的私钥签、改动内容、部署不符、缺项、钉住不足、http 地址", () => {
  const rel = relWith();
  const rejects = (doc: unknown, re: RegExp) => {
    const r = applyEndpointProfile(rel, write(`ep-${Math.random()}.json`, doc));
    assert.equal(r.applied, null);
    assert.equal(r.release.env.ZR_CONTROL_PLANE_BASE, `https://${IP}:8443`, "沿用随包地址");
    assert.match(r.problems.join("；"), re);
  };
  rejects(signDoc(NEW, other.privateKey), /签名无效/);
  const tampered = signDoc(NEW);
  tampered.payload = Buffer.from(JSON.stringify({ ...NEW, gateway_base: "https://evil.example/v1" })).toString("base64");
  rejects(tampered, /签名无效/);
  rejects(signDoc(NEW, signer.privateKey, "ep-9"), /签名无效/);
  rejects(signDoc({ ...NEW, deployment: "prod" }), /不是本部署/);
  rejects(signDoc({ ...NEW, kind: "other" }), /不是本部署/);
  const { search_base: _s, search_pins: _p, ...noSearch } = NEW;
  rejects(signDoc(noSearch), /缺少 search_base/);
  rejects(signDoc({ ...NEW, gateway_pins: [P2] }), /至少两把/);
  rejects(signDoc({ ...NEW, gateway_base: "http://gw.kwl.example.cn/v1" }), /https/);
  rejects({ v: 2 }, /格式不对/);
  rejects("{not json", /无法解析/);
});

test("地址配置的私有 CA：只许测试构建；null 表示改回只认公共根", () => {
  const prod = relWith();
  const r1 = applyEndpointProfile(prod, write("ep-ca-prod.json", signDoc({ ...NEW, cloud_ca_pem: DEMO_CA })));
  assert.equal(r1.applied, null);
  assert.match(r1.problems.join("；"), /只用于演示/);
  const demo = relWith({ test_build: true, cloud_ca_pem: DEMO_CA });
  assert.match(demo.env.ZR_CLOUD_CA_PEM!, /BEGIN CERTIFICATE/);
  const r2 = applyEndpointProfile(demo, write("ep-ca-null.json", signDoc({ ...NEW, cloud_ca_pem: null })));
  assert.ok(r2.applied);
  assert.equal(r2.release.env.ZR_CLOUD_CA_PEM, undefined, "迁到公共 CA 证书的域名后不再信任演示 CA");
  const r3 = applyEndpointProfile(demo, write("ep-ca-keep.json", signDoc(NEW)));
  assert.match(r3.release.env.ZR_CLOUD_CA_PEM!, /BEGIN CERTIFICATE/, "不写 cloud_ca_pem 即沿用随包私有 CA");
});

test("endpoint_profile 本身不合格：报问题、不启用", () => {
  const r = loadReleaseConfig(write("ep-bad.json", { ...BASE, endpoint_profile: { deployment: "Demo IP", keys: { "ep-1": SIGNER_PUB } } }));
  assert.equal(r.endpointProfile, null);
  assert.equal(r.problems.length, 1);
  const priv = signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const r2 = loadReleaseConfig(write("ep-priv.json", { ...BASE, endpoint_profile: { deployment: "demo-ip", keys: { "ep-1": priv } } }));
  assert.equal(r2.endpointProfile, null, "误填私钥不随安装包分发");
});

// ── 脚本端到端 ────────────────────────────────────────────────────────
const node = (script: string, args: string[]) => spawnSync(process.execPath, [join(root, "scripts", script), ...args], { encoding: "utf8" });

test("make-release-config（离线）：IP 地址 + 私有 CA + 验签公钥；正式构建带私有 CA 即拒写", () => {
  const cpKeys = write("cp-keys.json", CP_KEYS);
  const seatKeys = write("seat-keys.json", SEAT_KEYS);
  const caFile = write("demo-ca.pem", DEMO_CA);
  const leafFile = write("leaf.pem", LEAF);
  const pubFile = write("ep.pub.pem", SIGNER_PUB);
  const spec = {
    control_plane_base: `https://${IP}:8443`,
    gateway_base: `https://${IP}:8444/v1`,
    search_base: `https://${IP}:8445/v1/search`,
    pins: { control_plane: [leafFile], gateway: [leafFile], search: [leafFile] },
    backup_pins: [P3],
    cloud_ca_file: caFile,
    cp_public_keys_file: cpKeys,
    seat_public_keys_file: seatKeys,
    endpoint_profile_key_file: pubFile,
    endpoint_deployment: "demo-ip",
    test_build: true,
  };
  const out = join(dir, "release-out.json");
  const ok = node("make-release-config.mjs", ["--offline", "--spec", write("spec-ok.json", spec), "--out", out]);
  assert.equal(ok.status, 0, ok.stderr);
  const rel = loadReleaseConfig(out);
  assert.deepEqual(rel.problems, []);
  assert.equal(rel.env.ZR_CONTROL_PLANE_BASE, `https://${IP}:8443`);
  assert.equal(rel.env.ZR_CONTROL_PLANE_PINS.split(",").length, 2);
  assert.match(rel.env.ZR_CLOUD_CA_PEM!, /BEGIN CERTIFICATE/);
  assert.equal(rel.endpointProfile?.deployment, "demo-ip");
  const prod = node("make-release-config.mjs", ["--offline", "--spec", write("spec-prod.json", { ...spec, test_build: false }), "--out", join(dir, "release-prod.json")]);
  assert.notEqual(prod.status, 0);
  assert.match(prod.stderr, /只用于演示\/测试构建/);
});

test("make-release-config（在线）：ECDSA 叶子证书的钉住按 SPKI 计算，与客户端一致；IP 地址不发 SNI", async () => {
  const { createServer } = await import("node:https");
  const { spkiPin } = await import("../../../packages/egress-gate/src/tls-check.ts");
  const expected = spkiPin(Buffer.from(LEAF.replace(/-----[^-]+-----|\s/g, ""), "base64"));
  const { leafPin } = await import("../../../scripts/lib/release-pins.mjs");
  const srv2 = createServer({ cert: LEAF, key: LEAF_KEY }, (_q, s) => s.end("ok"));
  await new Promise<void>((r) => srv2.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (srv2.address() as { port: number }).port;
    const got = await leafPin(`https://127.0.0.1:${port}`, { caPem: DEMO_CA });
    assert.equal(got.pin, expected);
    assert.match(got.san, /IP Address:127\.0\.0\.1/);
    // 不给 CA：按公共根校验，失败（不放宽）
    await assert.rejects(leafPin(`https://127.0.0.1:${port}`));
  } finally {
    srv2.close();
  }
});

test("endpoint-profile：生成密钥 → 离线签发 → 用客户端代码核验；改一个字节即不通过", () => {
  const keyDir = join(dir, "ep-keys");
  const g = node("endpoint-profile.mjs", ["gen-key", "--dir", keyDir, "--kid", "ep-1"]);
  assert.equal(g.status, 0, g.stderr);
  const again = node("endpoint-profile.mjs", ["gen-key", "--dir", keyDir, "--kid", "ep-1"]);
  assert.notEqual(again.status, 0, "不覆盖已有密钥");
  const pub = readFileSync(join(keyDir, "ep-1.pub.pem"), "utf8");
  const relFile = write("rel-ep.json", { ...BASE, endpoint_profile: { deployment: "demo-ip", keys: { "ep-1": pub } } });
  const spec = write("addr.json", {
    control_plane_base: "https://cp.kwl.example.cn",
    gateway_base: "https://gw.kwl.example.cn/v1",
    search_base: "https://search.kwl.example.cn/v1/search",
    pins: { control_plane: [P1], gateway: [P1], search: [P1] },
    backup_pins: [P2],
  });
  const prof = join(dir, "cloud-endpoints.json");
  const s = node("endpoint-profile.mjs", ["sign", "--offline", "--spec", spec, "--key", join(keyDir, "ep-1.key.pem"), "--kid", "ep-1", "--deployment", "demo-ip", "--seq", "3", "--out", prof]);
  assert.equal(s.status, 0, s.stderr);
  const v = node("endpoint-profile.mjs", ["verify", "--release", relFile, "--profile", prof]);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /ZR_CONTROL_PLANE_BASE = https:\/\/cp\.kwl\.example\.cn/);
  const doc = JSON.parse(readFileSync(prof, "utf8"));
  const body = Buffer.from(doc.payload, "base64");
  body[body.length - 2] ^= 1;
  doc.payload = body.toString("base64");
  writeFileSync(prof, JSON.stringify(doc));
  const bad = node("endpoint-profile.mjs", ["verify", "--release", relFile, "--profile", prof]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /签名无效/);
});
