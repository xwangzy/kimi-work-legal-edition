/**
 * 律所连接器登记（v9 第 02 篇 §9.8：律所批准的 MCP 由管理员登记——须管理员设备签名，标注“可接收数据级别”，按哈希锁定；
 * 第 04 篇 §5.1 `/mcp/firm/*`：数据级别上限、登记须管理员设备签名；第 04 篇 §10、T17：未经管理员签名登记的连接器客户端拒绝或告警）。
 *
 * 每条登记都是“放宽”（让 Agent 多一个可调用的外部服务），一律须 ≥ 门限名管理员的设备签名；控制面签名不能代替。
 * 工具清单按 schema hash 锁定（与宿主策略清单同一口径：schema 变了即视为另一个工具）。
 */
import { canonicalJson } from "@zr-legal/keys";
import { verifyAdminSignatures, bytesDigest, type AdminSignature } from "./admin.ts";
import { MAX_FIRST_VERSION, MAX_POLICY_VERSION_JUMP, type HighWater } from "./policy.ts";

export const RECEIVABLE_LEVELS = ["L0", "L1", "L2", "L3a"] as const;
export type ReceivableLevel = (typeof RECEIVABLE_LEVELS)[number];
export const CONNECTOR_SIDE_EFFECTS = ["read", "write_draft", "exec", "network", "external", "irreversible"] as const;

export interface FirmConnectorTool {
  name: string;
  side_effect: (typeof CONNECTOR_SIDE_EFFECTS)[number];
  /** sha256(canonicalJson(inputSchema))，十六进制。 */
  schema_hash: string;
}

export interface FirmConnectorDoc {
  kind: "kwl-firm-connector";
  v: 1;
  tid: string;
  connector_id: string;
  /** 每条登记自己的版本（单调）。 */
  version: number;
  name: string;
  /** 引擎可见的 MCP 服务名。 */
  server: string;
  /** 律所服务地址。 */
  url: string;
  /** 可接收的最高数据级别（L3b 一律不可接收）。 */
  max_data_level: ReceivableLevel;
  tools: FirmConnectorTool[];
  registered_at: string;
}

export interface SignedFirmConnector {
  doc: FirmConnectorDoc;
  admin_signatures: AdminSignature[];
}

const CONNECTOR_DOMAIN = "kwl-firm-connector-v1\n";
const ID_RE = /^[a-z][a-z0-9_-]{1,40}$/;
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function connectorSigningBytes(doc: FirmConnectorDoc): Buffer {
  return Buffer.from(CONNECTOR_DOMAIN + canonicalJson(doc), "utf8");
}

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

export function validateConnectorDoc(x: unknown): Check<FirmConnectorDoc> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, reason: "doc_not_object" };
  const d = x as Record<string, unknown>;
  const fields = ["kind", "v", "tid", "connector_id", "version", "name", "server", "url", "max_data_level", "tools", "registered_at"];
  for (const k of Object.keys(d)) if (!fields.includes(k)) return { ok: false, reason: `unknown_field:${k}` };
  if (d.kind !== "kwl-firm-connector" || d.v !== 1) return { ok: false, reason: "doc_kind_or_version" };
  if (typeof d.tid !== "string" || !d.tid) return { ok: false, reason: "doc_tid" };
  if (typeof d.connector_id !== "string" || !ID_RE.test(d.connector_id)) return { ok: false, reason: "connector_id_invalid" };
  if (typeof d.server !== "string" || !ID_RE.test(d.server)) return { ok: false, reason: "server_invalid" };
  if (typeof d.version !== "number" || !Number.isSafeInteger(d.version) || d.version < 1) return { ok: false, reason: "version_invalid" };
  if (typeof d.name !== "string" || d.name.length < 1 || d.name.length > 80) return { ok: false, reason: "name_invalid" };
  if (typeof d.url !== "string") return { ok: false, reason: "url_invalid" };
  try {
    const u = new URL(d.url);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return { ok: false, reason: "url_invalid" };
  } catch {
    return { ok: false, reason: "url_invalid" };
  }
  if (!(RECEIVABLE_LEVELS as readonly unknown[]).includes(d.max_data_level)) return { ok: false, reason: "max_data_level_invalid" };
  if (!Array.isArray(d.tools) || d.tools.length < 1 || d.tools.length > 100) return { ok: false, reason: "tools_invalid" };
  const names = new Set<string>();
  for (const t of d.tools as unknown[]) {
    const tool = t as Record<string, unknown> | null;
    if (!tool || typeof tool !== "object" || Object.keys(tool).some((k) => !["name", "side_effect", "schema_hash"].includes(k))) return { ok: false, reason: "tool_invalid" };
    if (typeof tool.name !== "string" || !TOOL_RE.test(tool.name) || names.has(tool.name)) return { ok: false, reason: "tool_name_invalid" };
    if (!(CONNECTOR_SIDE_EFFECTS as readonly unknown[]).includes(tool.side_effect)) return { ok: false, reason: "tool_side_effect_invalid" };
    if (typeof tool.schema_hash !== "string" || !/^[0-9a-f]{64}$/.test(tool.schema_hash)) return { ok: false, reason: "tool_schema_hash_invalid" };
    names.add(tool.name);
  }
  if (typeof d.registered_at !== "string" || !Number.isFinite(Date.parse(d.registered_at))) return { ok: false, reason: "registered_at_invalid" };
  return { ok: true, value: d as unknown as FirmConnectorDoc };
}

export type ConnectorVerdict =
  | { ok: true; unchanged: boolean; doc: FirmConnectorDoc; digest: string; signers: string[]; signerDevices: string[]; deviceMembers: Record<string, string>; verifiedSignatures: AdminSignature[] }
  | { ok: false; code: "malformed" | "tenant_mismatch" | "replayed" | "version_conflict" | "version_jump" | "unsigned"; detail: string; connectorId: string | null; version: number | null };

export interface ConnectorContext {
  tid: string;
  rootPublicKeyPem: string;
  adminThreshold: number;
  /** 该连接器本机已接受的版本高水位。 */
  highWater: HighWater | null;
  revokedDevices: ReadonlySet<string>;
  now: Date;
}

export function evaluateConnector(candidate: unknown, ctx: ConnectorContext): ConnectorVerdict {
  const c = candidate as Partial<SignedFirmConnector> | null;
  const raw = (c?.doc ?? null) as { connector_id?: unknown; version?: unknown } | null;
  const connectorId = typeof raw?.connector_id === "string" ? raw.connector_id : null;
  const rawVersion = typeof raw?.version === "number" ? raw.version : null;
  const check = validateConnectorDoc(c?.doc);
  if (!check.ok) return { ok: false, code: "malformed", detail: check.reason, connectorId, version: rawVersion };
  const doc = check.value;
  const reject = (code: "tenant_mismatch" | "replayed" | "version_conflict" | "version_jump" | "unsigned", detail: string): ConnectorVerdict => ({ ok: false, code, detail, connectorId: doc.connector_id, version: doc.version });
  if (doc.tid !== ctx.tid) return reject("tenant_mismatch", `连接器登记属于其他租户（${doc.tid}）`);
  const bytes = connectorSigningBytes(doc);
  const digest = bytesDigest(bytes);
  if (ctx.highWater) {
    if (doc.version < ctx.highWater.version) return reject("replayed", `版本 ${doc.version} 低于本机已接受的版本 ${ctx.highWater.version}（回放旧登记）`);
    if (doc.version === ctx.highWater.version) {
      if (ctx.highWater.digest === digest) return { ok: true, unchanged: true, doc, digest, signers: [], signerDevices: [], deviceMembers: {}, verifiedSignatures: [] };
      return reject("version_conflict", `版本 ${doc.version} 已接受过另一份内容`);
    }
    if (doc.version - ctx.highWater.version > MAX_POLICY_VERSION_JUMP) return reject("version_jump", `版本从 ${ctx.highWater.version} 跳到 ${doc.version}，超过单次上限 ${MAX_POLICY_VERSION_JUMP}`);
  } else if (doc.version > MAX_FIRST_VERSION) {
    return reject("version_jump", `首次接受的版本 ${doc.version} 超过上限 ${MAX_FIRST_VERSION}`);
  }
  const v = verifyAdminSignatures(bytes, c?.admin_signatures, { rootPublicKeyPem: ctx.rootPublicKeyPem, threshold: ctx.adminThreshold, revokedDevices: ctx.revokedDevices, now: ctx.now });
  if (!v.ok) {
    const why = v.problems.length > 0 ? `；无效签名：${v.problems.join("、")}` : "";
    return reject("unsigned", `连接器登记需 ${ctx.adminThreshold} 名管理员设备签名，有效 ${v.members.length} 名${why}`);
  }
  return { ok: true, unchanged: false, doc, digest, signers: v.members, signerDevices: v.devices, deviceMembers: v.deviceMembers, verifiedSignatures: v.verified };
}
