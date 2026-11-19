/**
 * 运营控制台 · 接口层（第 44 批；第 45 批加账号密码登录）：配置、带凭据的请求、错误归一、CSV 下载。
 *
 * - 两种凭据：① 账号密码登录得到的会话令牌（Authorization: Bearer kwlops_…；令牌只放 sessionStorage，关标签页即失效）；
 *   ② 运营本人的私钥在本页签名每个请求（ops-sign.js）。都直连控制面 /v1/ops/…，身份与权限都按运营名册核验；
 * - 签名里的路径 p = 实际请求的 pathname + search，**原样**：查询串只用 URLSearchParams 生成一次，签名与 fetch 共用同一个字符串；
 *   POST / PUT / DELETE 不带查询串，DELETE 体为空串；
 * - 错误归一为 ApiError {status, code, message}：控制面的 message 是可直接显示的中文；404 + not_found（或没有错误体）
 *   = 这条接口控制面还没有，记为 code "not_ready"，页面显示“接口未就绪”，**不造替代数据**。
 */
import { signOpsRequest } from "./ops-sign.js";

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const AUTH_ERR = {
  ops_auth_invalid: "运营凭据无效：运营编号、密钥编号与私钥对不上名册，或已被吊销",
  ops_session_invalid: "登录已失效（超时、已退出、密码已被重置或已被吊销）",
  ops_login_invalid: "账号或密码不对",
  password_change_required: "请先修改初始密码",
  ops_auth_stale: "本机时间与服务器相差超过 5 分钟：请校准电脑时间",
  ops_auth_missing: "请求没有带运营签名",
  ops_auth_replayed: "重复的请求（随机数已用过）：请重试",
  ops_permission_denied: "你在运营名册里没有这项权限",
  ops_roster_unavailable: "运营名册暂不可用（过期、回滚或签名不符）：请安全管理员重签名册",
};

const state = { cfg: null, op: null, onAuthLost: null };

/** 读同源的 config.json（部署时由运维写入）。 */
export async function loadConfig() {
  let r;
  try {
    r = await fetch("config.json", { cache: "no-store", credentials: "omit" });
  } catch {
    throw new Error("读不到 config.json");
  }
  if (!r.ok) throw new Error("缺少 config.json（控制面地址与部署标识），请运维按 config.example.json 放好");
  const c = await r.json();
  const base = String(c.control_plane_base ?? "").replace(/\/+$/, "");
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error("config.json 的 control_plane_base 不是合法地址");
  }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (loop && u.protocol === "http:"))) throw new Error("config.json 的 control_plane_base 必须是 https 地址");
  if (u.pathname !== "/" || u.search || u.username) throw new Error("config.json 的 control_plane_base 只写来源（不带路径、查询串与口令）");
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(String(c.deployment ?? ""))) throw new Error("config.json 的 deployment（部署标识）不合法");
  const rpk = typeof c.routing_public_key === "string" && c.routing_public_key.trim() ? c.routing_public_key.trim() : null;
  const rkid = typeof c.routing_key_id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(c.routing_key_id) ? c.routing_key_id : null;
  state.cfg = {
    control_plane_base: u.origin,
    deployment: c.deployment,
    label: typeof c.label === "string" ? c.label.slice(0, 40) : "",
    routing_public_key: rpk,
    routing_key_id: rkid,
    demo: c.demo === true,
  };
  return state.cfg;
}
export const config = () => state.cfg;
/**
 * 当前运营：{via:"password", id, login, token, expires_at, must_change} 或 {via:"key", id, kid, key}。
 */
export const operator = () => state.op;
export function setOperator(op) {
  state.op = op;
}

// ─── 账号密码会话：令牌只放 sessionStorage（每个标签页各一份，关掉即失效；绑定部署与控制面地址） ───
const SESSION_KEY = "kwl-ops-session";
export function saveSession(op) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: op.token, id: op.id, login: op.login, expires_at: op.expires_at, deployment: state.cfg.deployment, base: state.cfg.control_plane_base }));
  } catch {
    /* 浏览器不给 sessionStorage：只在内存，刷新页面需重新登录 */
  }
}
export function recallSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (!s || s.deployment !== state.cfg?.deployment || s.base !== state.cfg?.control_plane_base || !/^kwlops_/.test(String(s.token)) || !(Date.parse(s.expires_at) > Date.now())) {
      forgetSession();
      return null;
    }
    return { via: "password", id: String(s.id), login: String(s.login ?? ""), token: String(s.token), expires_at: String(s.expires_at), must_change: false };
  } catch {
    return null;
  }
}
export function forgetSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* 同上 */
  }
}

/** 账号密码登录（不带凭据）：成功返回运营对象（令牌只在这里出现一次）。 */
export async function passwordLogin(login, password) {
  const cfg = state.cfg;
  if (!cfg) throw new ApiError(0, "no_config", "尚未读到配置");
  const path = "/v1/ops/login";
  let r;
  try {
    r = await fetch(cfg.control_plane_base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login, password }), mode: "cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  } catch {
    throw new ApiError(0, "network", "连不上控制面：检查网络、地址与证书，以及控制面 ops.console_origins 是否含本页来源", { method: "POST", pathOnly: path });
  }
  if (r.status === 404) throw new ApiError(404, "password_login_closed", "控制面没有开账号密码登录（ops.password_login 关闭，或本页所在网段不在运维网段内）：请改用运营私钥登录");
  if (!r.ok) throw await toError(r, "POST", path, { quiet: true });
  const j = await r.json();
  return { via: "password", id: j.operator, login: j.login, token: j.token, expires_at: j.expires_at, idle_ms: j.idle_ms, must_change: j.must_change === true, perms: j.perms ?? [] };
}
/** 退出：吊销会话（尽力而为；失败也照常清掉本页凭据）。 */
export async function logoutSession() {
  const op = state.op;
  if (op?.via !== "password") return;
  try {
    await fetch(state.cfg.control_plane_base + "/v1/ops/logout", { method: "POST", headers: { authorization: `Bearer ${op.token}` }, mode: "cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  } catch {
    /* 控制面连不上：令牌闲置 30 分钟后自然失效 */
  }
}
/** 运营凭据失效（ops_auth_invalid）时回调：回登录页 */
export function onAuthLost(fn) {
  state.onAuthLost = fn;
}

/** path + 查询串：值为空的参数不带；返回的字符串既用于签名也用于请求。 */
export function qs(path, params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") sp.append(k, String(v));
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}
export const seg = (s) => encodeURIComponent(String(s));

async function signedFetch(method, path, body) {
  const { cfg, op } = state;
  if (!cfg || !op) throw new ApiError(0, "no_session", "尚未登录");
  if (method !== "GET" && path.includes("?")) throw new Error("写操作不带查询串");
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = op.via === "password" ? { authorization: `Bearer ${op.token}` } : await signOpsRequest({ deployment: cfg.deployment, audience: "control-plane", operator: op.id, kid: op.kid, key: op.key, method, path, body: raw });
  try {
    return await fetch(cfg.control_plane_base + path, {
      method,
      headers: { ...headers, ...(raw ? { "content-type": "application/json" } : {}) },
      ...(raw ? { body: raw } : {}),
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new ApiError(0, "network", "连不上控制面：检查网络、地址与证书，以及控制面 ops.console_origins 是否含本页来源", { method, pathOnly: path.split("?")[0] });
  }
}

async function toError(r, method, path, o = {}) {
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  const pathOnly = path.split("?")[0];
  const code = json?.error?.code ?? (typeof json?.error === "string" ? json.error : null);
  if (r.status === 404 && (!code || code === "not_found")) return new ApiError(404, "not_ready", `接口未就绪：控制面还没有 ${method} ${pathOnly}`, { method, pathOnly });
  // 锁定、限频、密码规则：控制面的说明更具体（剩余分钟数、缺哪几条），照用
  const own = ["ops_login_locked", "ops_login_throttled", "ops_password_weak", "ops_password_current_wrong", "ops_credentials_unavailable"].includes(code);
  const e = new ApiError(r.status, code ?? `http_${r.status}`, (own ? json?.error?.message : AUTH_ERR[code]) ?? json?.error?.message ?? `请求失败（HTTP ${r.status}）`, { method, pathOnly, detail: json?.error ?? null, rules: json?.rules ?? null });
  if (!o.quiet && (code === "ops_auth_invalid" || code === "ops_session_invalid" || code === "password_change_required")) queueMicrotask(() => state.onAuthLost?.(e));
  return e;
}

export async function call(method, path, body) {
  const r = await signedFetch(method, path, body);
  if (!r.ok) throw await toError(r, method, path);
  if (r.status === 204) return {};
  try {
    return await r.json();
  } catch {
    throw new ApiError(r.status, "bad_json", "控制面回复不是 JSON", { method, pathOnly: path.split("?")[0] });
  }
}
export const get = (path, params) => call("GET", qs(path, params));
export const post = (path, body = {}) => call("POST", path, body);
export const put = (path, body = {}) => call("PUT", path, body);
export const del = (path) => call("DELETE", path);

/** 签名 GET 一个 CSV，存成文件（Blob 链接，不经第三方）。 */
export async function downloadCsv(path, params, filename) {
  const p = qs(path, params);
  const r = await signedFetch("GET", p);
  if (!r.ok) throw await toError(r, "GET", p);
  const blob = await r.blob();
  const url = URL.createObjectURL(new Blob([blob], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 路径小工具 */
export const T = (tid) => `/v1/ops/tenants/${seg(tid)}`;
export const A = (aid) => `/v1/ops/accounts/${seg(aid)}`;
