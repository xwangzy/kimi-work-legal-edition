/**
 * 运营审计流水的存储（v9.2 §5.1 S14；格式与核验在 @zr-legal/firm-trust audit-chain.ts）。
 *
 * - 每租户一条哈希链；只追加，不改写、不删除（v0 不做保留期清理——Y2 §3.14 要求 ≥ 6 个月，建议 1 年）；
 * - **写入侧与读取侧同一套规则**（复核 S9A-01）：租户与动作代码不合规即拒绝写入；结果代码规范化（截掉拼接的动态后缀）；
 *   组好的记录先过 `validAuditRecord` 再落盘——请求方能控制的文字进不了流水，一条记录也不会让重启验链失败；
 * - 文件形态：JSON Lines，每条写入后 fsync；启动时逐租户验链，链断即拒绝启动（不能在一条坏链后面继续追加）；
 *   最后一行写到一半（掉电、磁盘满）**截断到上一个换行**再追加（复核 S9A-02：只在内存里丢弃，下一条会粘在半行后面）；
 * - 写失败（含 fsync 失败）截断回写入前的长度，文件与内存一致（“没写成就等于没发生”）；截断也失败才停止追加直到重启；
 * - 生产形态按 Y2 §4.2 写入 OBS WORM（合规保留模式），本文件只是单实例试点的落点。
 */
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { AUDIT_CODE_RE, AUDIT_GENESIS, AUDIT_ID_RE, auditHash, normalizeAuditResult, validAuditDetail, validAuditRecord, verifyAuditChain, type CpAuditActor, type CpAuditRecord } from "@zr-legal/firm-trust";

export interface AuditEntry {
  tid: string;
  actor: CpAuditActor;
  action: string;
  target: string | null;
  result: string;
  detail?: Record<string, number>;
}

export interface AuditLog {
  append(e: AuditEntry, at: string): CpAuditRecord;
  /** 序号大于 after 的记录（至多 limit 条）。 */
  list(tid: string, after: number, limit: number): CpAuditRecord[];
  head(tid: string): { seq: number; hash: string };
  close(): void;
}

const sanitizeId = (s: string): string => (AUDIT_ID_RE.test(s) ? s : `invalid:${s.length}`);

/** 文件写入（测试注入写失败用）。 */
export interface AuditFs {
  writeSync(fd: number, data: string): number;
  fsyncSync(fd: number): void;
}

/** 内存流水；给出 file 即同时追加写入该文件（启动时读回并验链）。 */
export function createAuditLog(o: { file?: string; fs?: AuditFs } = {}): AuditLog {
  const io: AuditFs = o.fs ?? { writeSync: (fd, d) => writeSync(fd, d), fsyncSync };
  const chains = new Map<string, CpAuditRecord[]>();
  let fd: number | null = null;
  // 写失败且截断也失败：文件末尾可能留着半行，此后写操作一律失败（重启时截断半行）
  let broken = false;
  if (o.file) {
    if (existsSync(o.file)) {
      const buf = readFileSync(o.file);
      const completeLen = buf.lastIndexOf(0x0a) + 1;
      const lines = buf.subarray(0, completeLen).toString("utf8").split("\n").slice(0, -1);
      for (const [i, line] of lines.entries()) {
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
      // 末尾半行（掉电、磁盘满）：截断到上一个换行，之后的追加从完整行之后开始
      if (completeLen < buf.byteLength) {
        const t = openSync(o.file, "r+");
        try {
          ftruncateSync(t, completeLen);
          fsyncSync(t);
        } finally {
          closeSync(t);
        }
      }
    } else mkdirSync(dirname(o.file), { recursive: true });
    fd = openSync(o.file, "a", 0o600);
  }
  return {
    append(e, at) {
      if (broken) throw new Error("审计流水写盘曾失败且无法恢复：重启前不再追加");
      // 写入侧校验（复核 S9A-01）：租户与动作代码不合规即拒绝（调用方让操作失败），结果代码规范化
      if (!AUDIT_ID_RE.test(e.tid)) throw new Error("审计记录的租户编号不合规");
      if (!AUDIT_CODE_RE.test(e.action)) throw new Error("审计记录的动作代码不合规");
      const chain = chains.get(e.tid) ?? [];
      const prev = chain.at(-1);
      const actor: CpAuditActor = { kind: e.actor.kind, id: sanitizeId(e.actor.id), ...(e.actor.fp && /^[A-Za-z0-9_-]{8,64}$/.test(e.actor.fp) ? { fp: e.actor.fp } : {}) };
      const base: Omit<CpAuditRecord, "hash"> = {
        tid: e.tid,
        seq: (prev?.seq ?? 0) + 1,
        at,
        actor,
        action: e.action,
        target: e.target === null ? null : sanitizeId(e.target),
        result: normalizeAuditResult(e.result),
        prev: prev?.hash ?? AUDIT_GENESIS,
        ...(e.detail !== undefined && validAuditDetail(e.detail) ? { detail: e.detail } : {}),
      };
      const rec: CpAuditRecord = { ...base, hash: auditHash(base) };
      if (!validAuditRecord(rec)) throw new Error("审计记录不合规：未写入");
      if (fd !== null) {
        // 先写盘再进内存；写失败（含 fsync 失败）截断回写入前的长度——文件与内存一致
        const before = fstatSync(fd).size;
        try {
          io.writeSync(fd, `${JSON.stringify(rec)}\n`);
          io.fsyncSync(fd);
        } catch (err) {
          try {
            ftruncateSync(fd, before);
            fsyncSync(fd);
          } catch {
            broken = true;
          }
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
