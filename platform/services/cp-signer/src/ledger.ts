/**
 * 签名账（v9.3 A-8；云端持久化与 KMS 设计 v1 §4.4）：每次签名与拒签各一行，**不写文档内容**（订阅与目录含成员与设备清单），
 * 只记种类、租户、密钥编号、文档与签名结果的摘要。行与行用哈希链连起来（每行带上一行的 SHA-256），删改任何一行都验不过。
 *
 * 写法：同步追加 + fsync；**记不进去就不签**——签名服务先在内存里算出签名，签名账写成功才把它交出去（失败关闭）。
 * 生产形态再按批外送到 WORM 对象存储（A-11 对象存储接口；与控制面事件日志不同桶、不同委托）。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
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
  close(): void;
}

const GENESIS = "0".repeat(64);
const lineHash = (line: string) => createHash("sha256").update(line).digest("hex");

/** 打开（或新建）签名账；启动时把整本账验一遍——链断了不启动（宁可停签，也不在被改过的账后面接着记）。 */
export function openSignerLedger(file: string): SignerLedger {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let seq = 0;
  let prev = GENESIS;
  if (existsSync(file)) {
    const v = verifySignerLedger(readFileSync(file, "utf8"));
    if (!v.ok) throw new Error(`签名账核验不通过（第 ${v.line} 行：${v.reason}），签名服务不启动`);
    seq = v.seq;
    prev = v.hash;
  }
  const fd = openSync(file, "a", 0o600);
  // 只关一次：重复关闭会关掉之后被别的文件复用的同号描述符
  let closed = false;
  return {
    append(r, at) {
      if (closed) throw new Error("签名账已关闭");
      const rec: SignerLedgerRecord = { seq: seq + 1, at, ...r, prev };
      const line = JSON.stringify(rec);
      writeSync(fd, `${line}\n`);
      fsyncSync(fd);
      seq = rec.seq;
      prev = lineHash(line);
      return rec;
    },
    head: () => ({ seq, hash: prev }),
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
