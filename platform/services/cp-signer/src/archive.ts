/**
 * 签名账外送（v9.3 第 16 批复核 RB16A-01 余项；余项续复核 RC-A-01/02/06/07 处置）：把签名账按批写到对象存储
 * （生产为开了版本控制与对象锁的桶，与签名区不同信任域），作为截尾、整本删除与改行的**外部锚点**。
 *
 * - 对象键 `<前缀>/<起始序号 12 位>-<末尾序号 12 位>-<起始行 prev 前 16 位>-<末行哈希前 16 位>.jsonl`，内容为原样的账本行（不含文档内容，见 ledger.ts）。
 *   键名带首尾哈希：只读键名就能核对“批与批首尾相接”，并把每一批的末行与本机账本对上（不必全量下载）；
 * - 只用条件写（同名已存在即不写，S3 `If-None-Match: *`），不覆盖；同一批重试时键名不变，已存在且内容相同即视为成功；
 * - 外送器**从本机账本文件读**待外送的行（不在内存里攒）：重启后自动补送上次没送出去的尾巴，积压多少都不占内存；
 *   每批至多 500 行、至少每 `intervalMs` 外送一次；失败按指数退避重试；积压超过 `maxPending` 行或发现外送对象被换即停签（失败关闭）。
 *
 * 前提（部署文档写明，启动时核对桶配置）：外送桶开版本控制与对象锁、没有作用于外送前缀的到期规则；外送凭据只许写、读、列举，不许删除与改生命周期。
 * 在这个前提下，删掉或覆盖已外送的对象会留下删除标记或多个版本，启动核对据此拒绝启动。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { BlobStore } from "@zr-legal/blob-store";
import { verifySignerLedger, type SignerLedgerRecord } from "./ledger.ts";

const KEY_RE = /^(\d{12})-(\d{12})-([0-9a-f]{16})-([0-9a-f]{16})\.jsonl$/;
const GENESIS = "0".repeat(64);
const pad = (n: number) => String(n).padStart(12, "0");
const lineHash = (line: string) => createHash("sha256").update(line).digest("hex");
const BATCH = 500;

export function archiveKey(prefix: string, first: SignerLedgerRecord, last: number, lastHash: string): string {
  return `${prefix}/${pad(first.seq)}-${pad(last)}-${first.prev.slice(0, 16)}-${lastHash.slice(0, 16)}.jsonl`;
}

export type ArchiveCheck = { ok: true; archivedSeq: number; archivedHash: string; archivedOffset: number; localSeq: number } | { ok: false; reason: string };

/**
 * 启动核对：本机账本（全文）须以已外送的全部行为前缀。
 * - 版本化存储：外送前缀下有删除标记或同一键有多个版本，即“外送被动过”；
 * - 前缀下有认不出的对象、批与批不首尾相接、某批末行与本机同序号行哈希不同，均拒绝；最后一批逐行比对。
 * 返回已外送的末行序号、哈希与它在本机账本里的字节位置（外送器从这里接着读）。
 */
export async function checkLedgerAgainstArchive(ledgerText: string, archive: BlobStore, prefix = "signer-ledger"): Promise<ArchiveCheck> {
  const v = verifySignerLedger(ledgerText);
  if (!v.ok) return { ok: false, reason: `本机签名账核验不通过（第 ${v.line} 行）` };
  let names: string[];
  if (archive.listVersions) {
    const vers = await archive.listVersions(`${prefix}/`);
    if (vers.some((x) => x.deleteMarker)) return { ok: false, reason: "外送对象被删除过（桶里有删除标记）" };
    const seen = new Set<string>();
    for (const x of vers) {
      if (seen.has(x.key)) return { ok: false, reason: `外送对象被覆盖过（${x.key.slice(prefix.length + 1)} 有多个版本）` };
      seen.add(x.key);
    }
    names = [...seen];
  } else {
    names = (await archive.list(`${prefix}/`)).map((o) => o.key);
  }
  const batches: { key: string; from: number; to: number; prev16: string; last16: string }[] = [];
  for (const key of names) {
    const m = KEY_RE.exec(key.slice(prefix.length + 1));
    if (!m) return { ok: false, reason: `外送位置里有认不出的对象（${key.slice(0, 80)}）` };
    batches.push({ key, from: Number(m[1]), to: Number(m[2]), prev16: m[3]!, last16: m[4]! });
  }
  batches.sort((a, b) => a.from - b.from);
  const lines = ledgerText.split("\n").filter(Boolean);
  if (batches.length === 0) return { ok: true, archivedSeq: 0, archivedHash: GENESIS, archivedOffset: 0, localSeq: v.seq };
  // 批与批首尾相接：序号连续、每批起始行的 prev 等于上一批末行的哈希
  let expectSeq = 0;
  let expectHash16 = GENESIS.slice(0, 16);
  for (const b of batches) {
    if (b.from !== expectSeq + 1 || b.to < b.from) return { ok: false, reason: `外送的批次不连续（第 ${expectSeq + 1} 行起缺失或重叠）` };
    if (b.prev16 !== expectHash16) return { ok: false, reason: `外送的第 ${b.from} 行起这一批与上一批接不上：外送对象被换过` };
    expectSeq = b.to;
    expectHash16 = b.last16;
  }
  const archivedSeq = expectSeq;
  if (v.seq < archivedSeq) return { ok: false, reason: `本机签名账只到第 ${v.seq} 行，已外送到第 ${archivedSeq} 行：账本被截尾或换成了旧副本` };
  // 每批末行与本机同序号行对上（本机账本自身有哈希链：末行对上即此前各行都对上）
  for (const b of batches) {
    if (lineHash(lines[b.to - 1]!).slice(0, 16) !== b.last16) return { ok: false, reason: `第 ${b.to} 行与已外送的不同：账本被改过` };
  }
  // 最后一批逐行比对（同一序号必须是同一行）
  const last = batches[batches.length - 1]!;
  const body = await archive.get(last.key);
  if (!body) return { ok: false, reason: "外送的最后一批读不出" };
  const got = body.toString("utf8").split("\n").filter(Boolean);
  if (got.length !== last.to - last.from + 1) return { ok: false, reason: "外送的最后一批行数与键名不符" };
  for (let i = 0; i < got.length; i++) {
    if (lines[last.from - 1 + i] !== got[i]) return { ok: false, reason: `第 ${last.from + i} 行与已外送的不同：账本被改过` };
  }
  let offset = 0;
  for (let i = 0; i < archivedSeq; i++) offset += Buffer.byteLength(lines[i]!, "utf8") + 1;
  return { ok: true, archivedSeq, archivedHash: lineHash(lines[archivedSeq - 1]!), archivedOffset: offset, localSeq: v.seq };
}

export interface LedgerArchiver {
  /** 记账成功后通知外送（原样的行；外送器只取它的序号，行本身从账本文件读）。 */
  push(line: string): void;
  /** 积压过多（外送一直失败）或外送对象被换：签名服务据此停签。 */
  blocked(): boolean;
  flush(): Promise<void>;
  stats(): { pending: number; archived_seq: number; failures: number; conflict: boolean };
  /** 停止定时外送，并在限时内把尾巴送完（发布、停机时调用；复核 RC-A-02）。 */
  stop(timeoutMs?: number): Promise<void>;
}

export function startLedgerArchiver(o: {
  archive: BlobStore;
  /** 本机签名账文件：外送器从这里读待外送的行。 */
  ledgerFile: string;
  prefix?: string;
  /** 已外送到哪里（checkLedgerAgainstArchive 的结果）；缺省为空账本。 */
  start?: { seq: number; hash: string; offset: number };
  /** 本机账本当前末行序号（启动时有未外送的尾巴即立刻补送）。 */
  headSeq?: number;
  intervalMs?: number;
  maxPending?: number;
  now?: () => number;
}): LedgerArchiver {
  const prefix = o.prefix ?? "signer-ledger";
  const maxPending = o.maxPending ?? 100_000;
  const now = o.now ?? Date.now;
  let archivedSeq = o.start?.seq ?? 0;
  let archivedHash = o.start?.hash ?? GENESIS;
  let offset = o.start?.offset ?? 0;
  let headSeq = Math.max(o.headSeq ?? archivedSeq, archivedSeq);
  let failures = 0;
  let streak = 0;
  let nextTry = 0;
  let conflict = false;
  // 同一批重试时键名与内容都不变（回复丢了也不会写出重叠的批）
  let inflight: { key: string; body: Buffer; last: number; hash: string; end: number } | null = null;
  let running: Promise<void> | null = null;

  const readBatch = (): typeof inflight => {
    if (!existsSync(o.ledgerFile)) return null;
    const size = statSync(o.ledgerFile).size;
    if (size <= offset) return null;
    const fd = openSync(o.ledgerFile, "r");
    let text: string;
    try {
      const want = Math.min(size - offset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const n = readSync(fd, buf, got, want - got, offset + got);
        if (n <= 0) break;
        got += n;
      }
      text = buf.subarray(0, got).toString("utf8");
    } finally {
      closeSync(fd);
    }
    // 只取完整的行（末尾没有换行的是正在写的半行）
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    const lines = complete.split("\n").filter(Boolean).slice(0, BATCH);
    if (lines.length === 0) return null;
    const first = JSON.parse(lines[0]!) as SignerLedgerRecord;
    if (first.seq !== archivedSeq + 1 || first.prev !== archivedHash) {
      // 本机账本在外送位置之后被换过：不外送、停签
      conflict = true;
      return null;
    }
    const lastLine = lines[lines.length - 1]!;
    const last = (JSON.parse(lastLine) as SignerLedgerRecord).seq;
    const hash = lineHash(lastLine);
    const body = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    return { key: archiveKey(prefix, first, last, hash), body, last, hash, end: offset + body.length };
  };

  const flushOnce = async () => {
    while (!conflict && archivedSeq < headSeq) {
      if (!inflight) inflight = readBatch();
      if (!inflight) return;
      try {
        const res = o.archive.putIfAbsent ? await o.archive.putIfAbsent(inflight.key, inflight.body) : (await o.archive.put(inflight.key, inflight.body), "created" as const);
        if (res === "exists") {
          const cur = await o.archive.get(inflight.key);
          if (!cur || !cur.equals(inflight.body)) {
            // 同名对象内容不同：外送位置被人写过，停签待查
            conflict = true;
            failures += 1;
            return;
          }
        }
      } catch {
        failures += 1;
        streak += 1;
        nextTry = now() + Math.min(60_000, 1_000 * 2 ** Math.min(streak, 6));
        return;
      }
      streak = 0;
      archivedSeq = inflight.last;
      archivedHash = inflight.hash;
      offset = inflight.end;
      inflight = null;
    }
  };
  const flush = () => {
    if (!running) running = flushOnce().finally(() => (running = null));
    return running;
  };
  const timer = setInterval(() => {
    if (now() >= nextTry) void flush();
  }, o.intervalMs ?? 60_000);
  timer.unref();
  if (headSeq > archivedSeq) void flush();
  return {
    push(line) {
      const seq = (JSON.parse(line) as SignerLedgerRecord).seq;
      if (seq > headSeq) headSeq = seq;
      // 攒够一批即送；失败退避期间不每行都重试（复核 RC-A-06）
      if (headSeq - archivedSeq >= BATCH && now() >= nextTry) void flush();
    },
    blocked: () => conflict || headSeq - archivedSeq >= maxPending,
    flush,
    stats: () => ({ pending: headSeq - archivedSeq, archived_seq: archivedSeq, failures, conflict }),
    async stop(timeoutMs = 5_000) {
      clearInterval(timer);
      if (headSeq <= archivedSeq || conflict) return;
      let t: NodeJS.Timeout | undefined;
      await Promise.race([flush(), new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
      if (t) clearTimeout(t);
    },
  };
}
