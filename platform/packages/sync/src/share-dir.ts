/**
 * 共享文件夹介质（方案 §7.2）：只放不可变的段文件与密文块；
 * 写入「临时名 → 刷盘 → 原子改名」；**绝不放 SQLite 或任何需要锁的文件**（注释即契约）。
 * 读取端忽略半成品与各类冲突副本命名并分类告警：
 * - `.tmp-*` 半成品（写入中断的正常残留）；
 * - `.sync-conflict-*`（群晖/网盘冲突副本）；
 * - `conflicted copy` / `*冲突副本*`（其他同步器冲突副本）——出现即告警（§7.2）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ShareWarnings {
  tmpFiles: string[];
  conflictCopies: string[];
}

export function emptyWarnings(): ShareWarnings {
  return { tmpFiles: [], conflictCopies: [] };
}

export function mergeWarnings(a: ShareWarnings, b: ShareWarnings): ShareWarnings {
  return { tmpFiles: [...a.tmpFiles, ...b.tmpFiles], conflictCopies: [...a.conflictCopies, ...b.conflictCopies] };
}

function classifyName(name: string): "tmp" | "conflict" | null {
  if (name.startsWith(".tmp-")) return "tmp";
  if (name.includes(".sync-conflict-") || /conflicted copy/i.test(name) || name.includes("冲突副本")) return "conflict";
  return null;
}

export function segmentsDirOf(shareDir: string, tenantId: string): string {
  return join(shareDir, tenantId, "segments");
}

export function blobsDirOf(shareDir: string, tenantId: string): string {
  return join(shareDir, tenantId, "blobs");
}

/** 原子写（临时名 → 刷盘 → 改名；网络文件系统写乱序/锁不可靠的对应纪律，§7.2）。 */
export function atomicWriteFile(path: string, content: Buffer | string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = join(path, "..", `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function writeSegment(shareDir: string, tenantId: string, deviceId: string, segmentId: string, content: string): string {
  const path = join(segmentsDirOf(shareDir, tenantId), deviceId, `${segmentId}.seg`);
  atomicWriteFile(path, content);
  return path;
}

export function writeShareBlob(shareDir: string, tenantId: string, scope: string, sha256: string, content: Buffer, replace?: (existing: Buffer) => boolean): string {
  const path = join(blobsDirOf(shareDir, tenantId), scope, sha256);
  // 同名块内容不同即覆盖（第 12 批第四轮复核 S12A-24：本机按段的纪元重封过的块；块名是明文摘要，接收方读时核对）；
  // 调用方可以否决覆盖（第五轮复核 S12A-27：不用低纪元的副本覆盖高纪元的）
  if (!existsSync(path)) atomicWriteFile(path, content);
  else {
    const existing = readFileSync(path);
    if (!existing.equals(content) && (!replace || replace(existing))) atomicWriteFile(path, content);
  }
  return path;
}

export interface SegmentCandidate {
  deviceId: string;
  path: string;
  content: string;
}

/** 扫描段目录（只列候选与告警；封口/签名/证书链校验在摄取管线做）。 */
export function scanSegments(shareDir: string, tenantId: string): { candidates: SegmentCandidate[]; warnings: ShareWarnings } {
  const warnings = emptyWarnings();
  const candidates: SegmentCandidate[] = [];
  const root = segmentsDirOf(shareDir, tenantId);
  if (!existsSync(root)) return { candidates, warnings };
  for (const deviceId of readdirSync(root)) {
    const devDir = join(root, deviceId);
    let names: string[];
    try {
      names = readdirSync(devDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const cls = classifyName(name);
      if (cls === "tmp") {
        warnings.tmpFiles.push(join(deviceId, name));
        continue;
      }
      if (cls === "conflict") {
        warnings.conflictCopies.push(join(deviceId, name));
        continue;
      }
      if (!name.endsWith(".seg")) continue;
      try {
        candidates.push({ deviceId, path: join(devDir, name), content: readFileSync(join(devDir, name), "utf8") });
      } catch {
        // 读不到的忽略（半成品/权限问题由告警体系外的日志兜底）
      }
    }
  }
  return { candidates, warnings };
}
