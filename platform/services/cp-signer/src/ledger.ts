/**
 * 签名账（v9.3 A-8；云端持久化与 KMS 设计 v1 §4.4）：每次签名与拒签各一行，**不写文档内容**（订阅与目录含成员与设备清单），
 * 只记种类、租户、密钥编号、文档与签名结果的摘要。行与行用哈希链连起来（每行带上一行的 SHA-256）：改动或删除中间的行验不过；
 * **截掉末尾几行本账自己发现不了**——要靠外部锚点：末行序号与哈希经指标导出（kwl_signer_ledger_seq），由对账核对“外部见过的末行仍是本账的前缀”（复核 RB16A-01）。
 * 账本文件不在时不静默从头新建：须显式初始化（createIfMissing），否则拒绝启动（整本删除也能发现）。
 *
 * 写法：同步追加 + fsync；**记不进去就不签**——签名服务先在内存里算出签名，签名账写成功才把它交出去（失败关闭）。
 * 写一半（部分写入、fsync 失败）时截回上一条完整记录的末尾；截不回去即置“已损坏”，此后一律拒绝记账（复核 RB16A-02：不在错位的链后面接着写）。
 * 生产形态再按批外送到 WORM 对象存储（A-11 对象存储接口；与控制面事件日志不同桶、不同委托）——尚未做。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface SignerLedgerRecord {
  seq: number;
  at: string;
  request_id: string;
  /** 调用方身份（mTLS 客户端证书的 URI 或 CN；测试形态为 insecure-test）。 */
  caller: string;
  op: "envelope" | "seat_token";
  kind: string | null;
  kid: string | null;
  tid: string | null;
  body_sha256: string | null;
  signed_sha256: string | null;
  /** ok / rejected。 */
  result: "ok" | "rejected";
  reason: string | null;
  prev: string;
}

export type LedgerInput = Omit<SignerLedgerRecord, "seq" | "prev" | "at">;

export interface SignerLedger {
  append(r: LedgerInput, at: string): SignerLedgerRecord;
  head(): { seq: number; hash: string };
  /** 写入失败又截不回去后为 true：此后一律拒绝记账（签名服务据此 503）。 */
  broken(): boolean;
  close(): void;
}

/** 写入原语（用例注入，模拟写一半与 fsync 失败）。 */
export interface LedgerIo {
  writeSync(fd: number, buf: Buffer, off: number): number;
  fsyncSync(fd: number): void;
  ftruncateSync(fd: number, len: number): void;
}
const realIo: LedgerIo = { writeSync: (fd, buf, off) => writeSync(fd, buf, off), fsyncSync, ftruncateSync };

const GENESIS = "0".repeat(64);
const lineHash = (line: string) => createHash("sha256").update(line).digest("hex");

/**
 * 打开签名账；启动时把整本账验一遍——链断了不启动（宁可停签，也不在被改过的账后面接着记）。
 * 文件不在：createIfMissing 才新建（首次部署显式初始化）；否则拒绝启动——整本被删也能发现（复核 RB16A-01）。
 */
export function openSignerLedger(file: string, o: { createIfMissing?: boolean; io?: LedgerIo } = {}): SignerLedger {
  const io = o.io ?? realIo;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let seq = 0;
  let prev = GENESIS;
  if (existsSync(file)) {
    const v = verifySignerLedger(readFileSync(file, "utf8"));
    if (!v.ok) throw new Error(`签名账核验不通过（第 ${v.line} 行：${v.reason}），签名服务不启动`);
    seq = v.seq;
    prev = v.hash;
  } else if (!o.createIfMissing) {
    throw new Error("签名账不存在：首次部署须显式初始化（init_ledger），已有部署丢了账本须先查明原因，签名服务不启动");
  }
  const fd = openSync(file, "a", 0o600);
  // 上一条完整记录的末尾（写一半时截回这里）
  let end = fstatSync(fd).size;
  let isBroken = false;
  // 只关一次：重复关闭会关掉之后被别的文件复用的同号描述符
  let closed = false;
  return {
    append(r, at) {
      if (closed) throw new Error("签名账已关闭");
      if (isBroken) throw new Error("签名账已损坏（上次写入失败且截不回去），拒绝记账");
      const rec: SignerLedgerRecord = { seq: seq + 1, at, ...r, prev };
      const line = JSON.stringify(rec);
      const buf = Buffer.from(`${line}\n`, "utf8");
      try {
        // 普通文件在磁盘满时可能只写入一部分且不报错：补写到写完，写不进即按失败处理
        let off = 0;
        while (off < buf.length) {
          const n = io.writeSync(fd, buf, off);
          if (n <= 0) throw new Error("签名账写入不完整");
          off += n;
        }
        io.fsyncSync(fd);
      } catch (e) {
        // 写一半：截回上一条完整记录的末尾；截不回去即置损坏（之后一律拒绝，不在错位的链后面接着写）
        try {
          io.ftruncateSync(fd, end);
          io.fsyncSync(fd);
        } catch {
          isBroken = true;
        }
        throw e;
      }
      end += buf.length;
      seq = rec.seq;
      prev = lineHash(line);
      return rec;
    },
    head: () => ({ seq, hash: prev }),
    broken: () => isBroken,
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

/** 验整本账：序号连续、每行的 prev 等于上一行的哈希。返回末行序号与哈希。 */
export function verifySignerLedger(text: string): { ok: true; seq: number; hash: string } | { ok: false; line: number; reason: string } {
  let seq = 0;
  let prev = GENESIS;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      if (i === lines.length - 1) break;
      return { ok: false, line: i + 1, reason: "空行" };
    }
    let r: SignerLedgerRecord;
    try {
      r = JSON.parse(line) as SignerLedgerRecord;
    } catch {
      return { ok: false, line: i + 1, reason: "不是 JSON" };
    }
    if (r.seq !== seq + 1) return { ok: false, line: i + 1, reason: "序号不连续" };
    if (r.prev !== prev) return { ok: false, line: i + 1, reason: "哈希链断开" };
    seq = r.seq;
    prev = lineHash(line);
  }
  return { ok: true, seq, hash: prev };
}
