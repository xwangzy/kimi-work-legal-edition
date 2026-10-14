/**
 * 工作区产物入库（Kimi Code 集成核查 P0-1）：Agent 在事项工作区写下的文件（草稿、表格、修订稿）作为草稿成果登记，
 * 律师在执行态与交付件页可见。
 *
 * 做法：运行开始时为工作区建快照（路径 → 大小、修改时间、sha256），终态时比对，新增或改动的常规文件即为本次产物。
 * 只收常规文件（链接、设备文件不收）、只收律师可用的格式、单文件与总量设上限；工作区内容本就是令牌化视图，
 * 登记前另由执行器做 Office 外取引用复核（verifyOfficeArtifact），不过关的文件不登记并在时间线说明。
 *
 * 落盘加密（审计 S3 第 2 步）：工作区文件在盘上是 KWE1 分块密文——给出区编解码器时按它解封后再算摘要、登记明文（sha256 按明文，
 * 与块存储一致）；比对“是否改动”仍用盘上的大小与修改时间。严格形态（给出编解码器）下终态的非空明文与非分块格式不登记（外部写入或伪造，
 * 记 unreadable）；运行开始的快照对存量明文仍按明文算摘要（只用于比对：宿主在引擎打开时才迁移存量明文，迁移后内容未变的文件不得
 * 被当作本次运行的改动——复核 S3B-A05 / B-12）。单文件上限先按盘上长度预判，解封后再按明文长度判断。
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isChunkedHeader, isSealed, type ZoneCodec } from "@zr-legal/at-rest";

export const WORKSPACE_ARTIFACT_EXT = /\.(md|txt|csv|json|docx|xlsx|pptx|html)$/i;
/** Agent 指令类文件（ZP-18 拒绝加载的持久化注入载体）：不是律师交付件，不登记为成果，只在时间线列出。 */
export const INSTRUCTION_FILE = /(^|\/)(agents|agent|claude|kimi|gemini)\.md$/i;

export const WORKSPACE_ARTIFACT_LIMITS = { maxFiles: 20, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024, maxDepth: 6 };

export interface WorkspaceEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export type WorkspaceSnapshot = Map<string, WorkspaceEntry>;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** 读出工作区文件的明文（有编解码器时只认分块密文；legacyPlain：存量明文按原样返回，只用于快照比对）。 */
function readPlain(path: string, codec: Pick<ZoneCodec, "open"> | null, legacyPlain = false): Buffer | null {
  const disk = readFileSync(path);
  if (!codec) return disk;
  if (isSealed(disk)) return isChunkedHeader(disk) ? codec.open(disk) : null;
  return disk.length === 0 || legacyPlain ? disk : null;
}

/** 列出工作区内的常规文件（跳过隐藏目录与引擎内部目录；不跟随链接）。 */
function walk(root: string, dir: string, depth: number, out: string[]): void {
  if (depth > WORKSPACE_ARTIFACT_LIMITS.maxDepth) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const p = join(dir, n);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(root, p, depth + 1, out);
    else if (st.isFile()) out.push(p);
  }
}

export function snapshotWorkspace(root: string, codec: Pick<ZoneCodec, "open"> | null = null): WorkspaceSnapshot {
  const snap: WorkspaceSnapshot = new Map();
  const files: string[] = [];
  walk(root, root, 0, files);
  for (const f of files) {
    try {
      const st = lstatSync(f);
      if (!st.isFile() || st.size > WORKSPACE_ARTIFACT_LIMITS.maxFileBytes) {
        snap.set(relative(root, f), { size: st.size, mtimeMs: st.mtimeMs, sha256: "" });
        continue;
      }
      let plain: Buffer | null = null;
      try {
        plain = readPlain(f, codec, true);
      } catch {
        plain = null; // 解不开：快照记空摘要（终态若仍解不开即记 unreadable）
      }
      snap.set(relative(root, f), { size: st.size, mtimeMs: st.mtimeMs, sha256: plain ? sha(plain) : "" });
    } catch {
      // 读取失败的文件不入快照（终态时若仍在，按新增处理）
    }
  }
  return snap;
}

export interface WorkspaceArtifact {
  /** 工作区内相对路径（正斜杠）。 */
  path: string;
  bytes: Buffer;
  sha256: string;
  status: "added" | "modified";
}

export interface WorkspaceDiff {
  artifacts: WorkspaceArtifact[];
  /** 未收的文件与原因（格式不支持、超限）：如实交给时间线。 */
  skipped: { path: string; reason: "format" | "too_large" | "limit" | "instructions" | "unreadable" }[];
}

export function diffWorkspace(root: string, before: WorkspaceSnapshot, codec: Pick<ZoneCodec, "open"> | null = null): WorkspaceDiff {
  const after: string[] = [];
  walk(root, root, 0, after);
  const artifacts: WorkspaceArtifact[] = [];
  const skipped: WorkspaceDiff["skipped"] = [];
  let total = 0;
  for (const f of after.sort()) {
    const rel = relative(root, f);
    const path = rel.split(sep).join("/");
    let st;
    try {
      st = lstatSync(f);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const prev = before.get(rel);
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
    if (INSTRUCTION_FILE.test(path)) {
      skipped.push({ path, reason: "instructions" });
      continue;
    }
    if (!WORKSPACE_ARTIFACT_EXT.test(f)) {
      skipped.push({ path, reason: "format" });
      continue;
    }
    if (st.size > WORKSPACE_ARTIFACT_LIMITS.maxFileBytes) {
      skipped.push({ path, reason: "too_large" });
      continue;
    }
    let bytes: Buffer | null;
    try {
      bytes = readPlain(f, codec);
    } catch {
      bytes = null;
    }
    if (!bytes) {
      // 解不开（损坏、用错密钥）或严格形态下的外部明文：不登记，如实交给时间线
      skipped.push({ path, reason: "unreadable" });
      continue;
    }
    if (bytes.length > WORKSPACE_ARTIFACT_LIMITS.maxFileBytes) {
      skipped.push({ path, reason: "too_large" });
      continue;
    }
    const digest = sha(bytes);
    if (prev && prev.sha256 === digest) continue;
    if (artifacts.length >= WORKSPACE_ARTIFACT_LIMITS.maxFiles || total + bytes.length > WORKSPACE_ARTIFACT_LIMITS.maxTotalBytes) {
      skipped.push({ path, reason: "limit" });
      continue;
    }
    total += bytes.length;
    artifacts.push({ path, bytes, sha256: digest, status: prev ? "modified" : "added" });
  }
  return { artifacts, skipped };
}
