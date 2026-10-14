/**
 * 法律工具清单锁文件（v9 第 04 篇 §9 F3；阶段 1 对抗式审查 R-08 处置）。
 *
 * 清单的事实来源是**评审后提交、随包签名**的 `content/tool-manifest/tool-manifest.lock.json`，而不是工具实现本身：
 * - 运行时先验签（同一把内容签名公钥），验签失败或文件缺失 → 清单为空，任何法律工具都不暴露、不可调用（失败关闭）；
 * - 再逐项比对实现（registry.ts 的 TOOLS）：schema hash、副作用、资源、版本任一与锁文件不一致 → 该工具不暴露；
 * - 锁文件中没有的实现工具 → 不暴露。
 * 这样“改了 schema 或把写工具声明成 read”不会被静默放行：要么锁文件不一致被拒，要么锁文件改动走评审。
 */
import { readFileSync } from "node:fs";
import { sha256B64, verifyBytes } from "@zr-legal/keys";
import { ManifestRegistry, qualifyMcpToolName, schemaHash, type SideEffect, type ToolManifest, type ToolResource } from "@zr-legal/host-policy";

export interface ToolLockEntry {
  name: string;
  version: string;
  sideEffect: SideEffect;
  resource: ToolResource;
  purposes: string[];
  schemaHash: string;
}

export interface ToolLock {
  server: string;
  tools: ToolLockEntry[];
}

/** 读取并验签锁文件（`<file>` 与同目录 `tool-manifest.manifest.json`）。任何问题都抛错（调用方失败关闭）。 */
export function loadSignedToolLock(file: string, signerPub: string): ToolLock {
  const content = readFileSync(file);
  const manifest = JSON.parse(readFileSync(file.replace(/tool-manifest\.lock\.json$/, "tool-manifest.manifest.json"), "utf8")) as {
    content_sha256?: string;
    signature?: string;
  };
  const hash = sha256B64(new Uint8Array(content));
  if (manifest.content_sha256 !== hash) throw new Error("工具清单锁文件 hash 不符");
  if (!signerPub || typeof manifest.signature !== "string" || !verifyBytes(signerPub, new TextEncoder().encode(hash), manifest.signature)) {
    throw new Error("工具清单锁文件验签失败");
  }
  const lock = JSON.parse(content.toString("utf8")) as ToolLock;
  if (typeof lock.server !== "string" || !Array.isArray(lock.tools)) throw new Error("工具清单锁文件格式不符");
  return lock;
}

/** 由锁文件建立清单注册表（schema hash 取锁文件中的值，不由实现现场计算）。 */
export function registryFromLock(lock: ToolLock): ManifestRegistry {
  return new ManifestRegistry(
    lock.tools.map(
      (t): ToolManifest =>
        Object.freeze({
          id: qualifyMcpToolName(lock.server, t.name),
          server: lock.server,
          name: t.name,
          version: t.version,
          sideEffect: t.sideEffect,
          resource: t.resource,
          purposes: Object.freeze([...t.purposes]),
          schemaHash: t.schemaHash,
        }),
    ),
  );
}

/** 实现与锁文件逐项比对，返回不一致项（工具名 → 原因）；这些工具不得暴露。 */
export function verifyToolsAgainstLock(
  lock: ToolLock | null,
  tools: readonly { name: string; version: string; sideEffect: SideEffect; resource: ToolResource; inputSchema: Record<string, unknown> }[],
): Map<string, string> {
  const problems = new Map<string, string>();
  for (const t of tools) {
    const entry = lock?.tools.find((e) => e.name === t.name);
    if (!lock) problems.set(t.name, "锁文件不可用（失败关闭）");
    else if (!entry) problems.set(t.name, "锁文件未登记");
    else if (entry.schemaHash !== schemaHash(t.inputSchema)) problems.set(t.name, "schema hash 与锁文件不一致");
    else if (entry.sideEffect !== t.sideEffect) problems.set(t.name, "副作用类别与锁文件不一致");
    else if (entry.resource !== t.resource) problems.set(t.name, "资源范围与锁文件不一致");
    else if (entry.version !== t.version) problems.set(t.name, "版本与锁文件不一致");
  }
  return problems;
}
