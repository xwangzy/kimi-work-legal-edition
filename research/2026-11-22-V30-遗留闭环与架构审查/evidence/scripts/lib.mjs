// 本机栈 E2E 公共函数：平台人员会话、内核调用
import { readFileSync } from "node:fs";
export const DIR = process.env.KWL_STACK ?? new URL("../stack56", import.meta.url).pathname;
export const CP = "http://127.0.0.1:18601";
export const state = () => JSON.parse(readFileSync(`${DIR}/e2e-state.json`, "utf8"));
export const call = async (method, path, body, token) => {
  const r = await fetch(`${CP}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const sessions = new Map();
export async function staff(who) {
  if (sessions.has(who)) return sessions.get(who);
  let cred;
  if (who === "sysadmin") { const l = Object.fromEntries(readFileSync(`${DIR}/console-login.txt`, "utf8").split("\n").filter((x) => /^\w+: /.test(x)).map((x) => [x.slice(0, x.indexOf(":")), x.slice(x.indexOf(":") + 2).trim()])); cred = { email: l.email, password: l.password }; }
  else cred = state().staff[who];
  const s = await call("POST", "/v1/auth/login", { ...cred, client: { platform: "web" } });
  if (s.status !== 200) throw new Error(`登录 ${who} 失败 ${s.status} ${s.text.slice(0, 200)}`);
  const tok = s.json.session_token;
  const re = await call("POST", "/v1/auth/reauth", { password: cred.password }, tok);
  if (re.status !== 200) throw new Error(`复核失败 ${re.text}`);
  sessions.set(who, tok);
  return tok;
}
export const ops = async (who, method, path, body) => call(method, path, body, await staff(who));
export async function inv(name, method, params = {}) {
  const b = JSON.parse(readFileSync(`${DIR}/clients/${name}/bridge.json`, "utf8"));
  const r = await fetch(`http://127.0.0.1:${b.bridge}/invoke`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${b.web}`, "x-kwl-token": b.token }, body: JSON.stringify({ method, params }) });
  const j = await r.json();
  if (!j.ok) { const e = new Error(`${method}: ${j.error?.code} ${j.error?.message}`); e.code = j.error?.code; e.detail = j.error; throw e; }
  return j.result;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
