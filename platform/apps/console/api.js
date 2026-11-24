/**
 * 统一云端控制台 · 接口层（第 46 批，契约 §2–§3）：配置、会话、带凭据的请求、错误归一、复核重试、CSV 下载。
 *
 * - 一套账号：律师、律所管理员、中软平台人员都用邮箱 + 密码登录 POST /v1/auth/login，得 kws1.… 会话令牌；
 *   令牌**只放 sessionStorage**（每个标签页一份，关掉即失效；绑定部署与控制面地址），每个请求 Authorization: Bearer；不用 Cookie；
 * - 401 session_*（失效、过期、未登录）→ onAuthLost 回登录页；
 *   401 reauth_required（危险操作要本会话 10 分钟内复核过）→ onReauth 弹复核框（密码），复核成功后**自动重试原请求一次**；
 *   426（client_outdated）→ onOutdated 显示升级提示；
 * - 错误归一为 ApiError {status, code, message}：控制面的 message 是可直接显示的中文；404 + not_found（或没有错误体）
 *   = 这条接口控制面还没有，记为 code "not_ready"，页面显示“接口未就绪”，**不造替代数据**；
 * - config.json 只读 control_plane_base、label、deployment；旧字段（路由公钥、点数单价、演示标记等）读到忽略。
 */

export const CONSOLE_VERSION = "46.0.0";

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 控制面没给中文说明时的兜底（有 message 的一律用控制面的） */
const FALLBACK = {
  session_required: "请先登录",
  session_invalid: "登录已失效，请重新登录",
  session_expired: "登录已过期，请重新登录",
  reauth_required: "这是敏感操作：请重新输入密码确认后再试",
  reauth_invalid: "密码不正确",
  auth_invalid: "邮箱或密码不正确",
  ops_permission_denied: "你的角色没有这项权限",
  permission_denied: "你的角色没有这项权限",
  firm_role_required: "只有本所管理员或合伙人能查看",
  staff_client_forbidden: "平台人员账号只能在网页控制台登录",
  client_outdated: "版本过旧，请升级",
  rate_limited: "尝试过于频繁，请稍后再试",
};

const state = {
  cfg: null,
  token: null,
  hooks: { onAuthLost: null, onReauth: null, onOutdated: null },
};

// ─── 配置 ───────────────────────────────────────────────────────────
/** 校验并归一 config.json 的内容（纯函数，测试用） */
export function parseConfig(c) {
  const base = String(c?.control_plane_base ?? "").replace(/\/+$/, "");
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error("config.json 的 control_plane_base 不是合法地址");
  }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (loop && u.protocol === "http:"))) throw new Error("config.json 的 control_plane_base 必须是 https 地址");
  if (u.pathname !== "/" || u.search || u.username) throw new Error("config.json 的 control_plane_base 只写来源（不带路径、查询串与用户名密码）");
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(String(c?.deployment ?? ""))) throw new Error("config.json 的 deployment（部署标识）不合法");
  return { control_plane_base: u.origin, deployment: c.deployment, label: typeof c.label === "string" ? c.label.slice(0, 40) : "" };
}
/** 读同源的 config.json（部署时由运维写入） */
export async function loadConfig() {
  let r;
  try {
    r = await fetch("config.json", { cache: "no-store", credentials: "omit" });
  } catch {
    throw new Error("读不到 config.json");
  }
  if (!r.ok) throw new Error("缺少 config.json（控制面地址与部署标识）：请运维按部署手册放好");
  state.cfg = parseConfig(await r.json());
  return state.cfg;
}
export const config = () => state.cfg;
export function setConfig(c) {
  state.cfg = c;
}
export function setHooks(h) {
  Object.assign(state.hooks, h);
}

// ─── 会话：令牌只放 sessionStorage ────────────────────────────────────
const SESSION_KEY = "kwl-console-session";
const store = () => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};
export const token = () => state.token;
export function setToken(t) {
  state.token = t || null;
}
export function saveSession(t, meta = {}) {
  state.token = t;
  try {
    store()?.setItem(SESSION_KEY, JSON.stringify({ token: t, deployment: state.cfg?.deployment, base: state.cfg?.control_plane_base, kind: meta.kind ?? null, email: meta.email ?? null }));
  } catch {
    /* 浏览器不给 sessionStorage：只在内存，刷新页面需重新登录 */
  }
}
export function recallSession() {
  try {
    const s = JSON.parse(store()?.getItem(SESSION_KEY) ?? "null");
    if (!s || s.deployment !== state.cfg?.deployment || s.base !== state.cfg?.control_plane_base || !/^kws1\.[A-Za-z0-9._-]{8,}$/.test(String(s.token))) {
      forgetSession();
      return null;
    }
    state.token = s.token;
    return s;
  } catch {
    return null;
  }
}
export function forgetSession() {
  state.token = null;
  try {
    store()?.removeItem(SESSION_KEY);
  } catch {
    /* 同上 */
  }
}

// ─── 请求 ───────────────────────────────────────────────────────────
/** path + 查询串：值为空的参数不带 */
export function qs(path, params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") sp.append(k, String(v));
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}
export const seg = (s) => encodeURIComponent(String(s));

const NETWORK_MSG = "连不上控制面：检查网络、地址与证书，以及控制面是否允许本页来源";

async function send(method, path, body, o = {}) {
  const cfg = state.cfg;
  if (!cfg) throw new ApiError(0, "no_config", "尚未读到配置");
  const auth = o.auth !== false;
  if (auth && !state.token) throw new ApiError(401, "session_required", "请先登录");
  if (method !== "GET" && path.includes("?")) throw new Error("写操作不带查询串");
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = { ...(auth ? { authorization: `Bearer ${state.token}` } : {}), ...(raw ? { "content-type": "application/json" } : {}) };
  try {
    return await globalThis.fetch(cfg.control_plane_base + path, { method, headers, ...(raw ? { body: raw } : {}), mode: "cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  } catch {
    throw new ApiError(0, "network", NETWORK_MSG, { method, pathOnly: path.split("?")[0] });
  }
}

/** 应答 → ApiError（纯：不触发回调） */
export async function toError(r, method, path) {
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  const pathOnly = String(path).split("?")[0];
  const err = json?.error;
  const code = err?.code ?? (typeof err === "string" ? err : null);
  if (r.status === 404 && (!code || code === "not_found")) return new ApiError(404, "not_ready", `接口未就绪：控制面还没有 ${method} ${pathOnly}`, { method, pathOnly });
  const message =
    (typeof err?.message === "string" && err.message) ||
    FALLBACK[code] ||
    (r.status === 403 ? "没有权限" : r.status >= 500 ? `控制面暂时出错（HTTP ${r.status}），请稍后重试；一直这样请联系平台运维` : `请求失败（HTTP ${r.status}）`);
  const { code: _c, message: _m, ...extra } = typeof err === "object" && err ? err : {};
  return new ApiError(r.status, code ?? `http_${r.status}`, message, { method, pathOnly, detail: err ?? null, ...extra, rules: json?.rules ?? extra.rules ?? null });
}

export const isSessionLost = (e) => e?.status === 401 && /^session_/.test(String(e?.code ?? ""));
export const isReauth = (e) => e?.status === 401 && e?.code === "reauth_required";

/**
 * 带凭据调用；o.auth=false 不带令牌（登录、注册、找回）；o.noReauth=true 不弹复核（复核接口本身）。
 * reauth_required 只重试一次：复核框返回 true 后再发同一请求。
 */
export async function request(method, path, body, o = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await send(method, path, body, o);
    if (r.ok) return r;
    const e = await toError(r, method, path);
    if (isReauth(e) && attempt === 0 && !o.noReauth && state.hooks.onReauth) {
      const ok = await state.hooks.onReauth(e);
      if (ok) continue;
      throw new ApiError(401, "reauth_cancelled", "需要复核身份后才能执行：已取消", { method, pathOnly: e.pathOnly });
    }
    if (isSessionLost(e) && o.auth !== false && state.token) {
      const h = state.hooks.onAuthLost;
      if (h) queueMicrotask(() => h(e));
    }
    if (r.status === 426) {
      const h = state.hooks.onOutdated;
      if (h) queueMicrotask(() => h(e));
    }
    throw e;
  }
}
export async function call(method, path, body, o) {
  const r = await request(method, path, body, o);
  if (r.status === 204) return {};
  try {
    return await r.json();
  } catch {
    throw new ApiError(r.status, "bad_json", "控制面回复不是 JSON", { method, pathOnly: path.split("?")[0] });
  }
}
export const get = (path, params) => call("GET", qs(path, params));
export const post = (path, body = {}, o) => call("POST", path, body, o);
export const put = (path, body = {}, o) => call("PUT", path, body, o);
export const del = (path) => call("DELETE", path);

/** 带凭据 GET 一个 CSV，存成文件（Blob 链接，不经第三方） */
export async function downloadCsv(path, params, filename) {
  const r = await request("GET", qs(path, params));
  const blob = await r.blob();
  saveBlob(new Blob([blob], { type: "text/csv;charset=utf-8" }), filename);
}
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ─── 账号接口（契约 §3.1） ─────────────────────────────────────────────
const client = () => ({ platform: "web", version: CONSOLE_VERSION });
export const auth = {
  meta: () => call("GET", "/v1/meta", undefined, { auth: false }),
  login: (email, password) => call("POST", "/v1/auth/login", { email, password, client: client() }, { auth: false }),
  register: (b) => call("POST", "/v1/auth/register", { ...b, client: client() }, { auth: false }),
  resetRequest: (email) => call("POST", "/v1/auth/password-reset/request", { email }, { auth: false }),
  resetConfirm: (email, code, password) => call("POST", "/v1/auth/password-reset/confirm", { email, code, password }, { auth: false }),
  me: () => call("GET", "/v1/auth/me"),
  logout: () => call("POST", "/v1/auth/logout", {}, { noReauth: true }),
  password: (current, next) => post("/v1/auth/password", { current, next }),
  revokeSession: (sid) => post(`/v1/auth/sessions/${seg(sid)}/revoke`),
  unbindDevice: (id, password) => post(`/v1/auth/devices/${seg(id)}/unbind`, { password }),
  reauth: (password) => post("/v1/auth/reauth", { password }, { noReauth: true }),
};

/** 退出：吊销会话（尽力而为；失败也照常清掉本页凭据） */
export async function logout() {
  if (state.token) {
    try {
      await auth.logout();
    } catch {
      /* 控制面连不上：会话闲置到期自然失效 */
    }
  }
  forgetSession();
}

/** 路径小工具 */
export const T = (tid) => `/v1/ops/tenants/${seg(tid)}`;
export const A = (aid) => `/v1/ops/accounts/${seg(aid)}`;
export const M = (aid) => `/v1/firm/members/${seg(aid)}`;

// ─── 第 62 批：注册管理、模型与价目（后端由另两位同事在做） ───────────────────────────
// 页面只经这里调用；路径按契约（platform/docs/contract-b62-registration.md、contract-b62-pricing.md）接。
// 契约到之前控制面没有这些路径：404 → ApiError code "not_ready"，页面显示“接口未就绪”，不造任何替代数据。
/** 注册管理：注册策略、邀请码、短信服务配置 */
export const registration = {
  policy: () => get("/v1/ops/registration/policy"),
  savePolicy: (body) => put("/v1/ops/registration/policy", body),
  invites: (params) => get("/v1/ops/registration/invites", params),
  createInvite: (body) => post("/v1/ops/registration/invites", body),
  revokeInvite: (id) => post(`/v1/ops/registration/invites/${seg(id)}/revoke`),
  sms: () => get("/v1/ops/registration/sms"),
  saveSms: (body) => put("/v1/ops/registration/sms", body),
  testSms: (body) => post("/v1/ops/registration/sms/test", body),
};
/** 模型与价目：成本价、销售价与毛利 */
export const pricing = {
  catalog: () => get("/v1/ops/pricing"),
  save: (body) => put("/v1/ops/pricing", body),
};
