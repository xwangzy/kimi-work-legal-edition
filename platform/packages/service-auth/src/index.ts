/**
 * 内部能力令牌（方案 v4.0 第 4 篇 §4.2：每个请求带短期令牌，绑定租户、席位、事项、任务、尝试 ID；
 * 拒绝模型或客户端自报身份）。
 *
 * v0 开发形态：`zrt1.<b64url(claims)>.<b64url(hmac-sha256)>`，共享密钥来自环境变量。
 * 生产替换为 OAuth/OIDC + 短期能力令牌（远程 MCP 强制），此处接口保持稳定。
 * 注意：gateway 只信令牌 claims，不信请求体里的 tenant/matter 字段。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { slog } from "@zr-legal/safe-log";

export interface CapabilityClaims {
  tid: string; // tenant
  uid: string; // user / seat
  mid?: string | undefined; // matter
  rid?: string | undefined; // run
  aid?: string | undefined; // attempt
  /** 尝试纪元（fencing，v9 第 04 篇 §8）：端点按当前尝试行的 fence_token 比对，失去租约即失效。 */
  fen?: number | undefined;
  /** 令牌 ID（= Agent 任务 ID）：宿主退出等事件按 jti 撤销。 */
  jti?: string | undefined;
  /** 工具令牌授予的副作用类别（缺省只允许 read；端点独立强制，阶段 1 审查 R-09）。 */
  fx?: string[] | undefined;
  /** 任务用途（运行意图；端点按清单的 purposes 独立校验）。 */
  pur?: string | undefined;
  scope: string[]; // e.g. ["tool:legal"], ["model:chat"]
  exp: number; // unix seconds
}

const PREFIX = "zrt1.";

function b64url(buf: Buffer | string): string {
  return (typeof buf === "string" ? Buffer.from(buf, "utf8") : buf).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

export function issueToken(claims: Omit<CapabilityClaims, "exp">, secret: string, ttlSeconds = 900): string {
  const full: CapabilityClaims = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payload = b64url(JSON.stringify(full));
  return `${PREFIX}${payload}.${sign(payload, secret)}`;
}

export class AuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function verifyToken(token: string, secret: string, requiredScope: string): CapabilityClaims {
  if (!token.startsWith(PREFIX)) throw new AuthError("bad token prefix");
  const dot = token.lastIndexOf(".");
  if (dot < 0) throw new AuthError("malformed token");
  const payload = token.slice(PREFIX.length, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AuthError("bad signature");
  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CapabilityClaims;
  } catch {
    throw new AuthError("bad claims");
  }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) throw new AuthError("token expired");
  if (!Array.isArray(claims.scope) || !claims.scope.includes(requiredScope)) {
    throw new AuthError(`missing scope ${requiredScope}`);
  }
  return claims;
}

export function bearerToken(header: string | undefined): string {
  if (!header || !header.startsWith("Bearer ")) throw new AuthError("missing bearer token");
  return header.slice("Bearer ".length).trim();
}

/** 开发密钥：生产（ZR_ENV=production）缺失即拒绝启动；开发缺失用占位密钥并醒目警告。 */
export function requireSecret(envName: string): string {
  const v = process.env[envName];
  if (v && v.length >= 16) return v;
  if (process.env.ZR_ENV === "production") throw new Error(`[service-auth] FATAL: ${envName} 未设置或过短，生产环境拒绝启动`);
  const dev = `dev-only-insecure-${envName}`;
  slog.event("SERVICE_AUTH_DEV_SECRET", {});
  return dev;
}
