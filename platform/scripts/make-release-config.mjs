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
 *   "control_plane_base": "https://cp.kwl.example.com",                   // 没有域名时写 https://<公网 IP>:8443（证书须带该 IP 的 SAN）
 *   "gateway_base": "https://gw.kwl.example.com/v1",
 *   "search_base": "https://search.kwl.example.com/v1/search",
 *   "dist_base": "https://dist.kwl.example.com",          // 可选：法规库 / 方法模板在线更新
 *   "support_base": "...", "notify_base": "...", "relay_base": "...",   // 可选
 *   "update_base": "https://updates.kwl.example.com/kimi-work-legal/win", // 可选：自动更新源
 *   "update_keys": ["<sign-update.mjs --print-public-key 的输出>"], "update_publishers": ["<正式代码签名证书主体 CN>"],
 *   "backup_pins": ["/secure/backup-tls-key.pub.pem", "sha256/…="],       // 所有主机共用的备份钉住；也可按主机写 "<名>_backup_pins"
 *   "pins": { "gateway": ["sha256/…="] },                                // --offline 或要额外钉住时按主机给
 *   "cloud_ca_file": "/secure/demo-ca.crt",                               // 可选：中软云端私有 CA（只许 test_build；偏离 D-212）
 *   "endpoint_profile_key_file": "/secure/endpoint-profile.pub.pem",      // 可选：签名的云端地址配置验签公钥（偏离 D-213）
 *   "endpoint_deployment": "demo-ip", "endpoint_profile_kid": "ep-1",     // 与上一项同给
 *   "cp_public_keys_file": "/secure/kwl-prod/public/cp-public-keys.json",
 *   "seat_public_keys_file": "/secure/kwl-prod/public/seat-public-keys.json",
 *   "test_build": false                                                   // 内部测试包才写 true（正式发布门禁见 package-desktop.mjs）
 * }
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPins, readCaBundle, UPSTREAMS } from "./lib/release-pins.mjs";

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

// 私有 CA（偏离 D-212，演示/测试部署）：cloud_ca_file（旧名 ca_file）——既用来在线取钉住时校验证书，也写进 release.json 的 cloud_ca_pem
const caFile = spec.cloud_ca_file ?? spec.ca_file;
const caPem = caFile ? readCaBundle(caFile, fail) : undefined;
if (caPem && spec.test_build !== true) fail("cloud_ca_file 只用于演示/测试构建（test_build: true）；正式发布请用公共 CA 签发的证书（含 Let's Encrypt 的 IP 地址证书）");
const release = {};
const got = await collectPins(spec, { names: [...UPSTREAMS, "update"], offline, caPem, fail, log: (m) => console.log(`[make-release-config] ${m}`) });
for (const [name, { base, pins }] of Object.entries(got)) {
  release[`${name}_base`] = base;
  release[`${name}_pins`] = pins;
}
if (caPem) release.cloud_ca_pem = caPem;
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
// 签名的云端地址配置（偏离 D-213）：给了验签公钥才启用（scripts/endpoint-profile.mjs --gen-key 生成；私钥离线保管）
if (spec.endpoint_profile_key_file !== undefined) {
  if (typeof spec.endpoint_deployment !== "string") fail("给了 endpoint_profile_key_file 就要写 endpoint_deployment（部署标识，小写字母数字与连字符）");
  const pem = readFileSync(spec.endpoint_profile_key_file, "utf8");
  if (/PRIVATE KEY/.test(pem)) fail("endpoint_profile_key_file 是私钥：release.json 只放公钥");
  release.endpoint_profile = { deployment: spec.endpoint_deployment, keys: { [spec.endpoint_profile_kid ?? "ep-1"]: pem } };
}

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
