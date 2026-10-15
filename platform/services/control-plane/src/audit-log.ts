/**
 * 运营审计流水的存储（v9.2 §5.1 S14；格式与核验在 @zr-legal/firm-trust audit-chain.ts）。
 *
 * - 每租户一条哈希链；只追加，不改写、不删除（v0 不做保留期清理——Y2 §3.14 要求 ≥ 6 个月，建议 1 年）；
 * - 文件形态：JSON Lines，每条写入后 fsync；启动读回时逐租户验链，**链断即拒绝启动**（不能在一条坏链后面继续追加，
 *   否则律所侧再也分不清哪些是原记录）；最后一行写到一半（掉电）按未写成丢弃；
 * - 生产形态按 Y2 §4.2 写入 OBS WORM（合规保留模式），本文件只是单实例试点的落点。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { AUDIT_GENESIS, auditHash, verifyAuditChain, type CpAuditActor, type CpAuditRecord } from "@zr-legal/firm-trust";

export interface AuditEntry {
  tid: string;
  actor: CpAuditActor;
  action: string;
  target: string | null;
  result: string;
}

export interface AuditLog {
  append(e: AuditEntry, at: string): CpAuditRecord;
  /** 序号大于 after 的记录（至多 limit 条）。 */
  list(tid: string, after: number, limit: number): CpAuditRecord[];
  head(tid: string): { seq: number; hash: string };
  close(): void;
}

const sanitizeId = (s: string): string => (/^[A-Za-z0-9_.:-]{1,200}$/.test(s) ? s : `invalid:${s.length}`);

/** 内存流水；给出 file 即同时追加写入该文件（启动时读回并验链）。 */
export function createAuditLog(o: { file?: string } = {}): AuditLog {
  const chains = new Map<string, CpAuditRecord[]>();
  let fd: number | null = null;
  // 写盘失败过一次即不再追加（失败的那行可能只写了一半，后面接着写会粘在半行上）：此后写操作一律失败，重启时丢弃半行
  let broken = false;
  if (o.file) {
    if (existsSync(o.file)) {
      const lines = readFileSync(o.file, "utf8").split("\n");
      // 最后一行没有换行结尾 = 写到一半（掉电）：丢弃
      const complete = lines.slice(0, -1);
      for (const [i, line] of complete.entries()) {
        if (!line) continue;
        let r: CpAuditRecord;
        try {
          r = JSON.parse(line) as CpAuditRecord;
        } catch {
          throw new Error(`审计流水第 ${i + 1} 行不是 JSON：拒绝启动`);
        }
        const chain = chains.get(r.tid) ?? [];
        const prev = chain.at(-1);
        const v = verifyAuditChain([r], String(r.tid), prev ? { seq: prev.seq, hash: prev.hash } : { seq: 0, hash: AUDIT_GENESIS });
        if (!v.ok) throw new Error(`审计流水第 ${i + 1} 行未通过验链（${v.reason}）：拒绝启动`);
        chain.push(r);
        chains.set(r.tid, chain);
      }
    } else mkdirSync(dirname(o.file), { recursive: true });
    fd = openSync(o.file, "a", 0o600);
  }
  return {
    append(e, at) {
      const chain = chains.get(e.tid) ?? [];
      const prev = chain.at(-1);
      const actor: CpAuditActor = { kind: e.actor.kind, id: sanitizeId(e.actor.id), ...(e.actor.fp ? { fp: e.actor.fp } : {}) };
      const base = { tid: e.tid, seq: (prev?.seq ?? 0) + 1, at, actor, action: e.action, target: e.target === null ? null : sanitizeId(e.target), result: e.result, prev: prev?.hash ?? AUDIT_GENESIS };
      const rec: CpAuditRecord = { ...base, hash: auditHash(base) };
      if (broken) throw new Error("审计流水写盘曾失败：重启前不再追加");
      if (fd !== null) {
        // 先写盘再进内存：写盘失败 = 没有发生（调用方据此让整个操作失败）
        try {
          writeSync(fd, `${JSON.stringify(rec)}\n`);
          fsyncSync(fd);
        } catch (err) {
          broken = true;
          throw err;
        }
      }
      chain.push(rec);
      chains.set(e.tid, chain);
      return rec;
    },
    list(tid, after, limit) {
      const chain = chains.get(tid) ?? [];
      // 序号从 1 连续：按下标直接切
      return chain.slice(Math.max(0, after), Math.max(0, after) + limit);
    },
    head(tid) {
      const last = chains.get(tid)?.at(-1);
      return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: AUDIT_GENESIS };
    },
    close() {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}
