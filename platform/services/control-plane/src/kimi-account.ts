/**
 * Kimi 账号对接（第 40 批）：律师用自己的 Kimi 账号登录，绑定到所在律所的席位——用量按 Kimi 账号归属、控制台按账号管理。
 *
 * 流程（OAuth 2.0 设备授权，RFC 8628；与 Kimi Code `kimi login` 同一种授权方式，接口路径相同）：
 *   客户端（设备签名）→ 控制面 `POST /v1/account/kimi/start` → 控制面向 Kimi 账号中心申请设备码 → 客户端显示“验证码 + 打开 Kimi 授权页”
 *   → 律师在浏览器里登录 Kimi 并确认 → 客户端轮询 `POST /v1/account/kimi/poll` → 控制面换到访问令牌、取一次账号信息（/me）→ 绑定席位。
 *
 * 设计取舍：
 * - **令牌不出控制面、也不留存**：控制面只用访问令牌取一次账号信息，随即丢弃；律师电脑上不出现 Kimi 令牌，出站闸门不必放行 Kimi 域名；
 * - **只存账号引用与打码信息**：账号引用 = HMAC(胡椒, Kimi 用户编号) 的前 20 位十六进制（同一账号同一引用，便于去重与对账，但不能反推编号）；
 *   昵称只留首字（其余打码），手机号只留尾号 4 位；不存头像、邮箱、完整手机号；
 * - 同一租户内一个 Kimi 账号只能绑一个席位；绑定、解绑都进律所可见的运营审计流水；
 * - 授权流程只在内存（10 分钟内有效，重启即作废，客户端重新发起即可）；每台设备同时至多 2 个进行中的流程。
 *
 * client_id 须向月之暗面申请法律版自己的 OAuth 客户端（**不得借用 Kimi Code 的 client_id**）；开发与演示用 scripts/dev-kimi-oauth.mjs 模拟账号中心。
 */
import { createHmac, randomBytes } from "node:crypto";

export interface KimiAccountConfig {
  /** Kimi 账号中心（OAuth 主机），例如 https://auth.kimi.com（境外 https://auth.kimi.ai）。 */
  oauth_host: string;
  /** 法律版的 OAuth 客户端编号（向月之暗面申请）。 */
  client_id: string;
  /** 账号信息接口的基地址，例如 https://api.kimi.com/coding/v1（取 `${api_base}/me`）。 */
  api_base: string;
  /** 账号信息路径（缺省 /me）。 */
  userinfo_path?: string;
  /** 上游请求超时（毫秒，缺省 8000）。 */
  timeout_ms?: number;
}

export interface KimiBinding {
  /** 账号引用（HMAC，不可反推 Kimi 用户编号）。 */
  ref: string;
  /** 打码昵称（只留首字）。 */
  nickname: string;
  /** 手机尾号（4 位；账号没有手机号为 null）。 */
  phone_tail: string | null;
  /** Kimi 会员等级名（例如 Vivace；没有为 null）——只用于控制台识别，不参与计费。 */
  level: string | null;
  bound_at: string;
}

export type KimiPollResult = { status: "pending" | "slow_down" | "expired" | "denied" } | { status: "authorized"; account: Omit<KimiBinding, "bound_at"> };

export class KimiAccountError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Flow {
  owner: string;
  device_code: string;
  expires: number;
  interval_ms: number;
  next_poll: number;
}

const FLOW_TTL_MAX_MS = 10 * 60_000;
const MAX_FLOWS = 10_000;
const MAX_FLOWS_PER_OWNER = 2;

export function validateKimiConfig(raw: unknown): KimiAccountConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") throw new Error("kimi_account 须为对象");
  const c = raw as Record<string, unknown>;
  const url = (k: string) => {
    const v = c[k];
    if (typeof v !== "string") throw new Error(`kimi_account.${k} 须为 https 地址`);
    const u = new URL(v);
    const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (!(u.protocol === "https:" || (loop && u.protocol === "http:"))) throw new Error(`kimi_account.${k} 须为 https 地址`);
    return v.replace(/\/+$/, "");
  };
  if (typeof c.client_id !== "string" || !/^[A-Za-z0-9._-]{4,128}$/.test(c.client_id)) throw new Error("kimi_account.client_id 不合法");
  if (c.client_id === "17e5f671-d194-4dfb-9706-5516cb48c098") throw new Error("kimi_account.client_id 是 Kimi Code 的客户端编号：须用法律版自己向月之暗面申请的编号");
  const path = c.userinfo_path === undefined ? "/me" : c.userinfo_path;
  if (typeof path !== "string" || !/^\/[A-Za-z0-9/_-]{0,60}$/.test(path)) throw new Error("kimi_account.userinfo_path 不合法");
  const timeout = c.timeout_ms === undefined ? 8000 : c.timeout_ms;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1000 || (timeout as number) > 60_000) throw new Error("kimi_account.timeout_ms 须为 1000–60000");
  return { oauth_host: url("oauth_host"), client_id: c.client_id, api_base: url("api_base"), userinfo_path: path, timeout_ms: timeout as number };
}

/** 昵称打码：只留首字（“张三丰” → “张**”；单字 → “*”）。 */
export function maskNickname(s: string): string {
  const chars = [...s.trim()];
  if (chars.length === 0) return "Kimi 用户";
  if (chars.length === 1) return "*";
  return chars[0] + "*".repeat(Math.min(chars.length - 1, 2));
}

export function createKimiAccountBroker(o: { config: KimiAccountConfig; pepper: Uint8Array; now?: () => number; fetchImpl?: typeof fetch }) {
  const now = o.now ?? Date.now;
  const f = o.fetchImpl ?? fetch;
  const cfg = o.config;
  const flows = new Map<string, Flow>();
  const timeout = cfg.timeout_ms ?? 8000;

  const sweep = () => {
    const t = now();
    for (const [k, v] of flows) if (v.expires <= t) flows.delete(k);
  };
  const call = async (url: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await f(url, { ...init, signal: ac.signal, redirect: "error" });
      let json: Record<string, unknown> = {};
      try {
        const j = (await r.json()) as unknown;
        if (j && typeof j === "object") json = j as Record<string, unknown>;
      } catch {
        json = {};
      }
      return { status: r.status, json };
    } catch {
      throw new KimiAccountError(502, "kimi_unreachable", "连不上 Kimi 账号中心，请稍后再试");
    } finally {
      clearTimeout(timer);
    }
  };
  const form = (body: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const refOf = (userId: string) => `kimi_${createHmac("sha256", o.pepper).update(`kimi-account\u0000${userId}`).digest("hex").slice(0, 20)}`;

  return {
    config: cfg,
    /** 发起授权：返回验证码与授权页地址（客户端显示、并用系统浏览器打开）。 */
    async start(owner: string): Promise<{ flow_id: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_at: string; interval: number }> {
      sweep();
      if (flows.size >= MAX_FLOWS) throw new KimiAccountError(429, "kimi_busy", "登录请求过多，请稍后再试");
      const mine = [...flows.entries()].filter(([, v]) => v.owner === owner);
      // 同一设备至多 2 个进行中的流程：再发起时丢弃最早的一个
      if (mine.length >= MAX_FLOWS_PER_OWNER) flows.delete(mine.sort((a, b) => a[1].expires - b[1].expires)[0]![0]);
      const r = await call(`${cfg.oauth_host}/api/oauth/device_authorization`, form({ client_id: cfg.client_id }));
      const j = r.json;
      if (r.status !== 200 || typeof j.device_code !== "string" || typeof j.user_code !== "string" || typeof j.verification_uri_complete !== "string") {
        throw new KimiAccountError(502, "kimi_start_failed", "Kimi 账号中心暂时不能发起登录，请稍后再试");
      }
      const vuc = String(j.verification_uri_complete);
      // 授权页只认与账号中心同源、或 kimi.com / kimi.ai 下的 https 地址（防止上游被劫持时把律师引到别处）；客户端主进程另有同样的白名单
      let trusted = false;
      try {
        const u = new URL(vuc);
        const host = u.hostname;
        trusted = !u.username && !u.password && (u.origin === new URL(cfg.oauth_host).origin || (u.protocol === "https:" && (host === "kimi.com" || host.endsWith(".kimi.com") || host === "kimi.ai" || host.endsWith(".kimi.ai"))));
      } catch {
        trusted = false;
      }
      if (!trusted) throw new KimiAccountError(502, "kimi_start_failed", "Kimi 账号中心返回的授权页地址不可信");
      const ttl = Math.min(FLOW_TTL_MAX_MS, Math.max(60_000, (Number(j.expires_in) || 600) * 1000));
      const interval = Math.min(30, Math.max(2, Number(j.interval) || 5));
      const id = `kf_${randomBytes(16).toString("base64url")}`;
      const t = now();
      flows.set(id, { owner, device_code: j.device_code, expires: t + ttl, interval_ms: interval * 1000, next_poll: t + interval * 1000 });
      return { flow_id: id, user_code: j.user_code, verification_uri: typeof j.verification_uri === "string" ? j.verification_uri : vuc, verification_uri_complete: vuc, expires_at: new Date(t + ttl).toISOString(), interval };
    },
    /** 轮询：未到间隔不打上游（直接回 pending）；授权成功即取账号信息、丢弃令牌、结束流程。 */
    async poll(flowId: unknown, owner: string): Promise<KimiPollResult> {
      sweep();
      const fl = typeof flowId === "string" ? flows.get(flowId) : undefined;
      if (!fl || fl.owner !== owner) return { status: "expired" };
      const t = now();
      if (t < fl.next_poll) return { status: "pending" };
      fl.next_poll = t + fl.interval_ms;
      const r = await call(`${cfg.oauth_host}/api/oauth/token`, form({ client_id: cfg.client_id, device_code: fl.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }));
      const tok = r.json.access_token;
      if (r.status === 200 && typeof tok === "string" && tok.length > 0) {
        flows.delete(flowId as string);
        const me = await call(`${cfg.api_base}${cfg.userinfo_path ?? "/me"}`, { method: "GET", headers: { authorization: `Bearer ${tok}`, accept: "application/json" } });
        const uid = me.json.user_id ?? me.json.userId ?? me.json.global_id;
        if (me.status !== 200 || typeof uid !== "string" || uid.length === 0 || uid.length > 200) throw new KimiAccountError(502, "kimi_userinfo_failed", "取不到 Kimi 账号信息，请重新登录");
        const phone = me.json.phone as { number?: unknown } | undefined;
        const digits = typeof phone?.number === "string" ? phone.number.replace(/\D/g, "") : "";
        const nick = typeof me.json.nickname === "string" ? me.json.nickname : "";
        const level = typeof me.json.user_level_name === "string" && /^[\w一-鿿 ]{1,24}$/.test(me.json.user_level_name) ? me.json.user_level_name : null;
        return { status: "authorized", account: { ref: refOf(uid), nickname: maskNickname(nick), phone_tail: digits.length >= 4 ? digits.slice(-4) : null, level } };
      }
      const code = typeof r.json.error === "string" ? r.json.error : "";
      if (code === "authorization_pending") return { status: "pending" };
      if (code === "slow_down") {
        fl.interval_ms = Math.min(30_000, fl.interval_ms + 5000);
        fl.next_poll = t + fl.interval_ms;
        return { status: "slow_down" };
      }
      flows.delete(flowId as string);
      if (code === "access_denied") return { status: "denied" };
      if (code === "expired_token") return { status: "expired" };
      throw new KimiAccountError(502, "kimi_poll_failed", "Kimi 账号中心返回了无法识别的结果，请重新登录");
    },
    /** 进行中的流程数（指标与用例）。 */
    pending(): number {
      sweep();
      return flows.size;
    },
  };
}

export type KimiAccountBroker = ReturnType<typeof createKimiAccountBroker>;
