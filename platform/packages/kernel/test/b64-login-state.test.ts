/**
 * 第 64 批独立复核的修补：
 * - “要重新登录”本机记录：字段逐项核对（被改成怪值宁可不认）；写、读、删往返；
 * - 注册 / 登录策略：云端答了 → 归一；很旧的云端没有 /v1/meta（not_found / http_404）→ 旧流程；取不到 → 如实报错带原因；
 * - 退出登录时发出的同步，答复在重新登录之后才回来：只认“这次请求带的会话就是现在的会话”，不把刚登录的人踢回登录页；
 * - 开通 / 入组写会话时删掉同一工作区的旧记录；删记录失败不让登录报失败；会话比记录新则记录作废；
 * - 闸门：摘要计算或运行时核对期间内核关闭 → 不再拉起；关闭最多等 3 秒；全量核对发现不符先撤回闸门的放行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropLoginRequired, loginRequiredPath, readLoginRequired, writeLoginRequired } from "../src/account-session.ts";
import { fetchRegistrationMeta } from "../src/services/onboarding.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("本机记录：往返；原因只认要重新登录的几种；字段类型与长度不对就不认", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-b64-mark-"));
  writeLoginRequired(dir, { reason: "session_required", email: "a@example.cn", name: "王律师", role: "lawyer" });
  const r = readLoginRequired(dir)!;
  assert.deepEqual([r.reason, r.email, r.name, r.role], ["session_required", "a@example.cn", "王律师", "lawyer"]);
  assert.ok(!JSON.stringify(r).includes("kws1."), "不含令牌");
  writeLoginRequired(dir, { reason: "quota_exceeded" });
  assert.equal(readLoginRequired(dir)?.reason, "session_required", "不认识的原因不写");
  for (const bad of [{ email: { x: 1 } }, { name: "名".repeat(81) }, { role: 7 }, { at: "不是时间" }]) {
    writeFileSync(loginRequiredPath(dir), JSON.stringify({ v: 1, reason: "session_expired", email: "a@b.cn", name: "n", role: "r", at: new Date().toISOString(), ...bad }));
    assert.equal(readLoginRequired(dir), null, JSON.stringify(bad));
  }
  dropLoginRequired(dir);
  assert.equal(existsSync(loginRequiredPath(dir)), false);
});

test("注册 / 登录策略：取到归一；很旧的云端没有 /v1/meta 按旧流程；取不到如实报错", async () => {
  const pol = { registration_policy: { mode: "open", sms_available: true, phone_login: true }, features: ["sms_send", "phone_login"] };
  assert.equal((await fetchRegistrationMeta(async () => ({ ok: true, json: pol }))).phone_login, true);
  assert.equal((await fetchRegistrationMeta(async () => ({ ok: true, json: { registration: "open" } }))).legacy, true, "云端答了但没有策略 = 旧云端");
  for (const code of ["not_found", "http_404"]) assert.equal((await fetchRegistrationMeta(async () => ({ ok: false, code }))).legacy, true, code);
  for (const code of ["cp_unreachable", "cp_timeout", "http_503", "gate_unavailable"]) {
    await assert.rejects(fetchRegistrationMeta(async () => ({ ok: false, code })), (e: any) => e.code === "provider_unavailable" && e.detail?.reason === code, code);
  }
});

test("同步答复只认当时带的会话；开通写会话删旧记录；删记录失败不让登录失败；会话比记录新则记录作废", () => {
  const cl = src("control-plane/client.ts");
  assert.match(cl, /if \(SESSION_PROBLEMS\.has\(code\)\) this\.d\.onSessionProblem\?\.\(code, session\);/);
  const ix = src("index.ts");
  assert.match(ix, /onSessionProblem: \(code, sent\) => \{\s*if \(\(accountSession\?\.token \?\? null\) !== sent\) return;\s*markAccountProblem\(code, "sync"\);/);
  assert.match(ix, /clearProblem: \(\) => \{[\s\S]{0,300}try \{\s*dropLoginRequired\(keysDir\);\s*\} catch \(e\) \{/);
  assert.match(ix, /Date\.parse\(accountSession\.saved_at\) > Date\.parse\(p\.at\)/);
  // 第 72 批补：第 71 批起写会话时另带打码手机号（`...account, ...(maskedPhoneOrNull…)`），原正则要求 `...account }` 紧接，HEAD 55d75f32 上即已不过
  assert.match(src("services/onboarding.ts"), /writeAccountSession\(keysDir, \{ token: j\.session_token, \.\.\.account(?:, [^\n]{0,120})? \}\);[\s\S]{0,200}dropLoginRequired\(keysDir\);/);
});

test("闸门：关闭期间不再拉起、关闭最多等 3 秒；全量核对不符先撤回放行", () => {
  const g = src("egress/kernel-gate.ts");
  assert.match(g, /await sha256OfFile\(bin\)[\s\S]{0,300}if \(this\.closed\) throw new Error\("出站闸门已关闭"\);/);
  assert.match(g, /\.then\(\(h\) => \{\s*\/\/[^\n]*\n\s*if \(this\.closed\) \{\s*void h\.close\(\)/);
  assert.match(g, /Promise\.race\(\[this\.starting\.catch\(\(\) => null\), new Promise<null>\(\(r\) => setTimeout\(\(\) => r\(null\), 3000\)\.unref\(\)\)\]\)/);
  const main = readFileSync(new URL("../../../apps/desktop/electron/main.cjs", import.meta.url), "utf8");
  assert.match(main, /if \(problems\.length === 0\) return;\s*\/\/[^\n]*\n\s*gateVerifiedOk = false;\s*runtimeVerifiedOk = false;/);
});
