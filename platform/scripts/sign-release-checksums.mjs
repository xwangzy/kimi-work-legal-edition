/**
 * 安装包摘要清单与发布签名（第 60 批安全加固 H3）：给对外分发的 EXE / DMG 生成 SHA256SUMS.txt，并用中软发布签名密钥（Ed25519）签名。
 *
 * 为什么要它：还没有 Windows OV/EV 代码签名证书与 Apple Developer ID 时，操作系统核验不了安装包出自谁；
 * 客户 IT 可以按随附的发布公钥核对“这份清单确实由中软签发、安装包摘要与清单一致”，下载渠道被替换或文件被改动都能发现。
 * 证书到位后仍保留：代码签名证明“谁签的程序”，本清单再证明“这一批对外分发的就是这几个文件”。
 *
 * 密钥：KWL_RELEASE_SIGNING_KEY 指向 Ed25519 私钥（PKCS#8 PEM，离线保管、不入库、不上传 CI）——与自动更新签名清单（sign-update.mjs）同一把发布密钥。
 * 用法：
 *   node scripts/sign-release-checksums.mjs --out <目录> <安装包>...      # 写 <目录>/SHA256SUMS.txt、SHA256SUMS.txt.sig、release-signing.pub.pem
 *   node scripts/sign-release-checksums.mjs --verify <目录>              # 核对签名与目录里各文件的摘要（只用公钥）
 * 不用本脚本的核对方法（OpenSSL 3）：
 *   base64 -d SHA256SUMS.txt.sig > sig.bin
 *   openssl pkeyutl -verify -pubin -inkey release-signing.pub.pem -rawin -in SHA256SUMS.txt -sigfile sig.bin
 *   shasum -a 256 -c SHA256SUMS.txt        （Windows：Get-FileHash <文件> -Algorithm SHA256）
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const fail = (m) => {
  console.error(`[sign-release-checksums] ${m}`);
  process.exit(1);
};
const sha256File = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
// 文件名只许 ASCII 可见字符且不含路径（与安装包命名一致；SHA256SUMS 一行一个“摘要  文件名”）
const NAME = /^[A-Za-z0-9._+-]{1,128}$/;

/** 解析 SHA256SUMS 文本（纯函数，用例直接调用）。 */
export function parseSums(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *]([^\s/\\]+)$/.exec(line.replace(/\r$/, ""));
    if (!m || !NAME.test(m[2])) throw new Error(`SHA256SUMS 行格式不对：${line.slice(0, 100)}`);
    out.push({ sha256: m[1], name: m[2] });
  }
  if (!out.length) throw new Error("SHA256SUMS 为空");
  return out;
}

/** 核对一个目录：签名（Ed25519，对 SHA256SUMS.txt 原文字节）+ 各文件摘要。返回问题列表（空即通过）。 */
export function verifyDir(dir, pubPem = readFileSync(join(dir, "release-signing.pub.pem"), "utf8")) {
  const problems = [];
  const sums = readFileSync(join(dir, "SHA256SUMS.txt"));
  const sig = Buffer.from(readFileSync(join(dir, "SHA256SUMS.txt.sig"), "utf8").trim(), "base64");
  if (!verify(null, sums, createPublicKey(pubPem), sig)) problems.push("签名不符：SHA256SUMS.txt 不是这把发布公钥签发的，或已被改动");
  for (const { sha256, name } of parseSums(sums.toString("utf8"))) {
    const f = join(dir, name);
    if (!existsSync(f)) problems.push(`缺少文件：${name}`);
    else if (sha256File(f) !== sha256) problems.push(`摘要不符：${name}`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("sign-release-checksums.mjs")) {
  const vdir = opt("--verify");
  if (vdir) {
    const problems = verifyDir(vdir);
    if (problems.length) fail(`核对不通过：\n  - ${problems.join("\n  - ")}`);
    console.log(`[sign-release-checksums] 核对通过：签名有效，${parseSums(readFileSync(join(vdir, "SHA256SUMS.txt"), "utf8")).length} 个文件摘要一致`);
    process.exit(0);
  }
  const out = opt("--out");
  const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out");
  if (!out || !files.length) fail("用法：node scripts/sign-release-checksums.mjs --out <目录> <安装包>...   或   --verify <目录>");
  const keyFile = process.env.KWL_RELEASE_SIGNING_KEY;
  if (!keyFile || !existsSync(keyFile)) fail("须用 KWL_RELEASE_SIGNING_KEY 指向发布签名私钥（Ed25519 PKCS#8 PEM，离线保管）");
  const key = createPrivateKey(readFileSync(keyFile));
  if (key.asymmetricKeyType !== "ed25519") fail("发布签名私钥须为 Ed25519");
  mkdirSync(out, { recursive: true });
  const lines = [];
  for (const f of files) {
    const name = basename(f);
    if (!NAME.test(name)) fail(`文件名须为 ASCII（字母、数字、. _ + -）：${name}`);
    if (join(out, name) !== f) copyFileSync(f, join(out, name));
    lines.push(`${sha256File(f)}  ${name}`);
  }
  const text = `${lines.join("\n")}\n`;
  writeFileSync(join(out, "SHA256SUMS.txt"), text);
  writeFileSync(join(out, "SHA256SUMS.txt.sig"), `${sign(null, Buffer.from(text), key).toString("base64")}\n`);
  const pubPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  writeFileSync(join(out, "release-signing.pub.pem"), pubPem);
  const problems = verifyDir(out, pubPem);
  if (problems.length) fail(`自检不通过：${problems.join("；")}`);
  const fp = createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex");
  console.log(`[sign-release-checksums] ${lines.length} 个文件 → ${out}/SHA256SUMS.txt（已签名）；发布公钥指纹 sha256:${fp}`);
}
