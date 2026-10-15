/**
 * 中软云端运营审计流水（v9.2 §5.1 S14；调研 Y2 §3.14“谁、何时、对哪个租户、做了什么、结果；追加写 + 哈希链；律所管理员可导出本所流水”）。
 *
 * 格式与核验放在这里（不含联网代码）：控制面写、律所侧（内核）读与核验共用。
 * - 每租户一条哈希链：`hash = sha256(域前缀 + canonicalJson(记录去掉 hash))`，`prev` 为上一条的 hash（第一条为 64 个 0）；
 * - 记录只有动作代码、执行者（设备编号与证书指纹 / 运营 / 服务）、目标的编号（设备、席位、草稿、连接器、匿名事项编号）与结果代码——
 *   **没有任何客户内容**；
 * - 律所侧记下见过的最高序号与它的 hash：之后取到的流水在该序号上 hash 不同 = 云端改写了已给出的历史（告警）。
 *   单靠哈希链挡不住“整条链重算”，挡得住的是**对已给律所看过的部分**做改动——这正是律所监督受托人所需要的。
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@zr-legal/keys";

export const AUDIT_GENESIS = "0".repeat(64);

export interface CpAuditActor {
  kind: "device" | "root" | "ops" | "service";
  /** 设备编号 / 运营账号 / 服务名（[A-Za-z0-9_.:-]）。 */
  id: string;
  /** 设备证书指纹（设备类执行者）。 */
  fp?: string;
}

export interface CpAuditRecord {
  tid: string;
  seq: number;
  at: string;
  actor: CpAuditActor;
  action: string;
  target: string | null;
  /** `ok` / `rejected:<代码>` / `rolled_back:<代码>`（已记为成功、随后写盘失败而撤销）。 */
  result: string;
  prev: string;
  hash: string;
}

export interface CpAuditPage {
  tid: string;
  records: CpAuditRecord[];
  head: { seq: number; hash: string };
  issued_at: string;
}

const DOMAIN = "kwl-cp-audit/1\n";
const CODE_RE = /^[a-z][a-z0-9_.:-]{0,79}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const RESULT_RE = /^(ok|rejected:[a-z0-9_.:-]{1,80}|rolled_back:[a-z0-9_.:-]{1,80})$/;

export function auditHash(r: Omit<CpAuditRecord, "hash">): string {
  const { tid, seq, at, actor, action, target, result, prev } = r;
  return createHash("sha256")
    .update(DOMAIN + canonicalJson({ tid, seq, at, actor, action, target, result, prev }))
    .digest("hex");
}

/** 单条记录形态（不验链）。 */
export function validAuditRecord(x: unknown): x is CpAuditRecord {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  if (keys !== "action,actor,at,hash,prev,result,seq,target,tid") return false;
  const a = r.actor as Record<string, unknown> | null;
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  const ak = Object.keys(a).sort().join(",");
  if (ak !== "id,kind" && ak !== "fp,id,kind") return false;
  if (!["device", "root", "ops", "service"].includes(a.kind as string) || typeof a.id !== "string" || !ID_RE.test(a.id)) return false;
  if (a.fp !== undefined && (typeof a.fp !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(a.fp))) return false;
  return (
    typeof r.tid === "string" &&
    ID_RE.test(r.tid) &&
    typeof r.seq === "number" &&
    Number.isSafeInteger(r.seq) &&
    r.seq >= 1 &&
    typeof r.at === "string" &&
    Number.isFinite(Date.parse(r.at)) &&
    typeof r.action === "string" &&
    CODE_RE.test(r.action) &&
    (r.target === null || (typeof r.target === "string" && ID_RE.test(r.target))) &&
    typeof r.result === "string" &&
    RESULT_RE.test(r.result) &&
    typeof r.prev === "string" &&
    /^[0-9a-f]{64}$/.test(r.prev) &&
    typeof r.hash === "string" &&
    /^[0-9a-f]{64}$/.test(r.hash)
  );
}

export type AuditChainCheck = { ok: true } | { ok: false; reason: string; seq: number | null };

/**
 * 核验一段连续的流水：形态、租户、序号连续、每条 hash 正确、prev 相接。
 * `anchor` = 这段之前一条的（序号, hash）：从第 1 条开始时为 {seq:0, hash:AUDIT_GENESIS}。
 */
export function verifyAuditChain(records: readonly unknown[], tid: string, anchor: { seq: number; hash: string }): AuditChainCheck {
  let prevSeq = anchor.seq;
  let prevHash = anchor.hash;
  for (const x of records) {
    if (!validAuditRecord(x)) return { ok: false, reason: "record_malformed", seq: typeof (x as { seq?: unknown })?.seq === "number" ? (x as { seq: number }).seq : null };
    if (x.tid !== tid) return { ok: false, reason: "tenant_mismatch", seq: x.seq };
    if (x.seq !== prevSeq + 1) return { ok: false, reason: "seq_gap", seq: x.seq };
    if (x.prev !== prevHash) return { ok: false, reason: "prev_mismatch", seq: x.seq };
    if (auditHash(x) !== x.hash) return { ok: false, reason: "hash_mismatch", seq: x.seq };
    prevSeq = x.seq;
    prevHash = x.hash;
  }
  return { ok: true };
}
