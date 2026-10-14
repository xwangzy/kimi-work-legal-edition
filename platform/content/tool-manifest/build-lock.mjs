/**
 * 法律工具清单锁文件（v9 第 04 篇 §9 F3；阶段 1 对抗式审查 R-08 处置）。
 *
 * `tool-manifest.lock.json` 是**评审后提交**的独立事实来源：每个对 Agent 暴露的工具的 id、版本、副作用类别、资源、
 * 允许用途与输入 schema 的 hash。运行时内核以“验签后的锁文件”建立清单注册表，并逐项比对工具实现
 * （packages/kernel/src/tools/registry.ts 的 TOOLS）：schema、副作用、资源、版本任一不一致即不暴露该工具。
 * 新增写工具时把 sideEffect 写成 "read" 不会被自动批准——锁文件与实现不一致，且锁文件改动须经评审。
 *
 * 用法：
 *   node content/tool-manifest/build-lock.mjs              签名：lock → dist/tool-manifest.lock.json + .manifest.json
 *   node content/tool-manifest/build-lock.mjs --regenerate 由 TOOLS 重新生成锁文件草稿（开发者动作，须人工评审 diff 后提交）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256B64, signBytes } from "@zr-legal/keys";
import { signerKeyId } from "@zr-legal/lawdb";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const lockFile = join(here, "tool-manifest.lock.json");

if (process.argv.includes("--regenerate")) {
  const { TOOLS, LEGAL_MCP_SERVER, LEGAL_TOOL_PURPOSES } = await import("../../packages/kernel/src/tools/registry.ts");
  const { schemaHash } = await import("@zr-legal/host-policy");
  const lock = {
    kind: "tool-manifest-lock",
    server: LEGAL_MCP_SERVER,
    note: "评审后提交；改动 schema、副作用、资源、版本或用途必须同步本文件并经法律产品与安全双人评审",
    tools: TOOLS.map((t) => ({
      name: t.name,
      version: t.version,
      sideEffect: t.sideEffect,
      resource: t.resource,
      purposes: [...LEGAL_TOOL_PURPOSES],
      schemaHash: schemaHash(t.inputSchema),
    })),
  };
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
  console.log(`[tool-manifest] 已由 TOOLS 重新生成 ${lockFile}（${lock.tools.length} 项）——请人工评审 diff 后提交`);
  process.exit(0);
}

const key = JSON.parse(readFileSync(join(root, "content", "keys", "content-signing-dev.json"), "utf8"));
const content = readFileSync(lockFile);
const contentSha256 = sha256B64(new Uint8Array(content));
const distDir = join(here, "dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "tool-manifest.lock.json"), content);
writeFileSync(
  join(distDir, "tool-manifest.manifest.json"),
  JSON.stringify(
    {
      kind: "tool-manifest-lock",
      built_at: new Date().toISOString(),
      content_sha256: contentSha256,
      signature: signBytes(key.privateKeyPem, new TextEncoder().encode(contentSha256)),
      signer_key_id: signerKeyId(key.publicKeyPem),
    },
    null,
    2,
  ) + "\n",
);
console.log(`[tool-manifest] 已签名 → content/tool-manifest/dist/（hash ${contentSha256.slice(0, 16)}…）`);
