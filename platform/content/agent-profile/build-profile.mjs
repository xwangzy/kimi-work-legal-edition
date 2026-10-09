/**
 * 法律 Agent profile 签名构建（方案 §4.3/探针 1「缺签名 profile 时失败关闭」）：
 * legal-agent.md → dist/legal-agent.md + legal-agent.manifest.json（content_sha256 + Ed25519
 * 签名 + signer_key_id）。复用法规库同一把内容签名密钥（content/keys/content-signing-dev.json，
 * G0 开发形态；生产私钥在硬件模块/云签名）。用法：npm run build:agent-profile。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256B64, signBytes } from "@zr-legal/keys";
import { signerKeyId } from "@zr-legal/lawdb";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const keyFile = join(root, "content", "keys", "content-signing-dev.json");
const key = JSON.parse(readFileSync(keyFile, "utf8"));

const src = join(here, "legal-agent.md");
const content = readFileSync(src);
const contentSha256 = sha256B64(new Uint8Array(content));

const distDir = join(here, "dist");
mkdirSync(distDir, { recursive: true });
const outFile = join(distDir, "legal-agent.md");
copyFileSync(src, outFile);

const manifest = {
  kind: "agent-profile",
  name: "legal-agent",
  built_at: new Date().toISOString(),
  content_sha256: contentSha256,
  signature: signBytes(key.privateKeyPem, new TextEncoder().encode(contentSha256)),
  signer_key_id: signerKeyId(key.publicKeyPem),
};
writeFileSync(join(distDir, "legal-agent.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[build:agent-profile] ${outFile}（+ legal-agent.manifest.json）`);
console.log(`[build:agent-profile] 内容 hash: ${contentSha256.slice(0, 16)}… 签名者指纹: ${manifest.signer_key_id}`);
