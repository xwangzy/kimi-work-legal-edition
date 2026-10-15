/**
 * 自动更新的发布签名核验（W7，electron/update-verify.cjs）：更新源被攻破时，未经中软发布密钥签发、被替换、被降级的安装包都不能安装。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const v = require("../electron/update-verify.cjs") as {
  canonicalJson: (x: unknown) => string;
  verifyReleaseManifest: (text: string, keys: string[], o?: { channel?: string; now?: number }) => any;
  checkDownloaded: (p: any, o: { expectedVersion: string; currentVersion: string; file: string; expectedFile?: string }) => string | null;
  manifestNameOf: (c: string) => string;
  classifyUpdateError: (e: unknown) => { state: string; message: string };
  ManifestUnavailableError: new (m: string) => Error & { code: string };
  fallbackManifest: (e: unknown, pre: any, version: string, now?: number) => any;
  signReleaseManifest: (p: any, k: any) => any;
  tlsPinMatch: (chain: string[], pins: string[]) => boolean;
};
const { loadReleaseConfig } = require("../electron/release-config.cjs") as { loadReleaseConfig: (f: string) => { problems: string[]; update: any } };

const dir = mkdtempSync(join(tmpdir(), "kwl-upd-"));
const kp = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const spki = (k: any) => k.export({ type: "spki", format: "der" }).toString("base64");
const exe = join(dir, "KimiWorkLegal-Setup-0.3.0.exe");
const bytes = Buffer.from("MZ…installer bytes…");
writeFileSync(exe, bytes);
const sha512 = createHash("sha512").update(bytes).digest("base64");
const released = Date.now() - 3600_000;
const payload = {
  channel: "latest",
  version: "0.3.0",
  file: "KimiWorkLegal-Setup-0.3.0.exe",
  sha512,
  size: bytes.length,
  released_at: new Date(released).toISOString(),
  expires_at: new Date(released + 30 * 86400_000).toISOString(),
};

test("合法签名清单通过，下载的安装包与清单一致才放行", () => {
  const doc = v.signReleaseManifest(payload, kp.privateKey);
  const p = v.verifyReleaseManifest(JSON.stringify(doc), [spki(kp.publicKey)]);
  assert.equal(p.version, "0.3.0");
  assert.equal(v.checkDownloaded(p, { expectedVersion: "0.3.0", currentVersion: "0.2.0", file: exe }), null);
  assert.equal(v.checkDownloaded(p, { expectedVersion: "0.3.0", currentVersion: "0.2.0", file: exe, expectedFile: "KimiWorkLegal-Setup-0.3.0.exe" }), null);
});

test("清单有效期（复核 B4-A05）：过期、签发时间在未来、有效期超过 90 天、缺字段一律拒绝；按渠道命名；文件名须与 latest.yml 一致且只用 ASCII", () => {
  const sign = (o: Record<string, unknown>) => JSON.stringify(v.signReleaseManifest({ ...payload, ...o }, kp.privateKey));
  const keys = [spki(kp.publicKey)];
  assert.throws(() => v.verifyReleaseManifest(sign({}), keys, { now: released + 31 * 86400_000 }), /已过期/);
  assert.throws(() => v.verifyReleaseManifest(sign({ released_at: new Date(Date.now() + 3 * 86400_000).toISOString(), expires_at: new Date(Date.now() + 9 * 86400_000).toISOString() }), keys), /晚于本机时间/);
  assert.throws(() => v.verifyReleaseManifest(sign({ expires_at: new Date(released + 91 * 86400_000).toISOString() }), keys), /有效期不合法/);
  assert.throws(() => v.verifyReleaseManifest(sign({ expires_at: undefined }), keys), /有效期不合法/);
  assert.throws(() => v.verifyReleaseManifest(sign({ file: "Kimi Work 法律版 Setup 0.3.0.exe" }), keys), /文件名不合法/);
  const p = v.verifyReleaseManifest(sign({}), keys);
  assert.match(v.checkDownloaded(p, { expectedVersion: "0.3.0", currentVersion: "0.2.0", file: exe, expectedFile: "Other-0.3.0.exe" }) ?? "", /文件名/);
  assert.equal(v.manifestNameOf("latest"), "kwl-update-latest.json");
  assert.equal(v.manifestNameOf("beta"), "kwl-update-beta.json");
  assert.throws(() => v.manifestNameOf("../x"));
});

test("更新错误分类（复核 B4-A07）：取不到清单只是“稍后重试”，签名或摘要不符才是“已丢弃、联系 IT”", () => {
  assert.equal(v.classifyUpdateError(new v.ManifestUnavailableError("HTTP 404")).state, "error");
  assert.equal(v.classifyUpdateError(Object.assign(new Error("x"), { code: "ERR_UPDATER_INVALID_SIGNATURE" })).state, "rejected");
  assert.equal(v.classifyUpdateError(Object.assign(new Error("x"), { code: "KWL_UPDATE_REJECTED" })).state, "rejected");
  assert.equal(v.classifyUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED")).state, "error");
  assert.match(v.classifyUpdateError(null).message, /稍后/);
});

test("非发布密钥签名、篡改清单字段、渠道不符一律拒绝", () => {
  const forged = v.signReleaseManifest(payload, other.privateKey);
  assert.throws(() => v.verifyReleaseManifest(JSON.stringify(forged), [spki(kp.publicKey)]), /发布签名无效/);
  const doc = v.signReleaseManifest(payload, kp.privateKey);
  const tampered = { ...doc, payload: { ...doc.payload, sha512: createHash("sha512").update("恶意程序").digest("base64") } };
  assert.throws(() => v.verifyReleaseManifest(JSON.stringify(tampered), [spki(kp.publicKey)]), /发布签名无效/);
  assert.throws(() => v.verifyReleaseManifest(JSON.stringify(doc), [spki(kp.publicKey)], { channel: "beta" }), /渠道不符/);
  assert.throws(() => v.verifyReleaseManifest(JSON.stringify(doc), []), /未配置更新签名公钥/);
  assert.throws(() => v.verifyReleaseManifest('{"payload":{"__proto__":{}}}', [spki(kp.publicKey)]));
});

test("安装包被替换、大小不符、降级或版本与待装版本不一致都拒绝", () => {
  const p = v.verifyReleaseManifest(JSON.stringify(v.signReleaseManifest(payload, kp.privateKey)), [spki(kp.publicKey)]);
  const swapped = join(dir, "swapped.exe");
  writeFileSync(swapped, Buffer.from("MZ…installer bytez…"));
  assert.match(v.checkDownloaded(p, { expectedVersion: "0.3.0", currentVersion: "0.2.0", file: swapped }) ?? "", /摘要/);
  const short = join(dir, "short.exe");
  writeFileSync(short, Buffer.from("MZ"));
  assert.match(v.checkDownloaded(p, { expectedVersion: "0.3.0", currentVersion: "0.2.0", file: short }) ?? "", /大小/);
  assert.match(v.checkDownloaded(p, { expectedVersion: "0.3.0", currentVersion: "0.3.0", file: exe }) ?? "", /降级或同版本/);
  assert.match(v.checkDownloaded(p, { expectedVersion: "0.3.0", currentVersion: "0.10.0", file: exe }) ?? "", /降级/);
  assert.match(v.checkDownloaded(p, { expectedVersion: "0.4.0", currentVersion: "0.2.0", file: exe }) ?? "", /不一致/);
});

// 测试夹具：自签名 EC 证书（CN=updates.example.invalid）与它的 SPKI sha256 钉住值（openssl 生成，只用于本测试）
const CERT = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUKrQvSD+j2srnuKUiJez66J2GrkEwCgYIKoZIzj0EAwIw
IjEgMB4GA1UEAwwXdXBkYXRlcy5leGFtcGxlLmludmFsaWQwHhcNMjYxMDE0MDUw
MjA3WhcNMzYxMDExMDUwMjA3WjAiMSAwHgYDVQQDDBd1cGRhdGVzLmV4YW1wbGUu
aW52YWxpZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABAW4ARHEQpTebzt6WFSX
QZn92a8/WqZXARG9UP7c3xUu6FToNfc/rZ0Z9c+FIy+YwdcQ50aFi62LzrN1qi/G
QAWjUzBRMB0GA1UdDgQWBBRrS6BZ6F1IPfQ5ndmOUn9rNBXBnTAfBgNVHSMEGDAW
gBRrS6BZ6F1IPfQ5ndmOUn9rNBXBnTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0gAMEUCIAF/H4raV/q3kkZ63XBwJ2qs8MkBZAbN3ftpyeFgCMhfAiEAz/vi
LiTFImWg/FOCxskjrXySXYUOY7My+qjHmy4NYvo=
-----END CERTIFICATE-----
`;
const CERT_PIN = "sha256/97MhecEmKxg0Q+S9Mq50Kzk3zNxWhHFrDwwxU3gkjyE=";

test("证书链钉住：链中任一证书的 SPKI 摘要命中钉住集才通过（按 X509Certificate.publicKey 导出的 SPKI 计算）", () => {
  const other = `sha256/${Buffer.alloc(32, 7).toString("base64")}`;
  assert.equal(new X509Certificate(CERT).subject, "CN=updates.example.invalid");
  assert.equal(v.tlsPinMatch([CERT], [other, CERT_PIN]), true);
  assert.equal(v.tlsPinMatch(["不是证书", CERT], [CERT_PIN]), true, "链中后续证书命中也算");
  assert.equal(v.tlsPinMatch([CERT], [other]), false);
  assert.equal(v.tlsPinMatch([], [CERT_PIN]), false);
  assert.equal(v.tlsPinMatch(["不是证书"], [CERT_PIN]), false);
});

test("release.json 的更新配置：https + 两把钉住 + Ed25519 公钥，缺一即不启用", () => {
  const P1 = `sha256/${Buffer.alloc(32, 1).toString("base64")}`;
  const P2 = `sha256/${Buffer.alloc(32, 2).toString("base64")}`;
  const f = (o: unknown) => {
    const p = join(dir, `r${Math.random()}.json`);
    writeFileSync(p, JSON.stringify(o));
    return loadReleaseConfig(p);
  };
  const ok = f({ update_base: "https://updates.example.cn/kwl/win/", update_pins: [P1, P2], update_keys: [spki(kp.publicKey)] });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.update.base, "https://updates.example.cn/kwl/win");
  assert.equal(f({ update_base: "http://updates.example.cn", update_pins: [P1, P2], update_keys: [spki(kp.publicKey)] }).update, null);
  assert.equal(f({ update_base: "https://u.example.cn", update_pins: [P1], update_keys: [spki(kp.publicKey)] }).update, null);
  assert.equal(f({ update_base: "https://u.example.cn", update_pins: [P1, P2], update_keys: [] }).update, null);
  assert.equal(f({}).update, null);
});

test("下载后再取清单失败（复核 B4-R16）：只在“取不到”时回用下载前已核验、同版本、未过期的清单；签名不符不回用", () => {
  const pre = v.verifyReleaseManifest(JSON.stringify(v.signReleaseManifest(payload, kp.privateKey)), [spki(kp.publicKey)]);
  const offline = new v.ManifestUnavailableError("HTTP 503");
  assert.equal(v.fallbackManifest(offline, pre, "0.3.0"), pre);
  assert.equal(v.fallbackManifest(offline, pre, "0.4.0"), null, "版本不同不回用");
  assert.equal(v.fallbackManifest(offline, pre, "0.3.0", Date.parse(pre.expires_at) + 1), null, "过期不回用");
  assert.equal(v.fallbackManifest(new Error("更新清单的发布签名无效"), pre, "0.3.0"), null, "签名不符不回用");
  assert.equal(v.fallbackManifest(offline, null, "0.3.0"), null);
});
