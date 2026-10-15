/**
 * 生成**仅供测试**的自签名 Authenticode 代码签名证书（.cache/dev-codesign/，不入库）。
 * 用途：在正式 EV/OV 证书到位前跑通“签名 → 安装 → 更新校验”整条链路；用它签的安装包在律师电脑上仍会被 SmartScreen 提示，
 * 不得对外发布。正式发布用 --sign env（CSC_LINK / CSC_KEY_PASSWORD 由发布流程注入）。
 * 依赖系统 openssl。用法：node scripts/dev-codesign.mjs
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../.cache/dev-codesign/", import.meta.url));
mkdirSync(dir, { recursive: true, mode: 0o700 });
if (existsSync(join(dir, "dev-codesign.pfx"))) {
  console.log(`[dev-codesign] 已存在：${dir}`);
  process.exit(0);
}
const pass = randomBytes(18).toString("base64url");
writeFileSync(join(dir, "password.txt"), pass + "\n", { mode: 0o600 });
writeFileSync(
  join(dir, "openssl.cnf"),
  [
    "[req]",
    "distinguished_name=dn",
    "x509_extensions=ext",
    "prompt=no",
    "[dn]",
    "CN=Kimi Work Legal DEV TEST ONLY",
    "O=ChinaSoft International (DEV TEST ONLY)",
    "C=CN",
    "[ext]",
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature",
    "extendedKeyUsage=critical,codeSigning",
    "subjectKeyIdentifier=hash",
    "",
  ].join("\n"),
);
const o = (args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
o(["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-days", "365", "-nodes", "-keyout", "key.pem", "-out", "cert.pem", "-config", "openssl.cnf"]);
o(["pkcs12", "-export", "-out", "dev-codesign.pfx", "-inkey", "key.pem", "-in", "cert.pem", "-passout", `pass:${pass}`, "-keypbe", "AES-256-CBC", "-certpbe", "AES-256-CBC", "-macalg", "sha256"]);
console.log(`[dev-codesign] 测试证书 → ${dir}（仅供测试，不得用于对外发布）`);
