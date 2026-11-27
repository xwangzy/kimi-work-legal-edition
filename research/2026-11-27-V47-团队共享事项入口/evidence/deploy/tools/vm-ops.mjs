// 虚机控制面的平台运营调用（与控制台同一条路）。首次运行：用 bootstrap-admin.txt 的设置码设系统管理员密码（存 secret/vm-admin.pw，0600）。
// 用法：NODE_EXTRA_CA_CERTS=demo-ca.crt node vm-ops.mjs METHOD PATH [JSON]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const here = new URL(".", import.meta.url).pathname;
const base = "https://192.168.64.2:8443";
const pwFile = here + "secret/vm-admin.pw";
const email = "admin@kwl-drill.example";
async function http(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j?.error ?? j)}`), { code: j?.error?.code });
  return j;
}
if (!existsSync(pwFile)) {
  const t = execFileSync("limactl", ["shell", "kwl-deploy", "--", "sudo", "cat", "/var/lib/kwl/control-plane/bootstrap-admin.txt"], { encoding: "utf8" });
  const code = /^setup_code:\s*(\S+)/m.exec(t)[1];
  const pw = `Drill-${randomBytes(12).toString("base64url")}7`;
  await http("POST", "/v1/auth/password-reset/confirm", { email, code, password: pw });
  writeFileSync(pwFile, pw + "\n", { mode: 0o600 });
  console.error("[vm-ops] 已用设置码设好系统管理员密码（secret/vm-admin.pw）");
}
const pw = readFileSync(pwFile, "utf8").trim();
const tok = (await http("POST", "/v1/auth/login", { email, password: pw, client: { platform: "web", version: "dev" } })).session_token;
const [m, p, b] = process.argv.slice(2);
if (!m) process.exit(0);
const body = b ? JSON.parse(b) : undefined;
let out;
try { out = await http(m, p, body, tok); } catch (e) { if (e.code !== "reauth_required") throw e; await http("POST", "/v1/auth/reauth", { password: pw }, tok); out = await http(m, p, body, tok); }
console.log(JSON.stringify(out, null, 1).slice(0, Number(process.env.N || 4000)));
