#!/usr/bin/env node
/**
 * 云端生产入口冒烟（第 46 批；云端仓库 CI 与部署前自检用）：用 stack-local（生产入口 cloud-serve + cloud-init-secrets，同一流程）
 * 在回环地址拉起签名服务、控制面、网关、检索与控制台，再逐项核对：
 *   健康检查 → /v1/meta 接口版本 → 首个系统管理员经设置码设好密码 → 统一账号登录 → 人员身份 → 平台运营接口 → 网关就绪 → 控制台页面与配置。
 * 不需要真实上游密钥：给网关一把形如 sk- 的假密钥、上游指向 .invalid（冒烟不发模型请求）。
 *
 *   node scripts/cloud-smoke.mjs [--base-port 18600] [--keep <目录>]
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const base = Number(arg("base-port", "18600"));
const keep = arg("keep", null);
const dir = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), "kwl-smoke-"));
const keyFile = join(dir, "dummy-upstream.key");
writeFileSync(keyFile, `sk-smoke${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });

const P = { cp: base + 1, gw: base + 2, console: base + 3, search: base + 4 };
const stack = spawn(process.execPath, [join(root, "scripts/stack-local.mjs"), "--dir", join(dir, "stack"), "--base-port", String(base), "--key-file", keyFile, "--upstream", "https://upstream.invalid/v1", "--model", "smoke-model"], { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
stack.stdout.on("data", (d) => (out += d));
stack.stderr.on("data", (d) => (out += d));

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail });
    console.log(`✓ ${name}${detail ? `：${detail}` : ""}`);
  } catch (e) {
    results.push({ ok: false, name, detail: e.message });
    console.log(`✖ ${name}：${e.message}`);
  }
};
const finish = (code) => {
  stack.kill("SIGTERM");
  setTimeout(() => {
    if (!keep) rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  }, 1500);
};
const json = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`HTTP ${r.status} 不是 JSON：${t.slice(0, 120)}`);
  }
};

const deadline = Date.now() + 180_000;
while (!/控制台账号：/.test(out)) {
  if (stack.exitCode !== null || Date.now() > deadline) {
    console.error(`本机栈没有起来：\n${out.slice(-2000)}`);
    finish(1);
    await new Promise(() => {});
  }
  await new Promise((r) => setTimeout(r, 250));
}
const cp = `http://127.0.0.1:${P.cp}`;
const login = Object.fromEntries(readFileSync(join(dir, "stack", "console-login.txt"), "utf8").split("\n").map((l) => /^(\w+):\s*(.+)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
let token = null;

await check("控制面健康检查", async () => {
  const r = await fetch(`${cp}/healthz`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
});
await check("接口版本 /v1/meta", async () => {
  const m = await json(await fetch(`${cp}/v1/meta`));
  if (m.api !== "kwl-cp/2") throw new Error(`api = ${m.api}`);
  return `${m.api}，注册策略 ${m.registration}，人员两步验证 ${m.staff_mfa}`;
});
await check("首个系统管理员（引导文件 → 设置码设密码）", async () => {
  if (!login.email || !login.password) throw new Error("console-login.txt 缺邮箱或密码");
  return login.email;
});
await check("统一账号登录（网页）", async () => {
  const r = await fetch(`${cp}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${P.console}` }, body: JSON.stringify({ email: login.email, password: login.password, client: { platform: "web", version: "1.0.0" } }) });
  const b = await json(r);
  if (r.status !== 200 || !b.session_token) throw new Error(`HTTP ${r.status} ${b.error?.code ?? ""}`);
  if (r.headers.get("access-control-allow-origin") !== `http://127.0.0.1:${P.console}`) throw new Error("没有给控制台来源回 CORS");
  token = b.session_token;
  return `会话 ${b.session.kind}${b.session.restricted ? `（受限：${b.session.restricted}）` : ""}`;
});
await check("人员身份 /v1/auth/me", async () => {
  const b = await json(await fetch(`${cp}/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } }));
  if (b.kind !== "staff" || !b.account?.roles?.includes("sysadmin")) throw new Error(JSON.stringify(b).slice(0, 160));
  return `角色 ${b.account.roles.join("、")}`;
});
await check("平台运营接口 /v1/ops/overview", async () => {
  const r = await fetch(`${cp}/v1/ops/overview`, { headers: { authorization: `Bearer ${token}` } });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
});
await check("没有会话的平台接口被拒", async () => {
  const r = await fetch(`${cp}/v1/ops/overview`);
  if (r.status !== 401) throw new Error(`HTTP ${r.status}`);
});
await check("网关健康检查", async () => {
  const r = await fetch(`http://127.0.0.1:${P.gw}/healthz`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
});
await check("网关拒绝没有席位令牌的模型请求", async () => {
  const r = await fetch(`http://127.0.0.1:${P.gw}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "legal/k3", messages: [{ role: "user", content: "x" }] }) });
  if (r.status !== 401) throw new Error(`HTTP ${r.status}`);
});
await check("控制台页面与运行配置", async () => {
  const page = await fetch(`http://127.0.0.1:${P.console}/`);
  const html = await page.text();
  if (page.status !== 200 || !/<title>/.test(html)) throw new Error(`HTTP ${page.status}`);
  if (!/connect-src 'self' http:\/\/127\.0\.0\.1:\d+/.test(page.headers.get("content-security-policy") ?? "")) throw new Error("CSP 没有收紧到控制面");
  const cfg = await json(await fetch(`http://127.0.0.1:${P.console}/config.json`));
  if (cfg.control_plane_base !== cp) throw new Error(`config.json 指向 ${cfg.control_plane_base}`);
});

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n冒烟没过：${bad.length} 项` : `\n冒烟通过：${results.length} 项`);
finish(bad.length ? 1 : 0);
