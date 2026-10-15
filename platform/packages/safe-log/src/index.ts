/**
 * 统一脱敏日志器（v9.2 §3.6、调研 Y5 §5.2 / P1-1）。
 *
 * - 接口只有 `slog.event(事件码, 字段)`：事件码与字段类型取自登记表（events.ts），未登记的事件码、字段或不合类型的值一律丢弃并计一条
 *   SAFE_LOG_REJECTED（只记原因，不记被拒的值）；没有自由文本、异常消息、文件名、路径、URL、代号的通道。
 * - 每个进程一个实例（`slog`）。内核把它接到本机日志文件（FileSink，单写）；子进程（闸门、Agent 宿主、W、解析进程）接到 stderr，
 *   内核以 `relayChildStderr` 逐行解析、按登记表重新核验后写入，进程名由内核标注；不是日志器 JSON 行的 stderr 只计数、不保存。
 * - 本机记录编号（事项、任务、尝试）写盘前按本机随机盐 HMAC 取 12 位：日志与诊断包里不能与账本对应。
 * - 日志不含内容，因此不加密；目录位于数据根下（随数据根设非内容索引）。单文件 ≤ 5 MB、保留 14 天且总量 ≤ 50 MB。
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { EVENTS, PROCS, type EventCode, type EventSpec, type FieldKind, type Level, type Proc } from "./events.ts";

export { EVENTS, PROCS, type EventCode, type EventSpec, type FieldKind, type Level, type Proc } from "./events.ts";

const LEVEL_RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
export const LOG_LEVELS = Object.keys(LEVEL_RANK) as Level[];

export type FieldValue = string | number | boolean;
export interface LogRecord {
  /** 秒级 UTC 时间。 */
  t: string;
  lvl: Level;
  code: EventCode;
  proc: Proc;
  f: Record<string, FieldValue>;
}

export type RejectCause = "unknown_code" | "bad_field" | "missing_field" | "bad_value" | "malformed" | "too_long";

const RE: Record<Exclude<FieldKind, readonly string[] | "int" | "ms" | "bool" | "status">, RegExp> = {
  ver: /^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.]{1,20})?$/,
  errname: /^(?:[A-Z][A-Za-z0-9]{0,40}(?:Error|Exception)|Error)$/,
  errcode: /^(?:E[A-Z0-9]{2,20}|ERR_[A-Z0-9_]{1,60}|SQLITE_[A-Z_]{1,40}|[a-z][a-z0-9_]{1,47})$/,
  signal: /^SIG[A-Z0-9]{2,10}$/,
  ident: /^[a-z][a-z0-9_.-]{0,47}$/,
  id: /^[A-Za-z0-9_.:-]{1,128}$/,
};

function checkValue(kind: FieldKind, v: unknown): boolean {
  if (Array.isArray(kind)) return typeof v === "string" && kind.includes(v);
  switch (kind) {
    case "int":
      return typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= 1e15;
    case "ms":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e13;
    case "status":
      return typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599;
    case "bool":
      return typeof v === "boolean";
    default:
      return typeof v === "string" && RE[kind as keyof typeof RE].test(v);
  }
}

/** 按登记表核验；`id` 类字段保留原值（由写盘一侧加盐 hash）。 */
export function validateEvent(code: unknown, fields: unknown): { ok: true; code: EventCode; spec: EventSpec; f: Record<string, FieldValue> } | { ok: false; cause: RejectCause } {
  if (typeof code !== "string" || !Object.hasOwn(EVENTS, code)) return { ok: false, cause: "unknown_code" };
  const spec = (EVENTS as Record<string, EventSpec>)[code]!;
  if (fields !== undefined && (fields === null || typeof fields !== "object" || Array.isArray(fields))) return { ok: false, cause: "malformed" };
  const given = (fields ?? {}) as Record<string, unknown>;
  const decl = new Map<string, { kind: FieldKind; optional: boolean }>();
  for (const [k, kind] of Object.entries(spec.fields)) decl.set(k.replace(/\?$/, ""), { kind, optional: k.endsWith("?") });
  const f: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(given)) {
    const d = decl.get(k);
    if (!d) return { ok: false, cause: "bad_field" };
    if (v === undefined || v === null) {
      if (d.optional) continue;
      return { ok: false, cause: "missing_field" };
    }
    if (!checkValue(d.kind, v)) return { ok: false, cause: "bad_value" };
    f[k] = v as FieldValue;
  }
  for (const [k, d] of decl) if (!d.optional && !(k in f)) return { ok: false, cause: "missing_field" };
  return { ok: true, code: code as EventCode, spec, f };
}

/** 异常只取构造器名与错误码（不取 message、不取栈）；不合类型的值省略。 */
export function errFields(e: unknown): { err_name?: string; err_code?: string } {
  const out: { err_name?: string; err_code?: string } = {};
  if (e && typeof e === "object") {
    const name = (e as { name?: unknown }).name ?? (e as object).constructor?.name;
    const code = (e as { code?: unknown }).code;
    if (typeof name === "string" && RE.errname.test(name)) out.err_name = name;
    if (typeof code === "string" && RE.errcode.test(code)) out.err_code = code;
  }
  return out;
}

export interface Sink {
  write(rec: LogRecord): void;
}

/** 子进程：把核验通过的事件写成 stderr 的一行 JSON（`kwl:1` 标记），由内核重新核验后写盘。 */
export const stderrSink: Sink = {
  write(rec) {
    try {
      process.stderr.write(`${JSON.stringify({ kwl: 1, lvl: rec.lvl, code: rec.code, f: rec.f })}\n`);
    } catch {
      // stderr 已关闭：丢弃
    }
  },
};

export class SafeLog {
  proc: Proc = "kernel";
  private sink: Sink | null = null;
  private level: Level = "info";
  private levelUntil = 0;
  /** 最近的记录（内存，供诊断与测试；未接写盘时也在这里）。 */
  readonly recent: LogRecord[] = [];
  rejected = 0;
  /** 每个事件码每分钟最多写 120 条（复核 S5A-10：防止子进程刷屏挤掉有用记录、撑满日志上限）；超出只计数。 */
  private rate = new Map<string, { windowStart: number; n: number }>();
  dropped = 0;

  event(code: EventCode, fields?: Record<string, FieldValue | undefined>): void {
    this.accept(this.proc, code, fields);
  }

  /** 接收子进程或主进程交来的事件（进程名由接收方标注）；返回是否接受。 */
  ingest(proc: Proc, code: unknown, fields: unknown): boolean {
    return this.accept(proc, code, fields);
  }

  private accept(proc: Proc, code: unknown, fields: unknown): boolean {
    const v = validateEvent(code, fields);
    if (!v.ok) {
      this.rejected++;
      // 只记原因与来源，绝不记被拒的事件码或值
      const r = validateEvent("SAFE_LOG_REJECTED", { cause: v.cause, source: proc });
      if (r.ok) this.emit({ t: now(), lvl: "warn", code: r.code, proc: this.proc, f: r.f });
      return false;
    }
    if (LEVEL_RANK[v.spec.level] > LEVEL_RANK[this.currentLevel()] && this.sink !== stderrSink) return true;
    const key = `${proc}:${v.code}`;
    const t = Date.now();
    const w = this.rate.get(key);
    if (!w || t - w.windowStart > 60_000) this.rate.set(key, { windowStart: t, n: 1 });
    else if (++w.n > 120) {
      this.dropped++;
      return true;
    }
    this.emit({ t: now(), lvl: v.spec.level, code: v.code, proc, f: v.f });
    return true;
  }

  private emit(rec: LogRecord): void {
    this.recent.push(rec);
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 400);
    try {
      this.sink?.write(rec);
    } catch {
      // 写日志失败不影响业务
    }
  }

  currentLevel(): Level {
    if (this.levelUntil && Date.now() > this.levelUntil) {
      this.level = "info";
      this.levelUntil = 0;
    }
    return this.level;
  }

  /** 设备页临时开启 debug（缺省 24 小时后自动回到 info）；字段规则不变。 */
  setLevel(level: Level, ttlMs = 24 * 3600_000): void {
    this.level = level;
    this.levelUntil = level === "info" ? 0 : Date.now() + ttlMs;
    this.event("SAFE_LOG_LEVEL_CHANGED", { level, expires_in_ms: level === "info" ? undefined : ttlMs });
  }

  setSink(sink: Sink | null): void {
    this.sink = sink;
  }

  getSink(): Sink | null {
    return this.sink;
  }

  /** 子进程入口调用：事件经 stderr 交内核。 */
  useStderr(proc: Proc): void {
    this.proc = proc;
    this.sink = stderrSink;
  }
}

/** 本进程唯一实例。 */
export const slog = new SafeLog();

function now(): string {
  return new Date().toISOString().slice(0, 19) + "Z";
}

const MAX_LINE = 4096;

/**
 * 内核侧：逐行读取子进程 stderr。日志器 JSON 行按登记表重新核验后写入（进程名由这里标注）；其余行只计数，进程结束时记一条
 * CHILD_STDERR_UNSTRUCTURED（计数），内容不保存。
 */
export function relayChildStderr(stream: Readable | null | undefined, proc: Proc, log: SafeLog = slog): { unstructured(): number } {
  let buf = "";
  let unstructured = 0;
  let overlong = false;
  const line = (s: string): void => {
    if (!s) return;
    if (s.length > MAX_LINE) {
      unstructured++;
      return;
    }
    let o: unknown;
    try {
      o = JSON.parse(s);
    } catch {
      unstructured++;
      return;
    }
    if (!o || typeof o !== "object" || (o as { kwl?: unknown }).kwl !== 1) {
      unstructured++;
      return;
    }
    log.ingest(proc, (o as { code?: unknown }).code, (o as { f?: unknown }).f);
  };
  stream?.setEncoding?.("utf8");
  stream?.on("data", (chunk: string | Buffer) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const s = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (overlong) {
        overlong = false;
        continue;
      }
      line(s);
    }
    if (buf.length > MAX_LINE) {
      // 超长无换行：丢弃到下一换行，计一次
      unstructured++;
      overlong = true;
      buf = "";
    }
  });
  stream?.on("end", () => {
    if (buf && !overlong) line(buf.replace(/\r$/, ""));
    buf = "";
    if (unstructured > 0) log.ingest("kernel", "CHILD_STDERR_UNSTRUCTURED", { proc, lines: unstructured });
  });
  return { unstructured: () => unstructured };
}

/** 本机随机盐（首次运行生成、0600）；用于把记录编号 hash 成不可对应的 12 位。 */
export function loadOrCreateSalt(file: string): Buffer {
  try {
    const v = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(v)) return Buffer.from(v, "hex");
  } catch {
    // 不存在或不可读：重建
  }
  const fresh = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, fresh.toString("hex"), { mode: 0o600, flag: "wx" });
  } catch {
    try {
      const v = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(v)) return Buffer.from(v, "hex");
    } catch {
      // 落到覆盖
    }
    writeFileSync(file, fresh.toString("hex"), { mode: 0o600 });
  }
  return fresh;
}

export interface FileSinkOptions {
  dir: string;
  salt: Buffer;
  maxFileBytes?: number;
  retainDays?: number;
  maxTotalBytes?: number;
  /** 测试用时钟。 */
  now?: () => number;
}

const hexToLetters = (h: string): string => h.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
const HASHED = /^[a-p]{12}$/;

const FILE_RE = /^kwl-(\d{8})(?:-(\d{1,4}))?\.jsonl$/;

/** 本机日志文件：`kwl-YYYYMMDD[-N].jsonl`（UTC 日期），单文件上限后换下一个序号；保留期与总量上限先到为准。 */
export class FileSink implements Sink {
  private readonly o: Required<Omit<FileSinkOptions, "now">> & { now: () => number };
  private current: { day: string; seq: number; file: string; size: number } | null = null;
  private lastPrune = 0;

  constructor(o: FileSinkOptions) {
    this.o = { maxFileBytes: 5 * 1024 * 1024, retainDays: 14, maxTotalBytes: 50 * 1024 * 1024, now: Date.now, ...o };
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    this.prune();
  }

  /** 12 个 a–p 字母（十六进制换字母表）：不含数字，诊断包的标识符复扫（证件、电话、账号规则）不会误判。 */
  hashId(v: string): string {
    return hexToLetters(createHmac("sha256", this.o.salt).update(v).digest("hex").slice(0, 12));
  }

  write(rec: LogRecord): void {
    const f: Record<string, FieldValue> = {};
    const spec = (EVENTS as Record<string, EventSpec>)[rec.code]!;
    for (const [k, v] of Object.entries(rec.f)) {
      const kind = spec.fields[k] ?? spec.fields[`${k}?`];
      f[k] = kind === "id" ? this.hashId(String(v)) : v;
    }
    const line = `${JSON.stringify({ t: rec.t, lvl: rec.lvl, code: rec.code, proc: rec.proc, f })}\n`;
    const day = new Date(this.o.now()).toISOString().slice(0, 10).replaceAll("-", "");
    if (!this.current || this.current.day !== day || this.current.size + line.length > this.o.maxFileBytes) this.roll(day);
    appendFileSync(this.current!.file, line, { mode: 0o600 });
    this.current!.size += Buffer.byteLength(line);
    if (this.o.now() - this.lastPrune > 3600_000) this.prune();
  }

  private roll(day: string): void {
    let seq = this.current && this.current.day === day ? this.current.seq + 1 : 0;
    for (;;) {
      const file = join(this.o.dir, seq === 0 ? `kwl-${day}.jsonl` : `kwl-${day}-${seq}.jsonl`);
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // 新文件
      }
      if (size < this.o.maxFileBytes || seq >= 9999) {
        this.current = { day, seq, file, size };
        return;
      }
      seq++;
    }
  }

  /** 删除超过保留期的文件；总量超限时从最旧的删起（不删当前文件）。 */
  prune(): void {
    this.lastPrune = this.o.now();
    let files: { name: string; day: string; seq: number; size: number }[] = [];
    try {
      for (const name of readdirSync(this.o.dir)) {
        const m = FILE_RE.exec(name);
        if (!m) continue;
        try {
          files.push({ name, day: m[1]!, seq: Number(m[2] ?? 0), size: statSync(join(this.o.dir, name)).size });
        } catch {
          // 已被删除
        }
      }
    } catch {
      return;
    }
    const cutoff = new Date(this.o.now() - this.o.retainDays * 86400_000).toISOString().slice(0, 10).replaceAll("-", "");
    for (const f of files) if (f.day < cutoff) rmSync(join(this.o.dir, f.name), { force: true });
    files = files.filter((f) => f.day >= cutoff).sort((a, b) => (a.day === b.day ? a.seq - b.seq : a.day < b.day ? -1 : 1));
    let total = files.reduce((s, f) => s + f.size, 0);
    const cur = this.current?.file ?? "";
    for (const f of files) {
      if (total <= this.o.maxTotalBytes) break;
      if (join(this.o.dir, f.name) === cur) continue;
      rmSync(join(this.o.dir, f.name), { force: true });
      total -= f.size;
    }
  }
}

/** 读回近 N 天的日志记录（诊断包用）：逐行按登记表重新核验，不合规的行跳过并计数。 */
export function readLogs(dir: string, sinceMs: number): { records: LogRecord[]; skipped: number } {
  const records: LogRecord[] = [];
  let skipped = 0;
  const since = new Date(sinceMs).toISOString().slice(0, 10).replaceAll("-", "");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => FILE_RE.test(n) && FILE_RE.exec(n)![1]! >= since).sort();
  } catch {
    return { records, skipped };
  }
  for (const n of names) {
    let text = "";
    try {
      text = readFileSync(join(dir, n), "utf8");
    } catch {
      continue;
    }
    for (const l of text.split("\n")) {
      if (!l) continue;
      try {
        const o = JSON.parse(l) as LogRecord;
        const spec = typeof o.code === "string" && Object.hasOwn(EVENTS, o.code) ? (EVENTS as Record<string, EventSpec>)[o.code]! : null;
        // id 字段在文件里已是 12 位 hash：按“hash 形态”核验
        const f: Record<string, unknown> = {};
        // 级别须与登记表一致（复核 S5A-08）
        let bad = !spec || !PROCS.includes(o.proc) || o.lvl !== spec.level || typeof o.t !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(o.t) || !o.f || typeof o.f !== "object";
        if (!bad) {
          for (const [k, v] of Object.entries(o.f ?? {})) {
            const kind = spec!.fields[k] ?? spec!.fields[`${k}?`];
            if (kind === "id") {
              if (typeof v !== "string" || !HASHED.test(v)) bad = true;
            } else f[k] = v;
          }
        }
        if (!bad) {
          const idKeys = Object.keys(o.f ?? {}).filter((k) => (spec!.fields[k] ?? spec!.fields[`${k}?`]) === "id");
          const probe = { ...f, ...Object.fromEntries(idKeys.map((k) => [k, "x"])) };
          bad = !validateEvent(o.code, probe).ok;
        }
        if (bad || Date.parse(o.t) < sinceMs) {
          if (bad) skipped++;
          continue;
        }
        // 只取登记的五个键重建（多出的顶层键不带进诊断包；复核 S5A-08）
        records.push({ t: o.t, lvl: o.lvl, code: o.code, proc: o.proc, f: { ...o.f } });
      } catch {
        skipped++;
      }
    }
  }
  return { records, skipped };
}
