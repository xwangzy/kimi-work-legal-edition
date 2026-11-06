/**
 * 生成桌面安装包内置的云端上游配置 apps/desktop/electron/release.json（第 37 批）。这一份文件就是“本地 exe 与云端的对接点”：
 * 安装包形态下客户端只认它（地址 + 证书钉住集 + 控制面与席位公钥），不认环境变量，打进 asar 受完整性校验保护。
 *
 * 做的事：
 *   1. 按说明文件里的地址逐个连上服务（TLS，按系统或给定的 CA 校验证书），取叶子证书的 SPKI sha256 作“当前”钉住值；
 *   2. 加上说明文件给的备份钉住值（备用密钥对的公钥 / 证书 / CSR 文件，或直接写 sha256/...）——证书续期换新密钥时客户端不会断；
 *   3. 读 cloud-init-secrets 生成的公钥表，填 control_plane_keys（当前 + 下一把）与 seat_keys；
 *   4. 用客户端同一份校验代码（electron/release-config.cjs）核对，有任何问题即不写文件。
 *
 * 用法：node scripts/make-release-config.mjs --spec release-spec.json [--out apps/desktop/electron/release.json] [--offline]
 *   --offline：不连服务，钉住值全部取自说明文件（服务还没上线、或构建机连不到时）。
 *
 * 说明文件（JSON）：
 * {
 *   "control_plane_base": "https://cp.kwl.example.com",
 *   "gateway_base": "https://gw.kwl.example.com/v1",
 *   "search_base": "https://search.kwl.example.com/v1/search",
 *   "dist_base": "https://dist.kwl.example.com",          // 可选：法规库 / 方法模板在线更新
 *   "support_base": "...", "notify_base": "...", "relay_base": "...",   // 可选
 *   "update_base": "https://updates.kwl.example.com/kimi-work-legal/win", // 可选：自动更新源
 *   "update_keys": ["<sign-update.mjs --print-public-key 的输出>"], "update_publishers": ["<正式代码签名证书主体 CN>"],
 *   "backup_pins": ["/secure/backup-tls-key.pub.pem", "sha256/…="],       // 所有主机共用的备份钉住；也可按主机写 "<名>_backup_pins"
 *   "pins": { "gateway": ["sha256/…="] },                                // --offline 或要额外钉住时按主机给
 *   "ca_file": "/etc/kwl/internal-ca.crt",                                // 可选：私有 CA
 *   "cp_public_keys_file": "/secure/kwl-prod/public/cp-public-keys.json",
 *   "seat_public_keys_file": "/secure/kwl-prod/public/seat-public-keys.json",
 *   "test_build": false                                                   // 内部测试包才写 true（正式发布门禁见 package-desktop.mjs）
 * }
 */
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const { loadReleaseConfig } = require(join(root, "apps/desktop/electron/release-config.cjs"));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const specFile = opt("--spec");
const out = opt("--out", join(root, "apps/desktop/electron/release.json"));
const offline = argv.includes("--offline");
if (!specFile) {
  console.error("用法：node scripts/make-release-config.mjs --spec release-spec.json [--out 文件] [--offline]");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specFile, "utf8"));
const fail = (m) => {
  console.error(`[make-release-config] ${m}`);
  process.exit(1);
};

const pinOfDer = (der) => `sha256/${createHash("sha256").update(der).digest("base64")}`;
/** 备份钉住：sha256/… 原样；文件可以是公钥 PEM、证书 PEM（取其公钥）。 */
function pinOf(x) {
  if (/^sha256\/[A-Za-z0-9+/]{43}=$/.test(x)) return x;
  const text = readFileSync(x, "utf8");
  if (/PRIVATE KEY/.test(text)) fail(`${x} 是私钥：备份钉住只要公钥（openssl pkey -in key.pem -pubout）`);
  const key = /BEGIN CERTIFICATE/.test(text) ? new X509Certificate(text).publicKey : createPublicKey(text);
  return pinOfDer(key.export({ type: "spki", format: "der" }));
}

function leafPin(base) {
  const u = new URL(base);
  const ca = spec.ca_file ? readFileSync(spec.ca_file, "utf8") : undefined;
  return new Promise((ok, no) => {
    const s = connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname, ...(ca ? { ca } : {}), minVersion: "TLSv1.2", timeout: 10_000 }, () => {
      const cert = s.getPeerCertificate(false);
      s.end();
      if (!cert?.pubkey) return no(new Error("没有拿到证书"));
      ok({ pin: pinOfDer(cert.pubkey), subject: cert.subject?.CN ?? "", until: cert.valid_to });
    });
    s.on("error", (e) => no(e));
    s.on("timeout", () => (s.destroy(), no(new Error("连接超时"))));
  });
}

const HOSTS = ["control_plane", "gateway", "search", "dist", "support", "notify", "relay", "update"];
const release = {};
for (const name of HOSTS) {
  const base = spec[`${name}_base`];
  if (base === undefined) continue;
  if (typeof base !== "string" || !base.startsWith("https://")) fail(`${name}_base 必须是 https 地址`);
  const pins = new Set((spec.pins?.[name] ?? []).map(pinOf));
  if (!offline) {
    try {
      const r = await leafPin(base);
      pins.add(r.pin);
      console.log(`[make-release-config] ${name}：${new URL(base).host} 证书 CN=${r.subject}，到 ${r.until}，钉住 ${r.pin}`);
    } catch (e) {
      fail(`${name}：连不上 ${base}（${e.message}）。服务还没上线可用 --offline，并在 pins.${name} 里给出钉住值`);
    }
  }
  for (const b of [...(spec.backup_pins ?? []), ...(spec[`${name}_backup_pins`] ?? [])]) pins.add(pinOf(b));
  if (pins.size < 2) fail(`${name} 只有 ${pins.size} 个钉住值：至少要当前 + 备份两把（备份密钥对离线生成，证书续期时换用，见部署文档“证书与钉住”）`);
  release[`${name}_base`] = base.replace(/\/+$/, "");
  release[`${name}_pins`] = [...pins];
}
for (const k of ["control_plane", "gateway", "search"]) if (!release[`${k}_base`]) fail(`缺少 ${k}_base（控制面、网关、检索三项必填）`);
if (spec.cp_public_keys_file) release.control_plane_keys = JSON.parse(readFileSync(spec.cp_public_keys_file, "utf8"));
if (spec.seat_public_keys_file) release.seat_keys = JSON.parse(readFileSync(spec.seat_public_keys_file, "utf8"));
if (!release.control_plane_keys || !release.seat_keys) fail("须给 cp_public_keys_file 与 seat_public_keys_file（cloud-init-secrets 生成的 public/ 目录）");
if (release.update_base) {
  release.update_keys = spec.update_keys ?? [];
  release.update_publishers = spec.update_publishers ?? [];
  if (spec.update_channel) release.update_channel = spec.update_channel;
}
if (spec.dist_channel) release.dist_channel = spec.dist_channel;
if (spec.content_keys) release.content_keys = spec.content_keys;
if (spec.test_build === true) release.test_build = true;

// 用客户端同一份代码核对（失败关闭：有问题即不写）
const tmp = `${out}.check-${process.pid}`;
writeFileSync(tmp, JSON.stringify(release));
let verdict;
try {
  verdict = loadReleaseConfig(tmp);
} finally {
  try {
    (await import("node:fs")).rmSync(tmp);
  } catch {
    // 已删
  }
}
if (verdict.problems?.length) fail(`客户端校验不通过：\n  - ${verdict.problems.join("\n  - ")}`);
writeFileSync(out, `${JSON.stringify(release, null, 2)}\n`);
console.log(`[make-release-config] 已写 ${out}（${Object.keys(release).filter((k) => k.endsWith("_base")).length} 个上游${release.test_build ? "；测试包" : ""}）。下一步：node scripts/package-desktop.mjs --sign env（或推到 main 由 Windows CI 构建）`);
