// 本机栈开通：系统管理员 → 建运营与开通专员 → 开律所 → 发创始开通码。状态写 state.json（0600）。只连 127.0.0.1。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
const dir = process.argv[2];
const CP = process.argv[3] ?? "http://127.0.0.1:18601";
const stateFile = `${dir}/e2e-state.json`;
const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(st, null, 2), { mode: 0o600 });
const login = Object.fromEntries(readFileSync(`${dir}/console-login.txt`, "utf8").split("\n").filter((l) => /^\w+: /.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2).trim()]));
const call = async (method, path, body, token) => {
  const r = await fetch(`${CP}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what} 失败 ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
const session = async (email, password) => {
  const s = must(await call("POST", "/v1/auth/login", { email, password, client: { platform: "web" } }), `登录 ${email}`).session_token;
  must(await call("POST", "/v1/auth/reauth", { password }, s), "复核");
  return s;
};
const admin = await session(login.email, login.password);
st.staff ??= {};
for (const [who, roles, name] of [["operator", ["operator"], "客户运营甲"], ["issuer", ["issuer"], "开通专员乙"], ["finance", ["finance"], "财务丙"]]) {
  if (st.staff[who]) continue;
  const email = `${who}@kwl-local.example`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const c = must(await call("POST", "/v1/ops/staff", { email, name, roles }, admin), `建 ${who}`);
  const code = c.setup_code ?? c.code;
  must(await call("POST", "/v1/auth/password-reset/confirm", { email, code, password }), `设密码 ${who}`);
  st.staff[who] = { email, password };
  save();
}
const tidArg = process.argv[4] ?? "ten_b56-firm";
const nameArg = process.argv[5] ?? "第56批验收律所";
st.tenants ??= {};
if (!st.tenants[tidArg]) {
  const op = await session(st.staff.operator.email, st.staff.operator.password);
  must(await call("POST", "/v1/ops/tenants", { tid: tidArg, edition: "team", seats: 5, name: nameArg, plan: process.argv[6] ?? undefined }, op), "开律所");
  const is = await session(st.staff.issuer.email, st.staff.issuer.password);
  const a = must(await call("POST", `/v1/ops/tenants/${tidArg}/activation-codes`, { slug: "admin", name: "王主任" }, is), "发开通码");
  st.tenants[tidArg] = { name: nameArg, activation_code: a.code ?? a.activation_code, raw: Object.keys(a) };
  save();
}
console.log("ok", Object.keys(st.staff), Object.keys(st.tenants), st.tenants[tidArg].raw);
