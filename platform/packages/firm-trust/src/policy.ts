/**
 * 律所策略（v9 第 02 篇 §7.1 #4：云控编写 → 端与网关执行；放宽类须管理员设备签名；最后一份有效策略，过期回退最严模板；
 * §10：30 天有效期，过期回退“产品基线 + 最严模板”；§9.11：策略版本单调、带有效期）。
 *
 * G0 的策略字段即此前以本机配置项代替的几项（偏离 D-17）：律所的运行模式上限、自动档可预授权的范围、抓取白名单追加、
 * L3a 事项经标准端点推理的管理员放开。产品基线（执行域、闸门唯一出口、令牌化、L3b 只用私有端点等）在代码里，策略改不动。
 *
 * **最严模板**（本实现的定义，见进度文档）：运行模式上限“默认”（默认档的执行域内动作本身无网、原件只读、可回滚，第 02 篇 §9.3；
 * 跨边界动作仍逐项确认），不开放自动档与任何预授权、抓取只用公开官方站点基线、L3a 不经标准端点。
 * 比最严模板宽的任一项都是“放宽”，须管理员设备签名（门限按成员计）；不比它宽的策略只需控制面签名即可生效。
 */
import { canonicalJson } from "@zr-legal/keys";
import { verifyAdminSignatures, bytesDigest, type AdminSignature } from "./admin.ts";

export const RUN_MODES = ["chat", "manual", "default", "auto"] as const;
export type RunMode = (typeof RUN_MODES)[number];
export const MODE_RANK: Readonly<Record<RunMode, number>> = Object.freeze({ chat: 0, manual: 1, default: 2, auto: 3 });

export const AUTO_PREAUTHORIZATIONS = ["search_generalized"] as const;
export type AutoPreauthorization = (typeof AUTO_PREAUTHORIZATIONS)[number];

export interface FirmPolicyBody {
  /** 律所允许的最高运行模式（事项与渠道再降）。 */
  max_mode: RunMode;
  /** 自动档开始时律师可选的预授权范围（只在 max_mode 为 auto 时可非空）。 */
  auto_preauthorizations: AutoPreauthorization[];
  /** 抓取白名单追加（公开官方站点基线之外；小写域名）。 */
  fetch_allowlist_extra: string[];
  /** L3a 事项经标准端点推理（“管理员放开 + 全部化名强制”，第 02 篇 §8.2）。 */
  l3a_standard_model: "deny" | "allow";
}

export function strictestTemplate(): FirmPolicyBody {
  return { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny" };
}

/** 有效期上限（第 02 篇 §10）。 */
export const POLICY_MAX_TTL_MS = 30 * 24 * 3600 * 1000;
/** 签发时刻允许的时钟偏差。 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

const POLICY_FIELDS = ["max_mode", "auto_preauthorizations", "fetch_allowlist_extra", "l3a_standard_model"] as const;
export const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 字段齐全、取值合法、没有本机不认识的字段（认不出即无法判断宽严 → 拒绝，失败关闭）。 */
export function validatePolicyBody(x: unknown): Check<FirmPolicyBody> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, reason: "body_not_object" };
  const b = x as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!(POLICY_FIELDS as readonly string[]).includes(k)) return { ok: false, reason: `unknown_field:${k}` };
  for (const k of POLICY_FIELDS) if (!(k in b)) return { ok: false, reason: `missing_field:${k}` };
  if (!(RUN_MODES as readonly unknown[]).includes(b.max_mode)) return { ok: false, reason: "max_mode_invalid" };
  const pre = b.auto_preauthorizations;
  if (!Array.isArray(pre) || pre.some((p) => !(AUTO_PREAUTHORIZATIONS as readonly unknown[]).includes(p)) || new Set(pre).size !== pre.length) {
    return { ok: false, reason: "auto_preauthorizations_invalid" };
  }
  if (pre.length > 0 && b.max_mode !== "auto") return { ok: false, reason: "preauthorizations_require_auto" };
  const extra = b.fetch_allowlist_extra;
  if (!Array.isArray(extra) || extra.length > 200 || extra.some((d) => typeof d !== "string" || !DOMAIN_RE.test(d)) || new Set(extra).size !== extra.length) {
    return { ok: false, reason: "fetch_allowlist_extra_invalid" };
  }
  if (b.l3a_standard_model !== "deny" && b.l3a_standard_model !== "allow") return { ok: false, reason: "l3a_standard_model_invalid" };
  return {
    ok: true,
    value: {
      max_mode: b.max_mode as RunMode,
      auto_preauthorizations: [...(pre as AutoPreauthorization[])],
      fetch_allowlist_extra: [...(extra as string[])],
      l3a_standard_model: b.l3a_standard_model,
    },
  };
}

/**
 * 逐项取更严（复核 S6-A09）：律所策略过期或签名不足而回退时，回退结果不比“最后一份已接受策略”宽——
 * 律所自己选了更严的档位上限（手动、问答），过期后不会反而回到最严模板的“默认”。
 */
export function stricterBody(a: FirmPolicyBody, b: FirmPolicyBody): FirmPolicyBody {
  return {
    max_mode: MODE_RANK[a.max_mode] <= MODE_RANK[b.max_mode] ? a.max_mode : b.max_mode,
    auto_preauthorizations: a.auto_preauthorizations.filter((p) => b.auto_preauthorizations.includes(p)),
    fetch_allowlist_extra: a.fetch_allowlist_extra.filter((d) => b.fetch_allowlist_extra.includes(d)),
    l3a_standard_model: a.l3a_standard_model === "allow" && b.l3a_standard_model === "allow" ? "allow" : "deny",
  };
}

/** 单次版本跳跃的上限（复核 S6-A13、S6-B20）：超出即拒收并告警，防止版本号被一次抬到顶、此后再也无法更新。 */
export const MAX_POLICY_VERSION_JUMP = 1000;
/**
 * 首次接受（本机尚无高水位）时版本号的绝对上限（复核 S6-B29）：控制面每次发布只加一（草稿不占版本号），
 * 正常使用远到不了；新设备上版本号同样不能被一次抬到顶。
 */
export const MAX_FIRST_VERSION = 1_000_000;

/** 相对最严模板放宽的项（空 = 不比最严模板宽，控制面签名即可生效）。 */
export function policyRelaxations(body: FirmPolicyBody): string[] {
  const s = strictestTemplate();
  const r: string[] = [];
  if (MODE_RANK[body.max_mode] > MODE_RANK[s.max_mode]) r.push(`max_mode:${body.max_mode}`);
  for (const p of body.auto_preauthorizations) r.push(`auto_preauthorization:${p}`);
  for (const d of body.fetch_allowlist_extra) r.push(`fetch_allowlist:${d}`);
  if (body.l3a_standard_model === "allow") r.push("l3a_standard_model:allow");
  return r;
}

export interface FirmPolicyDoc {
  kind: "kwl-firm-policy";
  v: 1;
  tid: string;
  /** 版本：单调递增（控制面起草时分配，管理员签名覆盖版本号）。 */
  version: number;
  issued_at: string;
  expires_at: string;
  body: FirmPolicyBody;
}

export interface SignedFirmPolicy {
  doc: FirmPolicyDoc;
  admin_signatures: AdminSignature[];
}

const POLICY_DOMAIN = "kwl-firm-policy-v1\n";

/** 管理员设备签名的字节：整份文档（租户、版本、签发与到期时刻、策略正文），域分隔。 */
export function policySigningBytes(doc: FirmPolicyDoc): Buffer {
  return Buffer.from(POLICY_DOMAIN + canonicalJson(doc), "utf8");
}

export function validatePolicyDoc(x: unknown): Check<FirmPolicyDoc> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, reason: "doc_not_object" };
  const d = x as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!["kind", "v", "tid", "version", "issued_at", "expires_at", "body"].includes(k)) return { ok: false, reason: `unknown_doc_field:${k}` };
  if (d.kind !== "kwl-firm-policy") return { ok: false, reason: "doc_kind" };
  // 格式版本不认识（客户端需要升级）：与“不认识的字段”同样按更新的格式处理（复核 S6-B30）
  if (d.v !== 1) return { ok: false, reason: `doc_format_unsupported:${String(d.v).slice(0, 20)}` };
  if (typeof d.tid !== "string" || !d.tid) return { ok: false, reason: "doc_tid" };
  if (typeof d.version !== "number" || !Number.isSafeInteger(d.version) || d.version < 1) return { ok: false, reason: "doc_version" };
  const iat = typeof d.issued_at === "string" ? Date.parse(d.issued_at) : NaN;
  const exp = typeof d.expires_at === "string" ? Date.parse(d.expires_at) : NaN;
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat) return { ok: false, reason: "doc_times" };
  const body = validatePolicyBody(d.body);
  if (!body.ok) return body;
  return { ok: true, value: { kind: "kwl-firm-policy", v: 1, tid: d.tid, version: d.version, issued_at: d.issued_at as string, expires_at: d.expires_at as string, body: body.value } };
}

export interface HighWater {
  version: number;
  digest: string | null;
}

export type PolicyRejectCode =
  | "malformed"
  | "tenant_mismatch"
  | "ttl_too_long"
  | "not_yet_valid"
  | "expired"
  | "replayed"
  | "version_conflict"
  | "version_jump"
  | "relaxation_unsigned";

export type PolicyVerdict =
  | { ok: true; unchanged: boolean; doc: FirmPolicyDoc; digest: string; relaxations: string[]; signers: string[]; signerDevices: string[]; deviceMembers: Record<string, string>; verifiedSignatures: AdminSignature[] }
  | { ok: false; code: PolicyRejectCode; detail: string; version: number | null; relaxations: string[] };

export interface PolicyContext {
  tid: string;
  rootPublicKeyPem: string;
  adminThreshold: number;
  highWater: HighWater | null;
  revokedDevices: ReadonlySet<string>;
  now: Date;
}

/**
 * 本机接受一份下发策略的判定（控制面信封已验过之后）：
 * 文档合法 → 租户相符 → 有效期 ≤ 30 天、已生效、未过期 → 版本高于已接受的高水位（相同版本须同一内容）→
 * 放宽项非空时须 ≥ 门限名管理员的有效设备签名。
 */
export function evaluatePolicy(candidate: unknown, ctx: PolicyContext): PolicyVerdict {
  const c = candidate as Partial<SignedFirmPolicy> | null;
  const docCheck = validatePolicyDoc(c?.doc);
  const rawVersion = typeof (c?.doc as { version?: unknown } | undefined)?.version === "number" ? ((c!.doc as { version: number }).version) : null;
  if (!docCheck.ok) return { ok: false, code: "malformed", detail: docCheck.reason, version: rawVersion, relaxations: [] };
  const doc = docCheck.value;
  const relaxations = policyRelaxations(doc.body);
  const reject = (code: PolicyRejectCode, detail: string): PolicyVerdict => ({ ok: false, code, detail, version: doc.version, relaxations });
  if (doc.tid !== ctx.tid) return reject("tenant_mismatch", `策略属于其他租户（${doc.tid}）`);
  const bytes = policySigningBytes(doc);
  const digest = bytesDigest(bytes);
  // 版本先于时间判断：回放的旧策略不论是否已过期都按“回放”拒绝；已接受的当前版本原样再下发不算变化（是否已过期由生效计算决定）
  if (ctx.highWater) {
    if (doc.version < ctx.highWater.version) return reject("replayed", `版本 ${doc.version} 低于本机已接受的版本 ${ctx.highWater.version}（回放旧策略）`);
    if (doc.version === ctx.highWater.version) {
      if (ctx.highWater.digest === digest) return { ok: true, unchanged: true, doc, digest, relaxations, signers: [], signerDevices: [], deviceMembers: {}, verifiedSignatures: [] };
      return reject("version_conflict", `版本 ${doc.version} 已接受过另一份内容`);
    }
    if (doc.version - ctx.highWater.version > MAX_POLICY_VERSION_JUMP) return reject("version_jump", `版本从 ${ctx.highWater.version} 跳到 ${doc.version}，超过单次上限 ${MAX_POLICY_VERSION_JUMP}`);
  } else if (doc.version > MAX_FIRST_VERSION) {
    return reject("version_jump", `首次接受的版本 ${doc.version} 超过上限 ${MAX_FIRST_VERSION}`);
  }
  const iat = Date.parse(doc.issued_at);
  const exp = Date.parse(doc.expires_at);
  if (exp - iat > POLICY_MAX_TTL_MS) return reject("ttl_too_long", "有效期超过 30 天");
  if (iat > ctx.now.getTime() + CLOCK_SKEW_MS) return reject("not_yet_valid", "签发时刻在未来");
  if (exp <= ctx.now.getTime()) return reject("expired", `已于 ${doc.expires_at} 过期`);
  let signers: string[] = [];
  let signerDevices: string[] = [];
  let deviceMembers: Record<string, string> = {};
  let verifiedSignatures: AdminSignature[] = [];
  if (relaxations.length > 0) {
    const v = verifyAdminSignatures(bytes, c?.admin_signatures, {
      rootPublicKeyPem: ctx.rootPublicKeyPem,
      threshold: ctx.adminThreshold,
      revokedDevices: ctx.revokedDevices,
      now: ctx.now,
    });
    if (!v.ok) {
      const why = v.problems.length > 0 ? `；无效签名：${v.problems.join("、")}` : "";
      return reject("relaxation_unsigned", `放宽项（${relaxations.join("、")}）需 ${ctx.adminThreshold} 名管理员设备签名，有效 ${v.members.length} 名${why}`);
    }
    signers = v.members;
    signerDevices = v.devices;
    deviceMembers = v.deviceMembers;
    verifiedSignatures = v.verified;
  }
  return { ok: true, unchanged: false, doc, digest, relaxations, signers, signerDevices, deviceMembers, verifiedSignatures };
}

/**
 * 本机解析不了的策略是否属于“更新的格式”（不认识的字段、取值或格式版本——客户端需要升级），而不是内容错误（复核 S6-B18、S6-B30）。
 * 认不出即无法判断宽严：这类文档不接受，但生效策略回退最严模板，而不是沿用可能更宽的旧策略。
 */
export function isUnrecognizedFormat(detail: string): boolean {
  return /^(unknown_(doc_)?field|doc_format_unsupported|max_mode_invalid|auto_preauthorizations_invalid|l3a_standard_model_invalid)/.test(detail);
}

/**
 * “不认识的更新版本”的候选（复核 S6-B30、S6-C04）：按可识别策略的同一规则核对得过——本租户、签发时刻不在未来、未过期、有效期 ≤ 30 天，
 * 版本高于本机已接受的版本。返回回退标记应取的版本：领先超过 maxLead 时钳在“高水位 + maxLead”（领先再多也回退最严模板——失败关闭不丢；
 * 只凭控制面签名的文档最多让本机回退到控制面再发布 maxLead 个版本为止）。不满足即 null（按格式不合法拒绝，不影响生效策略）。
 * 本机尚未接受过策略时不检查领先幅度（此时生效的本来就是最严模板，调用方不抬标记，只告警）。
 */
export function unrecognizedNewerVersion(candidate: unknown, ctx: { tid: string; highWater: HighWater | null; now: Date; maxLead: number }): number | null {
  const d = (candidate as { doc?: unknown } | null)?.doc;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const doc = d as Record<string, unknown>;
  if (doc.kind !== "kwl-firm-policy" || doc.tid !== ctx.tid) return null;
  const version = doc.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return null;
  if (ctx.highWater ? version <= ctx.highWater.version : version > MAX_FIRST_VERSION) return null;
  const iat = typeof doc.issued_at === "string" ? Date.parse(doc.issued_at) : NaN;
  const exp = typeof doc.expires_at === "string" ? Date.parse(doc.expires_at) : NaN;
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat || exp - iat > POLICY_MAX_TTL_MS) return null;
  if (iat > ctx.now.getTime() + CLOCK_SKEW_MS || exp <= ctx.now.getTime()) return null;
  return ctx.highWater ? Math.min(version, ctx.highWater.version + ctx.maxLead) : version;
}
