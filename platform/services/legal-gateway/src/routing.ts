/**
 * 动态路由表（V19 第 44 批，主文 §3）。
 *
 * - 路由由运营在控制台配，经控制面签名订阅 `GET {cp}/v1/feed/routing`（信封 `kwl-routing-feed`）下发；网关每 15 秒取一次，
 *   按 version 原子替换（整表建好再换，旧版本号回放拒收）；取不到沿用上一版；从未取到 = 本机配置的兜底（`upstream` 段 + 别名映射）。
 * - 流量去向不能被控制面单方面改：网关本机配置上游主机白名单 `allow_hosts`（主机名精确匹配），名单外的上游 `blocked_by_allowlist`，不用。
 * - 上游密钥在浏览器里用网关路由公钥加密（ECDH-P256 + HKDF-SHA256 + AES-256-GCM），控制面只存密文；网关用路由私钥解封，
 *   明文只在上游客户端实例的私有字段里——不进快照、日志、计量、指标、错误信息。解不开 = `key_unusable`，不用。
 *   `use_local_key: true` 且无密文 = 用本机 `upstream.api_key_file` 那把（部署方只把密钥放服务器文件时）。
 */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { openEnvelope } from "@zr-legal/firm-trust";
import { OpenAICompatProvider, type ChatProvider } from "./providers.ts";
import type { PriceItem, PriceTable, Rates } from "./usage.ts";

// ─── 上游密钥封装 ───

export const SEAL_ALG = "ECDH-P256+HKDF-SHA256+A256GCM";
const SEAL_LABEL = "kwl-upstream-key/1";

export interface SealedKey {
  alg: typeof SEAL_ALG;
  kid: string;
  /** base64url，65 字节未压缩点。 */
  epk: string;
  /** base64url，12 字节。 */
  iv: string;
  /** base64url，密文 + 16 字节标签。 */
  ct: string;
}

function pointOf(pub: KeyObject): Buffer {
  const j = pub.export({ format: "jwk" }) as { x?: string; y?: string };
  return Buffer.concat([Buffer.from([4]), Buffer.from(String(j.x), "base64url"), Buffer.from(String(j.y), "base64url")]);
}

function keyFromPoint(p: Buffer): KeyObject {
  if (p.length !== 65 || p[0] !== 4) throw new Error("epk_malformed");
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: p.subarray(1, 33).toString("base64url"), y: p.subarray(33).toString("base64url") }, format: "jwk" });
}

function isP256(k: KeyObject): boolean {
  return k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails?.namedCurve === "prime256v1";
}

function aeadKey(shared: Buffer, providerId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(SEAL_LABEL, "utf8"), Buffer.from(providerId, "utf8"), 32));
}

const aadOf = (providerId: string) => Buffer.from(`${SEAL_LABEL}\n${providerId}`, "utf8");

/** 路由密钥编号：公钥 SPKI（DER）的 SHA-256 前 16 位十六进制。参数为公钥、私钥或 SPKI base64。 */
export function routingKeyId(key: KeyObject | string): string {
  let pub: KeyObject;
  if (typeof key === "string") pub = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
  else if (key.type === "private") {
    const { kty, crv, x, y } = key.export({ format: "jwk" });
    pub = createPublicKey({ key: { kty: String(kty), crv: String(crv), x: String(x), y: String(y) }, format: "jwk" });
  } else pub = key;
  return createHash("sha256").update(pub.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16);
}

/** 封装上游密钥（Node 端：用例与运维脚本用；控制台在浏览器里用同一算法另写）。 */
export function sealUpstreamKey(plaintext: string, providerId: string, spkiB64: string): SealedKey {
  const recipient = createPublicKey({ key: Buffer.from(spkiB64, "base64"), format: "der", type: "spki" });
  if (!isP256(recipient)) throw new Error("路由公钥须为 P-256");
  const eph = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aeadKey(shared, providerId), iv, { authTagLength: 16 });
  c.setAAD(aadOf(providerId));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final(), c.getAuthTag()]);
  return { alg: SEAL_ALG, kid: routingKeyId(recipient), epk: pointOf(eph.publicKey).toString("base64url"), iv: iv.toString("base64url"), ct: ct.toString("base64url") };
}

/** 解封；失败只给原因代码（不带任何密钥材料）。`expectKid` 给出时密文须是为这把公钥加密的。 */
export function unsealUpstreamKey(sealed: unknown, providerId: string, privateKey: KeyObject, expectKid?: string): { ok: true; key: string } | { ok: false; reason: string } {
  const s = sealed as Partial<SealedKey> | null;
  if (!s || typeof s !== "object" || s.alg !== SEAL_ALG || typeof s.epk !== "string" || typeof s.iv !== "string" || typeof s.ct !== "string" || typeof s.kid !== "string") return { ok: false, reason: "sealed_malformed" };
  if (expectKid && s.kid !== expectKid) return { ok: false, reason: "kid_mismatch" };
  try {
    const iv = Buffer.from(s.iv, "base64url");
    const ct = Buffer.from(s.ct, "base64url");
    if (iv.length !== 12 || ct.length < 17) return { ok: false, reason: "sealed_malformed" };
    const shared = diffieHellman({ privateKey, publicKey: keyFromPoint(Buffer.from(s.epk, "base64url")) });
    const d = createDecipheriv("aes-256-gcm", aeadKey(shared, providerId), iv, { authTagLength: 16 });
    d.setAAD(aadOf(providerId));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const key = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
    // 进 Authorization 头：空白、控制字符（头注入）、过长一律不收
    if (!key || key.length > 4096 || /[\u0000- \u007f]/.test(key)) return { ok: false, reason: "key_invalid" };
    return { ok: true, key };
  } catch {
    return { ok: false, reason: "unseal_failed" };
  }
}

// ─── 路由表 ───

export interface RouteTarget {
  provider: string;
  model: string;
  priority: number;
}

/** 别名 → 上游与型号（别名不改名；路由只改它背后的目标）。 */
export interface ModelRoute {
  label: string;
  enabled: boolean;
  isDefault: boolean;
  /** 按 priority 升序（小者先）。 */
  targets: readonly RouteTarget[];
  allowCrossVendor: boolean;
  /** 未给 max_tokens 时的预占输出 token。 */
  defaultMaxTokens: number;
}

/** 上游在本机的可用性（静态判定；熔断与延迟另见 upstreams.ts）。 */
export type ProviderState = "ok" | "disabled" | "blocked_by_allowlist" | "key_unusable";

export interface ProviderEntry {
  id: string;
  label: string;
  vendor: string;
  host: string;
  enabled: boolean;
  state: ProviderState;
  /** state 为 ok 时才有。 */
  client: ChatProvider | null;
  maxConcurrency: number;
  headerTimeoutMs: number | null;
  idleTimeoutMs: number | null;
  probeRequestedAt: string | null;
  /** 地址与密钥的摘要（地址或密钥换了即重置健康状态；不可逆，不外送）。 */
  fingerprint: string;
}

export interface RoutingSnapshot {
  /** 订阅版本；兜底与静态为 null。 */
  version: number | null;
  source: "feed" | "fallback" | "static" | "none";
  issuedAt: string | null;
  providers: ReadonlyMap<string, ProviderEntry>;
  models: ReadonlyMap<string, ModelRoute>;
  /** 价目；兜底与静态为 null（cny 租户此时一律 price_unconfigured）。 */
  prices: PriceTable | null;
}

export interface RoutingView {
  current(): RoutingSnapshot;
}

/** 本机兜底与静态路由里的上游编号。 */
export const LOCAL_PROVIDER = "local";

const localRoute = (model: string, label: string, isDefault = false): ModelRoute =>
  Object.freeze({ label, enabled: true, isDefault, targets: Object.freeze([{ provider: LOCAL_PROVIDER, model, priority: 0 }]), allowCrossVendor: false, defaultMaxTokens: 8192 });

/**
 * 客户端写死的两个别名指向本机上游（订阅取不到时的兜底）。第 72 批（D-299）：与控制面缺省路由、部署模板同口径——
 * legal/k3 → kimi-k3.1-pro（原为 kimi-k3）、legal/k2.6 → kimi-k2.6。K2.6 的思考参数由客户端按 toggle 发 thinking:{type}，K3 按 effort 发 reasoning_effort，网关原样转发。
 */
export const DEFAULT_ROUTES: Readonly<Record<string, ModelRoute>> = Object.freeze({
  "legal/k3": localRoute("kimi-k3.1-pro", "K3", true),
  "legal/k2.6": localRoute("kimi-k2.6", "K2.6"),
});

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * 按部署环境改写上游模型标识（第 28 批；第 44 批起只作订阅取不到时的兜底与开发、试用形态）：KWL_UPSTREAM_K3 / KWL_UPSTREAM_K26 未设置即用缺省；
 * 只接受 MaaS 型号的字符集，防止把别的东西拼进请求体。
 */
export function routesFromEnv(env: Record<string, string | undefined>, base: Readonly<Record<string, ModelRoute>> = DEFAULT_ROUTES): Readonly<Record<string, ModelRoute>> {
  const overrides: [string, string | undefined][] = [
    ["legal/k3", env.KWL_UPSTREAM_K3],
    ["legal/k2.6", env.KWL_UPSTREAM_K26],
  ];
  const out: Record<string, ModelRoute> = { ...base };
  for (const [alias, model] of overrides) {
    if (!model) continue;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(model)) throw new Error(`上游模型标识格式不对：${alias}`);
    const r = base[alias]!;
    out[alias] = Object.freeze({ ...r, targets: Object.freeze(r.targets.map((t, i) => (i === 0 ? { ...t, model } : t))) });
  }
  return Object.freeze(out);
}

const fp = (...parts: string[]) => createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);

type StaticProvider = ChatProvider | { client: ChatProvider; vendor?: string; label?: string; enabled?: boolean; maxConcurrency?: number; headerTimeoutMs?: number; idleTimeoutMs?: number };

/** 静态路由（开发、试用版本机网关、用例）：不订阅、不核白名单（本机配置即可信）。 */
export function staticRouting(o: { providers: Readonly<Record<string, StaticProvider>>; routes: Readonly<Record<string, ModelRoute>>; prices?: PriceTable | null }): RoutingView {
  const providers = new Map<string, ProviderEntry>();
  for (const [id, p] of Object.entries(o.providers)) {
    const spec = "chat" in p ? { client: p } : p;
    const enabled = spec.enabled ?? true;
    providers.set(id, {
      id,
      label: spec.label ?? id,
      vendor: spec.vendor ?? id,
      host: "",
      enabled,
      state: enabled ? "ok" : "disabled",
      client: enabled ? spec.client : null,
      maxConcurrency: spec.maxConcurrency ?? 64,
      headerTimeoutMs: spec.headerTimeoutMs ?? null,
      idleTimeoutMs: spec.idleTimeoutMs ?? null,
      probeRequestedAt: null,
      fingerprint: fp("static", id),
    });
  }
  const snap: RoutingSnapshot = { version: null, source: "static", issuedAt: null, providers, models: new Map(Object.entries(o.routes)), prices: o.prices ?? null };
  return { current: () => snap };
}

// ─── 订阅 ───

export interface RoutingFallback {
  baseUrl: string;
  apiKey: string;
  routes: Readonly<Record<string, ModelRoute>>;
}

export interface RoutingFeedOptions {
  /** 控制面路由订阅地址（…/v1/feed/routing）。 */
  url: string;
  serviceSecret: string;
  /** 控制面信封公钥（与网关订阅同一份 control_plane.keys_file）。 */
  keys: ReadonlyMap<string, KeyObject>;
  /** 网关路由私钥（P-256）：解封上游密钥；null = 只能用 use_local_key 的上游。 */
  routingKey: KeyObject | null;
  /** 上游主机白名单（主机名精确匹配，大小写不敏感）。 */
  allowHosts: readonly string[];
  /** 从未取到订阅时的兜底（本机 upstream 段）；null = 没有兜底（取到订阅前一律 503）。 */
  fallback?: RoutingFallback | null;
  /** `use_local_key` 用的本机密钥（缺省取 fallback.apiKey）。 */
  localKey?: string | null;
  fetchImpl?: typeof fetch;
  /** 上游客户端用的 fetch（用例注入）。 */
  providerFetch?: typeof fetch;
  /** 只许测试：上游地址可以是 http。 */
  allowHttp?: boolean;
  timeoutMs?: number;
  minRefreshMs?: number;
}

const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9._/-]{1,47}$/;
const VENDOR_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

const str = (v: unknown, max: number, dflt: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : dflt);
const intIn = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : null);
const priceNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e7 ? v : null);

export class RoutingFeedSubscriber implements RoutingView {
  private readonly o: RoutingFeedOptions;
  private readonly allow: ReadonlySet<string>;
  private readonly ownKid: string | null;
  private snap: RoutingSnapshot;
  private lastOkAt = 0;
  private lastFetch = 0;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners: ((s: RoutingSnapshot) => void)[] = [];
  /** 统计（运维）：成功换表、未变、失败（不可达 / 非 2xx）、拒收（验签不过、格式不对、版本回退）、丢弃的不合法条目。 */
  readonly stats = { ok: 0, unchanged: 0, failed: 0, rejected: 0, droppedEntries: 0 };

  constructor(o: RoutingFeedOptions) {
    this.o = o;
    this.allow = new Set(o.allowHosts.map((h) => h.toLowerCase()));
    this.ownKid = o.routingKey ? routingKeyId(o.routingKey) : null;
    this.snap = this.fallbackSnapshot();
  }

  current(): RoutingSnapshot {
    return this.snap;
  }

  get version(): number | null {
    return this.snap.version;
  }

  /** 最近一次成功取得并接受订阅的时刻（毫秒；0 = 从未）。 */
  get lastOk(): number {
    return this.lastOkAt;
  }

  /** 换表后通知（健康模块据此对 probe_requested_at 更新的上游立即探测）。 */
  onChange(fn: (s: RoutingSnapshot) => void): void {
    this.listeners.push(fn);
  }

  private fallbackSnapshot(): RoutingSnapshot {
    const f = this.o.fallback;
    if (!f) return { version: null, source: "none", issuedAt: null, providers: new Map(), models: new Map(), prices: null };
    const host = (() => {
      try {
        return new URL(f.baseUrl).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const entry: ProviderEntry = {
      id: LOCAL_PROVIDER,
      label: "本机兜底上游",
      vendor: LOCAL_PROVIDER,
      host,
      enabled: true,
      state: "ok",
      client: new OpenAICompatProvider({ baseUrl: f.baseUrl, apiKey: f.apiKey, name: LOCAL_PROVIDER, ...(this.o.providerFetch ? { fetchImpl: this.o.providerFetch } : {}) }),
      maxConcurrency: 64,
      headerTimeoutMs: null,
      idleTimeoutMs: null,
      probeRequestedAt: null,
      fingerprint: fp("fallback", f.baseUrl, createHash("sha256").update(f.apiKey).digest("hex")),
    };
    return { version: null, source: "fallback", issuedAt: null, providers: new Map([[LOCAL_PROVIDER, entry]]), models: new Map(Object.entries(f.routes)), prices: null };
  }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (Date.now() - this.lastFetch < (this.o.minRefreshMs ?? 1000)) return Promise.resolve();
    this.inflight = this.fetchOnce().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchOnce(): Promise<void> {
    this.lastFetch = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 10_000);
    try {
      const r = await (this.o.fetchImpl ?? globalThis.fetch)(this.o.url, { headers: { authorization: `Bearer ${this.o.serviceSecret}` }, signal: ac.signal, redirect: "error" });
      if (!r.ok) {
        this.stats.failed += 1;
        await r.body?.cancel().catch(() => {});
        return;
      }
      const opened = openEnvelope<Record<string, unknown>>(await r.json(), "kwl-routing-feed", this.o.keys);
      if (!opened.ok) {
        this.stats.rejected += 1;
        return;
      }
      const b = opened.body;
      const version = b?.version;
      if (!b || typeof b !== "object" || !Number.isSafeInteger(version) || (version as number) < 1 || !Array.isArray(b.providers) || !Array.isArray(b.models)) {
        this.stats.rejected += 1;
        return;
      }
      const cur = this.snap.source === "feed" ? (this.snap.version ?? 0) : 0;
      // 版本只进不退（回放的旧路由表不能把流量改回去）；同版本不重建
      if ((version as number) < cur) {
        this.stats.rejected += 1;
        return;
      }
      this.lastOkAt = Date.now();
      if ((version as number) === cur) {
        this.stats.unchanged += 1;
        return;
      }
      const next = this.build(version as number, b);
      this.snap = next;
      this.stats.ok += 1;
      for (const fn of this.listeners) {
        try {
          fn(next);
        } catch {
          // 监听方的异常不影响换表
        }
      }
    } catch {
      this.stats.failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 整表建好再返回（调用方一次赋值完成替换）。 */
  private build(version: number, b: Record<string, unknown>): RoutingSnapshot {
    const providers = new Map<string, ProviderEntry>();
    const localKey = this.o.localKey ?? this.o.fallback?.apiKey ?? null;
    for (const raw of b.providers as unknown[]) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const id = p.id;
      if (typeof id !== "string" || !PROVIDER_ID_RE.test(id) || providers.has(id) || typeof p.enabled !== "boolean") {
        this.stats.droppedEntries += 1;
        continue;
      }
      let url: URL;
      try {
        url = new URL(String(p.base_url));
      } catch {
        this.stats.droppedEntries += 1;
        continue;
      }
      const protoOk = url.protocol === "https:" || (this.o.allowHttp === true && url.protocol === "http:");
      if (!protoOk || url.username || url.password || url.search || url.hash) {
        this.stats.droppedEntries += 1;
        continue;
      }
      const host = url.hostname.toLowerCase();
      const baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
      const vendor = typeof p.vendor === "string" && VENDOR_RE.test(p.vendor) ? p.vendor : id;
      let state: ProviderState = "ok";
      let key: string | null = null;
      if (!this.allow.has(host)) state = "blocked_by_allowlist";
      else if (!p.enabled) state = "disabled";
      else if (p.key_sealed && typeof p.key_sealed === "object") {
        const u = this.o.routingKey ? unsealUpstreamKey(p.key_sealed, id, this.o.routingKey, this.ownKid ?? undefined) : null;
        if (u?.ok) key = u.key;
        else state = "key_unusable";
      } else if (p.use_local_key === true && localKey) key = localKey;
      else state = "key_unusable";
      const headerTimeoutMs = intIn(p.header_timeout_ms, 1_000, 900_000);
      const idleTimeoutMs = intIn(p.idle_timeout_ms, 1_000, 900_000);
      providers.set(id, {
        id,
        label: str(p.label, 64, id),
        vendor,
        host,
        enabled: p.enabled,
        state,
        client: state === "ok" && key ? new OpenAICompatProvider({ baseUrl, apiKey: key, name: id, ...(this.o.providerFetch ? { fetchImpl: this.o.providerFetch } : {}) }) : null,
        maxConcurrency: intIn(p.max_concurrency, 1, 4096) ?? 64,
        headerTimeoutMs,
        idleTimeoutMs,
        probeRequestedAt: typeof p.probe_requested_at === "string" && Number.isFinite(Date.parse(p.probe_requested_at)) ? p.probe_requested_at : null,
        fingerprint: fp("feed", baseUrl, key ? createHash("sha256").update(key).digest("hex") : state),
      });
    }
    const models = new Map<string, ModelRoute>();
    let hasDefault = false;
    for (const raw of b.models as unknown[]) {
      const m = (raw ?? {}) as Record<string, unknown>;
      const alias = m.alias;
      if (typeof alias !== "string" || !ALIAS_RE.test(alias) || models.has(alias) || typeof m.enabled !== "boolean" || !Array.isArray(m.targets) || m.targets.length > 4) {
        this.stats.droppedEntries += 1;
        continue;
      }
      const targets: RouteTarget[] = [];
      let bad = false;
      for (const t of m.targets as unknown[]) {
        const tt = (t ?? {}) as Record<string, unknown>;
        const priority = intIn(tt.priority, -1_000_000, 1_000_000);
        if (typeof tt.provider !== "string" || !PROVIDER_ID_RE.test(tt.provider) || typeof tt.model !== "string" || !MODEL_RE.test(tt.model) || priority === null) bad = true;
        else targets.push({ provider: tt.provider, model: tt.model, priority });
      }
      if (bad) {
        this.stats.droppedEntries += 1;
        continue;
      }
      targets.sort((x, y) => x.priority - y.priority);
      const isDefault = m.is_default === true && !hasDefault;
      if (isDefault) hasDefault = true;
      models.set(alias, Object.freeze({ label: str(m.label, 64, alias), enabled: m.enabled, isDefault, targets: Object.freeze(targets), allowCrossVendor: m.allow_cross_vendor === true, defaultMaxTokens: intIn(m.default_max_tokens, 1, 1_000_000) ?? 8192 }));
    }
    let prices: PriceTable | null = null;
    const pr = b.prices as Record<string, unknown> | null | undefined;
    if (pr && typeof pr === "object" && (typeof pr.version === "number" || typeof pr.version === "string") && pr.items && typeof pr.items === "object") {
      const items: Record<string, PriceItem> = {};
      for (const [alias, v] of Object.entries(pr.items as Record<string, unknown>)) {
        if (!ALIAS_RE.test(alias) || !v || typeof v !== "object") continue;
        const x = v as Record<string, unknown>;
        items[alias] = { input: priceNum(x.input), cached_input: priceNum(x.cached_input), output: priceNum(x.output), cost_input: priceNum(x.cost_input), cost_cached_input: priceNum(x.cost_cached_input), cost_output: priceNum(x.cost_output) };
      }
      // 第 62 批：按上游型号的生效价（basis = model）；形状不对的型号跳过（按未定价处理，金额套餐即 price_unconfigured，不按 0 元放行）
      const rates = (v: unknown): Rates | null => {
        if (!v || typeof v !== "object") return null;
        const x = v as Record<string, unknown>;
        return { input: priceNum(x.input), cached_input: priceNum(x.cached_input), cache_write: priceNum(x.cache_write), cache_write_1h: priceNum(x.cache_write_1h), output: priceNum(x.output) };
      };
      const models: Record<string, { sale: Rates; cost: Rates }> = {};
      if (pr.basis === "model" && pr.models && typeof pr.models === "object") {
        for (const [m, v] of Object.entries(pr.models as Record<string, unknown>)) {
          if (!MODEL_RE.test(m) || !v || typeof v !== "object") continue;
          const sale = rates((v as Record<string, unknown>).sale);
          const cost = rates((v as Record<string, unknown>).cost);
          if (sale && cost) models[m] = { sale, cost };
        }
      }
      prices = { version: pr.version, effective_at: typeof pr.effective_at === "string" ? pr.effective_at : null, items, ...(pr.basis === "model" ? { basis: "model" as const, models } : {}) };
    }
    return { version, source: "feed", issuedAt: typeof b.issued_at === "string" ? b.issued_at : null, providers, models, prices };
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => {
      this.lastFetch = 0;
      void this.refresh();
    }, Math.max(1000, intervalMs));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
