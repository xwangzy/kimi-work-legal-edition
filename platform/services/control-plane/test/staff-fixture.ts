/**
 * 用例夹具（第 46 批）：平台人员用统一账号登录（开发形态 devStaff；第 53 批起邮箱 + 密码即登录），以 Bearer 会话调运营接口；
 * 登录后即复核一次（危险操作在 10 分钟内可直接做）。人员邮箱 = 编号去掉下划线 @csi.example.cn。
 */
import type { PlatformRole } from "../src/rbac.ts";

export const STAFF_PW = "Staff2026secure";
export const staffEmail = (who: string) => `${who.replace(/_/g, "")}@csi.example.cn`;
export const devStaffOf = (people: Record<string, PlatformRole[]>) => Object.entries(people).map(([who, roles]) => ({ email: staffEmail(who), name: who, roles, password: STAFF_PW }));

export async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const r = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json, text, type: r.headers.get("content-type"), headers: r.headers };
}

/** 登录并（缺省）用密码复核，返回会话令牌。 */
export async function staffToken(base: string, email: string, o: { password?: string; reauth?: boolean } = {}): Promise<string> {
  const password = o.password ?? STAFF_PW;
  const r = await call(base, "POST", "/v1/auth/login", { email, password, client: { platform: "web" } });
  if (r.status !== 200 || typeof r.json?.session_token !== "string") throw new Error(`人员登录失败 ${r.status}：${r.text}`);
  if (o.reauth !== false) {
    const re = await call(base, "POST", "/v1/auth/reauth", { password }, { authorization: `Bearer ${r.json.session_token}` });
    if (re.status !== 200) throw new Error(`复核失败 ${re.status}：${re.text}`);
  }
  return r.json.session_token;
}

/** ops(编号, 方法, 路径, 体)：按编号登录一次后复用会话。 */
export function staffClient(base: () => string) {
  const tokens = new Map<string, string>();
  const tokenOf = async (who: string) => {
    let t = tokens.get(who);
    if (!t) tokens.set(who, (t = await staffToken(base(), staffEmail(who))));
    return t;
  };
  const ops = async (who: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => call(base(), method, path, body, { ...extra, authorization: `Bearer ${await tokenOf(who)}` });
  return Object.assign(ops, { tokenOf });
}
