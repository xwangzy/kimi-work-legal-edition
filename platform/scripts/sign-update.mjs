/**
 * 发布签名清单（W7）：读取 electron-builder 产出的 latest.yml 与安装包，核对 sha512 与大小后生成 kwl-update-<渠道>.json（Ed25519 签名，带有效期）。
 * 客户端安装前按随包公钥核验它（apps/desktop/electron/update-verify.cjs）——更新源被攻破也装不进未经中软发布密钥签发的程序。
 *
 * 密钥：正式发布的私钥只在发布机的硬件模块/云签名服务里，经 KWL_RELEASE_SIGNING_KEY 指向 PKCS#8 PEM（或由签名服务替换本脚本的签名步骤）；
 * 只做测试时加 --dev-key 用 .cache/dev-release-key/（首次运行生成，**仅供测试**，不入库）；第 60 批起没给密钥又没加 --dev-key 即失败。
 * 用法：node scripts/sign-update.mjs [--release apps/desktop/release] [--channel latest]
 *       node scripts/sign-update.mjs --print-public-key   # 输出 release.json 的 update_keys 值
 *       未设 KWL_RELEASE_SIGNING_KEY 时须加 --dev-key 才会用开发密钥（第 60 批：原先静默改用）
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { manifestNameOf, signReleaseManifest, verifyReleaseManifest } = require("../apps/desktop/electron/update-verify.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

function loadKey() {
  if (process.env.KWL_RELEASE_SIGNING_KEY) return createPrivateKey(readFileSync(process.env.KWL_RELEASE_SIGNING_KEY));
  // 第 60 批（审计 11 文第 5 项）：不再静默改用开发发布密钥——没给 KWL_RELEASE_SIGNING_KEY 时须显式 --dev-key（只用于测试）
  if (!argv.includes("--dev-key")) {
    console.error("[sign-update] 须用 KWL_RELEASE_SIGNING_KEY 指向发布签名私钥；只做测试时显式加 --dev-key（用 .cache/dev-release-key 的开发密钥，不得用于对外发布）");
    process.exit(2);
  }
  const dir = join(root, ".cache/dev-release-key");
  const f = join(dir, "release-signing-dev.pem");
  if (!existsSync(f)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    console.log(`[sign-update] 生成仅供测试的发布签名密钥 → ${f}`);
  }
  return createPrivateKey(readFileSync(f));
}

const key = loadKey();
const spki = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
if (argv.includes("--print-public-key")) {
  console.log(spki);
  process.exit(0);
}

const releaseDir = arg("--release", join(root, "apps/desktop/release"));
const channel = arg("--channel", "latest");
const yml = readFileSync(join(releaseDir, `${channel}.yml`), "utf8");
const field = (name) => {
  const m = new RegExp(`^${name}:\\s*'?([^'\\n]+)'?\\s*$`, "m").exec(yml);
  if (!m) throw new Error(`${channel}.yml 缺少 ${name}`);
  return m[1].trim();
};
const version = field("version");
const file = field("path");
const sha512 = field("sha512");
const exe = join(releaseDir, file);
const size = statSync(exe).size;
const actual = createHash("sha512").update(readFileSync(exe)).digest("base64");
if (actual !== sha512) throw new Error(`${basename(exe)} 的 sha512 与 ${channel}.yml 不一致`);
// 有效期（复核 B4-A05）：缺省 30 天，客户端拒绝过期清单——发布流程须在到期前重签（不换安装包也要续签）
const validDays = Number(arg("--valid-days", "30"));
if (!Number.isInteger(validDays) || validDays < 1 || validDays > 90) throw new Error("--valid-days 须为 1–90 的整数");
const now = Date.now();
const doc = signReleaseManifest(
  { channel, version, file, sha512, size, released_at: new Date(now).toISOString(), expires_at: new Date(now + validDays * 86400_000).toISOString() },
  key,
);
verifyReleaseManifest(JSON.stringify(doc), [spki], { channel });
const outName = manifestNameOf(channel);
writeFileSync(join(releaseDir, outName), JSON.stringify(doc, null, 2) + "\n");
console.log(`[sign-update] ${version} ${file}（${size} 字节，有效 ${validDays} 天）→ ${join(releaseDir, outName)}；公钥 ${spki}`);
