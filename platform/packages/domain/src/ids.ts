import { randomUUID, createHash } from "node:crypto";
import { DomainError } from "./errors.ts";

/** 服务端生成的稳定 ID：带对象类型前缀的 UUIDv4（方案 §4.3：统一使用服务端生成的稳定 ID）。 */
export const IdPrefix = {
  tenant: "ten",
  user: "usr",
  membership: "mem",
  seat: "seat",
  matter: "mat",
  documentVersion: "docv",
  parseVersion: "psv",
  evidenceAnchor: "anc",
  legalSourceVersion: "lsv",
  rulePackage: "rule",
  templateVersion: "tplv",
  run: "run",
  attempt: "att",
  toolOperation: "top",
  artifactVersion: "artv",
  review: "rev",
  approval: "apr",
  delivery: "dlv",
  usage: "usg",
  pointLedger: "plt",
  costLedger: "cst",
  auditEvent: "aud",
  estimate: "est",
  egressRecord: "egr",
  qaConversation: "qac",
  qaMessage: "qam",
  riskCard: "rkc",
  fact: "fct",
  // v9.4 第 19 批：起草前的论点提纲（C-04）、表格审阅的表与格（C-01）
  outline: "otl",
  reviewTable: "rtb",
  reviewCell: "rtc",
  // v9.4 第 20 批：事项待办（C1 §3.2）
  todo: "tdo",
  // 缺失卡说法组（C-02 残余）、风险卡批量决定的批次
  synonym: "syn",
  cardBatch: "cbt",
  // v9.4 第 22 批：本事项的审查要点（每一版与草稿）
  reviewRules: "rrs",
} as const;

export type IdPrefixKey = keyof typeof IdPrefix;

export function newId(kind: IdPrefixKey): string {
  return `${IdPrefix[kind]}_${randomUUID()}`;
}

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 幂等键：调用方提供；服务端按 (tenant, key) 去重（方案 §9.6：同键同内容返回原任务）。 */
export function assertIdempotencyKey(key: string): void {
  if (typeof key !== "string" || key.length < 8 || key.length > 200) {
    throw new DomainError("validation", "需要幂等键 idempotency_key（8–200 字符，用于「同键同内容返回原任务」）", 422);
  }
}
