/**
 * 签名账外送（v9.3 第 16 批复核 RB16A-01 余项）：把签名账按批写到对象存储（生产为开了对象锁 / WORM 的桶，与签名区不同信任域），
 * 作为截尾与整本删除的**外部锚点**——启动时比对：本机账本的末行序号比已外送的小，或同一序号的行内容不同，即拒绝启动。
 *
 * - 对象键 `<前缀>/<起始序号 12 位>-<末尾序号 12 位>.jsonl`，内容为原样的账本行（不含文档内容，见 ledger.ts）；
 * - 每批至多 500 行、至少每 `intervalMs` 外送一次；外送失败的行留在内存里下次再送；积压超过 `maxPending` 行即停签（失败关闭：没有外部锚点就不签）；
 * - 核对只读对象键名与最后一批的内容（不全量下载）。
 */
import type { BlobStore } from "@zr-legal/blob-store";
import { verifySignerLedger, type SignerLedgerRecord } from "./ledger.ts";

const KEY_RE = /^(\d{12})-(\d{12})\.jsonl$/;
const pad = (n: number) => String(n).padStart(12, "0");

/** 启动核对：本机账本（全文）须以已外送的全部行为前缀。返回已外送的末行序号。 */
export async function checkLedgerAgainstArchive(ledgerText: string, archive: BlobStore, prefix = "signer-ledger"): Promise<{ ok: true; archivedSeq: number } | { ok: false; reason: string }> {
  const v = verifySignerLedger(ledgerText);
  if (!v.ok) return { ok: false, reason: `本机签名账核验不通过（第 ${v.line} 行）` };
  const objs = (await archive.list(`${prefix}/`))
    .map((o) => ({ key: o.key, m: KEY_RE.exec(o.key.slice(prefix.length + 1)) }))
    .filter((x): x is { key: string; m: RegExpExecArray } => !!x.m)
    .sort((a, b) => Number(a.m[2]) - Number(b.m[2]));
  if (objs.length === 0) return { ok: true, archivedSeq: 0 };
  const last = objs[objs.length - 1]!;
  const archivedSeq = Number(last.m[2]);
  if (v.seq < archivedSeq) return { ok: false, reason: `本机签名账只到第 ${v.seq} 行，已外送到第 ${archivedSeq} 行：账本被截尾或换成了旧副本` };
  // 最后一批逐行比对（同一序号必须是同一行）
  const body = await archive.get(last.key);
  if (!body) return { ok: false, reason: "外送的最后一批读不出" };
  const local = new Map(ledgerText.split("\n").filter(Boolean).map((l) => [(JSON.parse(l) as SignerLedgerRecord).seq, l]));
  for (const line of body.toString("utf8").split("\n").filter(Boolean)) {
    const seq = (JSON.parse(line) as SignerLedgerRecord).seq;
    if (local.get(seq) !== line) return { ok: false, reason: `第 ${seq} 行与已外送的不同：账本被改过` };
  }
  return { ok: true, archivedSeq };
}

export interface LedgerArchiver {
  /** 记账成功后交给外送（原样的行）。 */
  push(line: string): void;
  /** 积压过多（外送一直失败）：签名服务据此停签。 */
  blocked(): boolean;
  flush(): Promise<void>;
  stats(): { pending: number; archived_seq: number; failures: number };
  stop(): void;
}

export function startLedgerArchiver(o: { archive: BlobStore; prefix?: string; archivedSeq: number; intervalMs?: number; maxPending?: number }): LedgerArchiver {
  const prefix = o.prefix ?? "signer-ledger";
  const maxPending = o.maxPending ?? 100_000;
  const pending: string[] = [];
  let archivedSeq = o.archivedSeq;
  let failures = 0;
  let running: Promise<void> | null = null;
  const flushOnce = async () => {
    while (pending.length) {
      const batch = pending.slice(0, 500);
      const first = (JSON.parse(batch[0]!) as SignerLedgerRecord).seq;
      const last = (JSON.parse(batch[batch.length - 1]!) as SignerLedgerRecord).seq;
      try {
        await o.archive.put(`${prefix}/${pad(first)}-${pad(last)}.jsonl`, Buffer.from(`${batch.join("\n")}\n`, "utf8"));
      } catch {
        failures += 1;
        return;
      }
      pending.splice(0, batch.length);
      archivedSeq = last;
    }
  };
  const flush = () => {
    if (!running) running = flushOnce().finally(() => (running = null));
    return running;
  };
  const timer = setInterval(() => void flush(), o.intervalMs ?? 60_000);
  timer.unref();
  return {
    push(line) {
      pending.push(line);
      if (pending.length >= 500) void flush();
    },
    blocked: () => pending.length >= maxPending,
    flush,
    stats: () => ({ pending: pending.length, archived_seq: archivedSeq, failures }),
    stop: () => clearInterval(timer),
  };
}
