/**
 * 第 72 批（A1 S3；按独立安全审查 09 P2-6 改）：出站闸门 Node（约 100 MB）的摘要**每次拉起闸门前都完整核验**，不按文件元数据免算——
 * Windows 按用户安装时安装目录本人可写、修改时刻 / ChangeTime 可伪造，按元数据免算会把被替换的窗口从“每次拉起”扩大到整个应用会话。
 *
 * 省时间的办法改为：内核启动一开始就在**工作线程**里开始算（与开库、迁移、法规库、方法模板物化这些主线程上的同步工作真正并行——
 * 主线程上的流式计算在这些同步阶段里拿不到事件循环，几乎不前进），第一次拉起闸门时只等这份结果；核验通过后同步走到 spawn，中间不再有异步步骤。
 * - 预先算的只用一次，只认同一个文件，且算完不超过 EARLY_DIGEST_MAX_AGE_MS（闸门迟迟没拉起——开发形态按需才拉——就现算）；
 * - 之后每次拉起（闸门崩溃后重拉等）照旧现算；摘要不符照旧拒绝拉起；
 * - 工作线程起不来（极少：受限环境）就退回主线程流式计算，结果相同。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Worker } from "node:worker_threads";

/** 预先算出的摘要算完之后多久内可以直接用（毫秒）。 */
export const EARLY_DIGEST_MAX_AGE_MS = 30_000;

export interface EarlyDigest {
  file: string;
  startedAt: number;
  /** digest = null：读不了；doneAt = 主线程拿到结果的时刻；finishedAt = 工作线程算完的时刻（用例据此核“与主线程并行”）。 */
  result: Promise<{ digest: string | null; doneAt: number; finishedAt: number; where: "worker" | "main" }>;
  taken: boolean;
}

/** 主线程流式计算（不阻塞事件循环，但要事件循环空出来才前进）。读不了按 null。 */
export async function sha256OfFileStream(file: string): Promise<string | null> {
  try {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) h.update(chunk as Buffer);
    return h.digest("hex");
  } catch {
    return null;
  }
}

// 工作线程里只做一件事：流式读这个文件、算 SHA-256、回报十六进制摘要与算完的时刻（不碰别的文件、不回传内容）
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
(async () => {
  try {
    const h = createHash("sha256");
    for await (const c of createReadStream(workerData.file, { highWaterMark: 1 << 20 })) h.update(c);
    parentPort.postMessage({ digest: h.digest("hex"), finishedAt: Date.now() });
  } catch {
    parentPort.postMessage({ digest: null, finishedAt: Date.now() });
  }
})();
`;

/** 在工作线程里整份算；工作线程起不来或中途异常退出时退回主线程流式计算。 */
export function sha256OfFileInWorker(file: string): Promise<{ digest: string | null; finishedAt: number; where: "worker" | "main" }> {
  const fallback = async () => {
    const digest = await sha256OfFileStream(file);
    return { digest, finishedAt: Date.now(), where: "main" as const };
  };
  let w: Worker;
  try {
    w = new Worker(WORKER_SRC, { eval: true, workerData: { file } });
  } catch {
    return fallback();
  }
  w.unref();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: Promise<{ digest: string | null; finishedAt: number; where: "worker" | "main" }> | { digest: string | null; finishedAt: number; where: "worker" | "main" }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    w.once("message", (m: { digest?: unknown; finishedAt?: unknown }) => {
      const digest = typeof m?.digest === "string" && /^[0-9a-f]{64}$/.test(m.digest) ? m.digest : null;
      done({ digest, finishedAt: typeof m?.finishedAt === "number" ? m.finishedAt : Date.now(), where: "worker" });
      void w.terminate().catch(() => {});
    });
    w.once("error", () => done(fallback()));
    w.once("exit", () => done(fallback()));
  });
}

/** 内核启动一开始调用：开始在工作线程里算闸门 Node 的摘要（没有文件 = null，不预算）。 */
export function startEarlyDigest(file: string | null, hash: (f: string) => Promise<{ digest: string | null; finishedAt: number; where: "worker" | "main" }> = sha256OfFileInWorker): EarlyDigest | null {
  if (!file) return null;
  const startedAt = Date.now();
  const result = hash(file).then((r) => ({ ...r, doneAt: Date.now() }));
  // 没人等时不要成为未处理的拒绝（hash 本身不抛，这里只是兜底）
  result.catch(() => {});
  return { file, startedAt, result, taken: false };
}

/**
 * 拉起闸门前取预先算的那一份（只给一次；文件不同、已取过返回 null——调用方现算）。
 * fresh = 算完到此刻不超过 maxAgeMs；不新鲜的调用方照样现算。
 */
export async function takeEarlyDigest(early: EarlyDigest | null | undefined, file: string, maxAgeMs = EARLY_DIGEST_MAX_AGE_MS, now: () => number = Date.now): Promise<{ digest: string | null; fresh: boolean } | null> {
  if (!early || early.taken || early.file !== file) return null;
  early.taken = true;
  const r = await early.result;
  return { digest: r.digest, fresh: now() - r.doneAt <= maxAgeMs };
}
