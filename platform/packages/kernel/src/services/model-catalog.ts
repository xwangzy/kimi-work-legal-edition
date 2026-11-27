/**
 * 云端模型目录（第 66 批，V40）：律师端能选哪些模型由云端统一配置，客户端动态拉取，不需重新封装。
 *
 * - 来源：控制面 `GET /v1/models`（设备签名 + 账号会话，经出站闸门的控制面通道），控制面签名信封 `kwl-model-catalog`；
 *   只含别名、显示名、说明、排序、思考方式、能力、入口与可用性——上游型号、地址、目标与密钥不下发（网关按别名路由）。
 * - 验签后按 (version, issued_at) 只进不退：旧版本或同版本更早签发的一律不采用（防重放把停用的模型“放回来”）。
 *   第 72 批：信封带纪元（epoch）时，纪元不同按签发时刻比（云端路由状态重建后版本号从头数起，见 catalogNewer）。
 * - 缓存：内存 + 工作区内 JSON（存的是原信封，读回时重新验签；记 fetched_at）；离线用最后一版；从未取到用内置两项兜底；
 *   开发形态与试用版（没有控制面）只用内置两项。
 * - 刷新：登录成功后、每 10 分钟、收到网关 model_* / price_unconfigured 拒绝时（至多 30 秒一次）。
 * - 律师的选择（按入口 qa / task 分开）存在本机库 model_prefs（迁移 0073）；所选模型不可用时回落到缺省并说明原因。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ModelScope = "qa" | "task";
export type ThinkingControl = "effort" | "toggle" | "none";
export type ModelEffort = "low" | "high" | "max";
export type ModelCapability = "tool_use" | "thinking" | "long_context";
export type CatalogReason = "not_in_plan" | "unpriced" | "no_route" | "disabled" | "same_upstream";

export interface CatalogModel {
  id: string;
  label: string;
  description: string | null;
  sort: number;
  thinking: ThinkingControl;
  efforts: ModelEffort[];
  capabilities: ModelCapability[];
  scopes: ModelScope[];
  max_context: number | null;
  default: boolean;
  available: boolean;
  reason: CatalogReason | null;
}

export interface ModelCatalogDoc {
  version: number;
  /**
   * 第 72 批（D-299 第 6 条，A1 M7）：路由状态的纪元（控制面首次建立 / 重建路由状态时随机生成，运营修改不换；签名覆盖）。
   * 旧云端没有 = null。
   */
  epoch: string | null;
  issued_at: string;
  tid: string;
  default: string;
  models: CatalogModel[];
}

export const DEFAULT_MODEL = "legal/k3";
export const BUILTIN_MODEL_IDS: readonly string[] = ["legal/k3", "legal/k2.6"];

/** 内置两项（与控制面 BUILTIN_MODEL_META 同一口径；第 47～65 批客户端写死的样子）。 */
export const BUILTIN_CATALOG: readonly CatalogModel[] = Object.freeze([
  { id: "legal/k3", label: "K3", description: "适合复杂问题", sort: 10, thinking: "effort", efforts: ["low", "high", "max"], capabilities: ["tool_use", "thinking", "long_context"], scopes: ["qa", "task"], max_context: 262_144, default: true, available: true, reason: null },
  // 第 72 批（D-299 第 2 条）：K2.6 本来就是带 tool_use 的 Agent 模型（任务里的子 Agent 就是它），与云端内置口径一起进任务入口
  { id: "legal/k2.6", label: "K2.6", description: "更快、更省额度，复杂问题效果略弱", sort: 20, thinking: "toggle", efforts: [], capabilities: ["tool_use", "thinking"], scopes: ["qa", "task"], max_context: 262_144, default: false, available: true, reason: null },
] as CatalogModel[]);

const ID_RE = /^[a-z0-9][a-z0-9._/-]{1,47}$/;
const THINKING: readonly ThinkingControl[] = ["effort", "toggle", "none"];
const EFFORTS: readonly ModelEffort[] = ["low", "high", "max"];
const CAPS: readonly ModelCapability[] = ["tool_use", "thinking", "long_context"];
const SCOPES: readonly ModelScope[] = ["qa", "task"];
const REASONS: readonly CatalogReason[] = ["not_in_plan", "unpriced", "no_route", "disabled", "same_upstream"];
/** 纪元：控制面随机 16 字节 base64url（22 字符）；留一点余量。 */
const EPOCH_RE = /^[A-Za-z0-9_-]{8,64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const subset = <T extends string>(v: unknown, all: readonly T[]): T[] | null => (Array.isArray(v) && v.length <= all.length && v.every((x) => (all as readonly unknown[]).includes(x)) ? all.filter((x) => v.includes(x)) : null);

/**
 * 核对并只取已知字段（纯函数）：任何一项不合格整份不收（宁可用上一版）；不认识的字段一律丢掉——
 * 即使控制面误带了目标或地址，也不会进到本机缓存与界面。
 */
export function sanitizeCatalog(body: unknown, tenantId: string): ModelCatalogDoc | null {
  if (!isObj(body) || body.tid !== tenantId || !Number.isSafeInteger(body.version) || (body.version as number) < 0) return null;
  if (typeof body.issued_at !== "string" || !Number.isFinite(Date.parse(body.issued_at))) return null;
  // 第 72 批：纪元可省（旧云端）；带了就必须合格（它在签名里，格式不对说明信封有问题，整份不收）
  if (body.epoch !== undefined && body.epoch !== null && !(typeof body.epoch === "string" && EPOCH_RE.test(body.epoch))) return null;
  if (typeof body.default !== "string" || !ID_RE.test(body.default) || !Array.isArray(body.models) || body.models.length > 32) return null;
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const m of body.models) {
    if (!isObj(m) || typeof m.id !== "string" || !ID_RE.test(m.id) || seen.has(m.id)) return null;
    if (typeof m.label !== "string" || !m.label.trim() || m.label.length > 40) return null;
    if (m.description !== null && !(typeof m.description === "string" && m.description.length <= 120)) return null;
    if (!Number.isSafeInteger(m.sort) || !THINKING.includes(m.thinking as ThinkingControl)) return null;
    const efforts = subset(m.efforts, EFFORTS);
    const capabilities = subset(m.capabilities, CAPS);
    const scopes = subset(m.scopes, SCOPES);
    if (!efforts || !capabilities || !scopes) return null;
    if (m.max_context !== null && !(Number.isSafeInteger(m.max_context) && (m.max_context as number) >= 4096)) return null;
    if (typeof m.available !== "boolean" || (m.reason !== null && !REASONS.includes(m.reason as CatalogReason))) return null;
    seen.add(m.id);
    models.push({
      id: m.id,
      label: m.label.trim(),
      description: (m.description as string | null) ?? null,
      sort: m.sort as number,
      thinking: m.thinking as ThinkingControl,
      efforts,
      capabilities,
      scopes,
      max_context: (m.max_context as number | null) ?? null,
      default: m.id === body.default,
      available: m.available && m.reason === null,
      reason: m.available ? null : ((m.reason as CatalogReason | null) ?? "disabled"),
    });
  }
  models.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  return { version: body.version as number, epoch: typeof body.epoch === "string" ? body.epoch : null, issued_at: body.issued_at, tid: tenantId, default: body.default, models };
}

/**
 * 新文档是否比当前的新（纯函数）。当前没有 → 新。
 * - 同一纪元（两边都没有纪元 = 旧云端，也算同一纪元）：先比 version，同版本比签发时刻——与第 66 批相同。
 * - 纪元不同（第 72 批，A1 M7）：控制面的路由状态被重建 / 从备份恢复 / 迁到新服务器，version 从头数起，按 version 比会把客户端钉在旧目录上。
 *   此时不比 version，只要求签发时刻晚于当前这份——重建后的目录都是现签的（签发时刻 = 请求时刻），照样采用；
 *   而把以前某个纪元的旧信封重放回来，签发时刻一定早于本机已采用的这份，仍不采用（防重放不因纪元放松）。
 *   契约原文是“epoch 不同即接受”；这里多加一条签发时刻，代价只在云端时钟倒退超过本机上一份的签发时刻时晚一点采用。
 */
export function catalogNewer(next: { version: number; issued_at: string; epoch?: string | null }, cur: { version: number; issued_at: string; epoch?: string | null } | null): boolean {
  if (!cur) return true;
  const sameEpoch = (next.epoch ?? null) === (cur.epoch ?? null);
  if (!sameEpoch) return Date.parse(next.issued_at) > Date.parse(cur.issued_at);
  if (next.version !== cur.version) return next.version > cur.version;
  return Date.parse(next.issued_at) > Date.parse(cur.issued_at);
}

/** 不可用的原因说给律师听。 */
export function catalogReasonText(reason: string | null | undefined, scope?: ModelScope): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case "not_in_plan":
      return "本所套餐不含这个模型";
    case "unpriced":
      return "这个模型尚未定价，暂不能用";
    case "no_route":
      return "这个模型暂时没有可用线路";
    case "disabled":
      return "这个模型已停用";
    case "same_upstream":
      // 第 72 批（D-299 第 3 条）：运营把它配成与缺省模型同一个上游型号——照列但置灰，不给“名字不同、实际相同”的选择
      return "运营尚未给它配置独立的模型";
    case "no_tool_use":
      return "这个模型不支持任务需要的工具调用，只能在问答里用";
    case "not_in_scope":
      return scope === "task" ? "这个模型不能用于任务" : "这个模型不能用于问答";
    case "byok_builtin_only":
      return "本事项用律所自带密钥或私有模型端点，只能用内置的 K3 或 K2.6";
    default:
      return "没有这个模型（可能已下线）";
  }
}

export type RefreshResult = "updated" | "unchanged" | "stale" | "invalid" | "failed" | "no_source" | "throttled";

export interface ModelCatalogDeps {
  /** 取一次目录（控制面签名信封原样）；没有控制面（开发形态 / 试用版 / 待激活）= null，只用内置两项。 */
  pull: (() => Promise<unknown>) | null;
  /** 验签并取出文档（信封种类 kwl-model-catalog）；不合法 null。 */
  open: (envelope: unknown) => unknown | null;
  tenantId: string;
  /** 缓存文件（存原信封与取到的时刻）；null = 只在内存。 */
  cacheFile: string | null;
  now?: () => number;
  /** 采用了新目录（含读回缓存）之后（内核据此更新模型路由）。 */
  onChange?: (doc: ModelCatalogDoc | null) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface ModelChoiceView extends CatalogModel {
  /** 不可用原因的中文说明（可用时为 null）。 */
  reason_text: string | null;
}

export class ModelCatalogService {
  private readonly d: ModelCatalogDeps;
  private doc: ModelCatalogDoc | null = null;
  private fetchedAt: number | null = null;
  private source: "builtin" | "cloud" | "cache" = "builtin";
  private inflight: Promise<RefreshResult> | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;

  constructor(d: ModelCatalogDeps) {
    this.d = d;
    this.loadCache();
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private loadCache(): void {
    if (!this.d.cacheFile || !this.d.pull) return;
    try {
      const raw = JSON.parse(readFileSync(this.d.cacheFile, "utf8")) as { envelope?: unknown; fetched_at?: unknown };
      const body = this.d.open(raw.envelope);
      const doc = body ? sanitizeCatalog(body, this.d.tenantId) : null;
      if (!doc) return;
      this.doc = doc;
      this.source = "cache";
      this.fetchedAt = typeof raw.fetched_at === "string" && Number.isFinite(Date.parse(raw.fetched_at)) ? Date.parse(raw.fetched_at) : null;
      this.d.onChange?.(doc);
    } catch {
      // 没有缓存或读不出：按内置两项，等联网取
    }
  }

  private saveCache(envelope: unknown): void {
    if (!this.d.cacheFile) return;
    try {
      mkdirSync(dirname(this.d.cacheFile), { recursive: true });
      const tmp = `${this.d.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, envelope, fetched_at: new Date(this.now()).toISOString() }), { mode: 0o600 });
      renameSync(tmp, this.d.cacheFile);
    } catch (e) {
      this.d.log?.("KERNEL_MODEL_CATALOG_CACHE_FAILED", { error: String((e as Error)?.message ?? e).slice(0, 120) });
    }
  }

  /** 现在用的目录（没有云端目录时为内置两项）。 */
  models(): readonly CatalogModel[] {
    return this.doc?.models ?? BUILTIN_CATALOG;
  }

  state(): { version: number | null; epoch: string | null; issued_at: string | null; source: "builtin" | "cloud" | "cache"; fetched_at: string | null } {
    return { version: this.doc?.version ?? null, epoch: this.doc?.epoch ?? null, issued_at: this.doc?.issued_at ?? null, source: this.source, fetched_at: this.fetchedAt === null ? null : new Date(this.fetchedAt).toISOString() };
  }

  find(id: string | null | undefined): CatalogModel | null {
    return id ? (this.models().find((m) => m.id === id) ?? null) : null;
  }

  /** 显示名：目录里的；不在目录里但是内置别名的用内置名；都不是为 null。 */
  labelOf(id: string | null | undefined): string | null {
    if (!id) return null;
    return this.models().find((m) => m.id === id)?.label ?? BUILTIN_CATALOG.find((m) => m.id === id)?.label ?? null;
  }

  /** 某入口下这个模型能不能选（任务另要求 tool_use）。 */
  check(id: string, scope: ModelScope): { ok: true; model: CatalogModel } | { ok: false; reason: string; message: string; model: CatalogModel | null } {
    const m = this.models().find((x) => x.id === id) ?? null;
    const fail = (reason: string) => ({ ok: false as const, reason, message: catalogReasonText(reason, scope)!, model: m });
    if (!m) return fail("unknown");
    if (!m.scopes.includes(scope)) return fail(scope === "task" && m.scopes.includes("qa") && !m.capabilities.includes("tool_use") ? "no_tool_use" : "not_in_scope");
    if (scope === "task" && !m.capabilities.includes("tool_use")) return fail("no_tool_use");
    if (!m.available) return fail(m.reason ?? "disabled");
    return { ok: true, model: m };
  }

  /** 某入口的缺省模型：云端缺省（在这个入口可用时）→ 这个入口第一个可用的 → legal/k3。 */
  defaultFor(scope: ModelScope): string {
    const ms = this.models();
    const def = ms.find((m) => m.default)?.id ?? this.doc?.default ?? DEFAULT_MODEL;
    if (this.check(def, scope).ok) return def;
    return ms.find((m) => this.check(m.id, scope).ok)?.id ?? DEFAULT_MODEL;
  }

  /** 某入口的可选列表（含不可用的，标原因；排好序）。 */
  list(scope: ModelScope): ModelChoiceView[] {
    const def = this.defaultFor(scope);
    return this.models()
      .filter((m) => m.scopes.includes(scope))
      .map((m) => {
        const c = this.check(m.id, scope);
        return { ...m, efforts: [...m.efforts], capabilities: [...m.capabilities], scopes: [...m.scopes], default: m.id === def, available: c.ok, reason: c.ok ? null : ((m.reason ?? null) as CatalogReason | null), reason_text: c.ok ? null : c.message };
      });
  }

  /**
   * 取一次（单飞）；minIntervalMs 内取过就不再取（网关拒绝触发的刷新用，避免一次失败连发）。失败不抛：离线用最后一版。
   */
  refresh(reason: string, opts: { minIntervalMs?: number } = {}): Promise<RefreshResult> {
    if (!this.d.pull) return Promise.resolve("no_source");
    if (this.inflight) return this.inflight;
    if (opts.minIntervalMs && this.now() - this.lastAttemptAt < opts.minIntervalMs) return Promise.resolve("throttled");
    this.lastAttemptAt = this.now();
    const pull = this.d.pull;
    this.inflight = (async (): Promise<RefreshResult> => {
      let envelope: unknown;
      try {
        envelope = await pull();
      } catch (e) {
        this.d.log?.("KERNEL_MODEL_CATALOG_FETCH_FAILED", { reason, code: String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? "").slice(0, 60) });
        return "failed";
      }
      const body = this.d.open(envelope);
      const doc = body ? sanitizeCatalog(body, this.d.tenantId) : null;
      if (!doc) {
        this.d.log?.("KERNEL_MODEL_CATALOG_INVALID", { reason });
        return "invalid";
      }
      if (this.doc && !catalogNewer(doc, this.doc)) {
        // 同一份（同纪元、同版本、同签发时刻）只记取到的时刻；更旧的不采用（只进不退）
        if (doc.epoch === this.doc.epoch && doc.version === this.doc.version && doc.issued_at === this.doc.issued_at) {
          this.fetchedAt = this.now();
          return "unchanged";
        }
        this.d.log?.("KERNEL_MODEL_CATALOG_STALE", { reason, got: doc.version, have: this.doc.version });
        return "stale";
      }
      this.doc = doc;
      this.source = "cloud";
      this.fetchedAt = this.now();
      this.saveCache(envelope);
      this.d.onChange?.(doc);
      return "updated";
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** 定时刷新（缺省 10 分钟；启动后先取一次）。 */
  start(intervalMs = 600_000): void {
    if (!this.d.pull || this.timer) return;
    void this.refresh("startup");
    this.timer = setInterval(() => void this.refresh("timer"), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** 网关拒绝的代码里，哪些说明“所选模型本身”有变化（套餐、停用、未登记、未定价、无可用上游）——收到即刷新目录。 */
export function isModelRejection(codeOrMessage: string | null | undefined): boolean {
  return /\b(model_not_allowed|model_disabled|model_not_routed|price_unconfigured|upstream_unavailable)\b/.test(String(codeOrMessage ?? ""));
}
