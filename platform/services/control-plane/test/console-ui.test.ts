/**
 * 第 46 批：统一云端控制台（apps/console）的静态门禁与浏览器端逻辑。
 * - dist 完整、引用都在 dist 内、config.example.json 不进 dist；tokens.css 与桌面端同一份；
 * - 页内 CSP 严格；--control-plane 把 connect-src 收紧为 'self' + 控制面来源；
 * - 样式无颜色字面量、不直接用基础色板、引用的令牌都已定义；
 * - 运营私钥登录全部移除（ops-sign.js、keystore.js、IndexedDB、拖拽私钥、口令）；演示逻辑移除；
 * - seal-key：路由公钥来自控制面 routing_key，指纹核对；加密可被 P-256 私钥解开；
 * - D-218：平台人员不再有第二步验证、不再限网段：二维码模块与绑定流程已删除，复核框只要密码；
 * - api.js：Bearer、复核重试一次、401 session_* 回登录、426 升级提示、404 = 接口未就绪；config 只认三项。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const consoleDir = join(root, "apps/console");
const tmp = mkdtempSync(join(tmpdir(), "kwl-console-ui-"));
/** 浏览器模块（纯 JS，无类型声明）：按路径动态导入 */
const mod = async (rel: string): Promise<any> => import(pathToFileURL(join(root, rel)).href);
const modules = () => [...readdirSync(consoleDir).filter((f) => f.endsWith(".js")), ...readdirSync(join(consoleDir, "pages")).filter((f) => f.endsWith(".js")).map((f) => `pages/${f}`)].sort();
const src = (f: string) => readFileSync(join(consoleDir, f), "utf8");
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'none'";

// ─── 打包 ───────────────────────────────────────────────────────────
test("build-console：dist 含页面、全部模块与 tokens.css（与桌面端同一份），不含 config.example.json；引用都在 dist 内", async () => {
  const { buildConsole, verifyDist } = await mod("scripts/build-console.mjs");
  const out = join(tmp, "dist");
  const files = buildConsole(out).map((f: { path: string }) => f.path);
  assert.deepEqual(files, ["console.css", "index.html", "tokens.css", ...modules()].sort());
  assert.ok(!existsSync(join(out, "config.example.json")), "示例配置不进 dist");
  const tokens = readFileSync(join(root, "packages/design-tokens/src/tokens.css"));
  assert.ok(readFileSync(join(out, "tokens.css")).equals(tokens), "dist/tokens.css 与 packages/design-tokens 逐字节相同");
  // 桌面端引用同一份令牌由客户端一侧的门禁核对（apps/desktop/test/style-tokens.test.ts）；本用例随独立云端仓库导出，不读客户端源码
  assert.deepEqual(verifyDist(out), []);
  for (const need of ["app.js", "api.js", "ui.js", "domain.js", "auth.js", "reauth.js", "seal-key.js"]) assert.ok(files.includes(need), `缺 ${need}`);
  for (const p of ["me-overview", "me-security", "me-devices", "firm-overview", "firm-members", "firm-devices", "firm-usage", "firm-billing", "overview", "tenants", "accounts", "devices", "routing", "usage", "plans", "billing", "staff", "system"]) assert.ok(files.includes(`pages/${p}.js`), `缺页面 ${p}`);
});

test("build-console --control-plane：connect-src 收紧为 'self' + 控制面来源；非 https（回环除外）与带路径的来源拒绝", async () => {
  const { buildConsole, connectSrcFor, cspOf } = await mod("scripts/build-console.mjs");
  const out = join(tmp, "dist-cp");
  const files = buildConsole(out, { controlPlane: "https://cp.example.com" });
  assert.equal(files.connectSrc, "'self' https://cp.example.com");
  const csp = cspOf(readFileSync(join(out, "index.html"), "utf8"));
  assert.equal(csp, CSP.replace("connect-src 'self' https:", "connect-src 'self' https://cp.example.com"));
  assert.equal(connectSrcFor("http://127.0.0.1:18401"), "'self' http://127.0.0.1:18401");
  assert.equal(connectSrcFor(undefined), "'self' https:");
  assert.throws(() => connectSrcFor("http://cp.example.com"), /https/);
  assert.throws(() => connectSrcFor("https://cp.example.com/v1"), /只写来源/);
  assert.throws(() => connectSrcFor("https://u:p@cp.example.com"), /只写来源/);
  assert.equal(src("index.html").includes(CSP), true, "源 index.html 的兜底 CSP 不放宽");
});

// ─── 静态门禁 ───────────────────────────────────────────────────────
test("页面门禁：CSP 严格、只有一个模块入口、无内联脚本与样式、不引外部资源、不拼 HTML、不用 style 属性与 window.confirm", () => {
  const html = src("index.html");
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}" />`), "页内兜底 CSP");
  assert.doesNotMatch(CSP, /unsafe-|\*/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]![1]!, /type="module"/);
  assert.match(scripts[0]![1]!, /src="app\.js"/);
  assert.equal(scripts[0]![2]!.trim(), "");
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*"(?:https?:)?\/\//i);
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]), ["tokens.css", "console.css"]);
  for (const id of ["boot", "auth", "auth-card", "app", "nav", "content", "drawer", "modal", "reauth", "toasts", "btn-menu", "scrim"]) assert.match(html, new RegExp(`id="${id}"`), `缺 #${id}`);
  const bad = (f: string, s: string, re: RegExp, why: string) => assert.ok(!re.test(s), `${f} ${why}：${re.exec(s)?.[0] ?? ""}`);
  for (const f of modules()) {
    const s = src(f);
    bad(f, s, /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\b|createContextualFragment|DOMParser/, "不拼 HTML、不动态求值");
    bad(f, s, /setAttribute\(\s*["']style["']/, "不写 style 属性");
    bad(f, s, /\.style\.(?!cssText\b)/, "动态样式只经 el.style.cssText");
    bad(f, s, /\bwindow\.(?:confirm|alert|prompt)\b|(?<![\w.$])(?:confirm|alert|prompt)\s*\(/, "不用 window.confirm / alert / prompt");
    bad(f, s, /\bfrom\s+["'](?!\.\.?\/)|\bimport\s*\(\s*["'](?!\.\.?\/)|\bimport\s+["'](?!\.\.?\/)/, "只引本地相对模块");
    bad(f, s, /fetch\(\s*["'`](?:https?:)?\/\/|\.(?:src|href|action)\s*=\s*["'`](?:https?:)?\/\/|\b(?:src|href|action):\s*["'`](?:https?:)?\/\/|new (?:WebSocket|EventSource|Worker)\(/, "不从外部取资源、不开别的连接");
    if (f !== "app.js") bad(f, s, /localStorage\s*[.[]/, "localStorage 只有 app.js 记主题");
    if (f !== "api.js") bad(f, s, /sessionStorage/, "会话令牌只经 api.js 放 sessionStorage");
    if (f !== "seal-key.js") bad(f, s, /exportKey\s*\(/, "不导出任何密钥（只有 seal-key.js 导出临时公钥）");
    bad(f, s, /document\.cookie|credentials:\s*["']include["']/, "不用 Cookie");
  }
});

test("样式门禁：无颜色字面量、不直接用基础色板、引用的令牌都已定义、自加令牌只有 --console- 几何", () => {
  const css = src("console.css");
  const tokens = readFileSync(join(root, "packages/design-tokens/src/tokens.css"), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, "不写颜色字面量");
  assert.doesNotMatch(css, /@import|url\(/i);
  assert.doesNotMatch(css, /var\(--p-/, "不直接用基础色板");
  const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g), ...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  assert.deepEqual(used.filter((v) => !defined.has(v) && !["--w", "--l", "--h"].includes(v!)), []);
  const own = [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
  assert.ok(own.every((v) => v!.startsWith("--console-")), own.join(","));
  // 与客户端同一产品语言：暖灰底上悬浮白色圆角主区、36px 导航行；≤768px 侧栏收为抽屉
  assert.match(css, /body \{[^}]*background: var\(--bg-sidebar\)/);
  assert.match(css, /\.main \{[^}]*margin: var\(--shell-gap\)[^}]*background: var\(--bg-main\)[^}]*border-radius: var\(--radius-card\)/);
  assert.match(css, /--console-nav-row: 36px/);
  assert.match(css, /@media \(max-width: 768px\) \{[\s\S]*?\.sidebar \{[^}]*position: fixed[^}]*transform: translateX\(-100%\)/);
  assert.match(css, /\.table-wrap \{[^}]*overflow-x: auto/);
  assert.match(css, /\.content \{[^}]*overflow-x: hidden/);
});

test("运营私钥登录与演示逻辑已移除；config 只认三项", async () => {
  for (const f of ["ops-sign.js", "keystore.js"]) assert.equal(existsSync(join(consoleDir, f)), false, `${f} 已删除`);
  const all = modules().map((f) => [f, src(f)] as const);
  all.push(["index.html", src("index.html")]);
  for (const [f, s] of all) {
    assert.doesNotMatch(s, /indexedDB|Ed25519|importOpsKey|signOpsRequest|ops-sign|keystore|kwlops_|PRIVATE KEY|私钥登录|私钥文件|口令/, `${f} 还有私钥登录残留`);
    assert.doesNotMatch(s, /dev-demo-|cfg\.demo|point_price|开发演示数据/, `${f} 还有演示逻辑`);
    assert.doesNotMatch(s, /routing_public_key|\/v1\/ops\/login|\/v1\/ops\/password|\/v1\/ops\/logout/, `${f} 还读旧字段或旧接口`);
  }
  const { parseConfig } = await mod("apps/console/api.js");
  const c = parseConfig({ control_plane_base: "https://cp.example.com/", deployment: "prod", label: "生产", routing_public_key: "x", routing_key_id: "y", demo: true, point_price_cny: 1 });
  assert.deepEqual(c, { control_plane_base: "https://cp.example.com", deployment: "prod", label: "生产" });
  assert.throws(() => parseConfig({ control_plane_base: "http://cp.example.com", deployment: "prod" }), /https/);
  assert.deepEqual(parseConfig({ control_plane_base: "http://127.0.0.1:5480", deployment: "dev" }).control_plane_base, "http://127.0.0.1:5480");
  assert.throws(() => parseConfig({ control_plane_base: "https://cp.example.com/x", deployment: "prod" }), /只写来源/);
  assert.throws(() => parseConfig({ control_plane_base: "https://cp.example.com", deployment: "Prod!" }), /deployment/);
  const ex = JSON.parse(src("config.example.json"));
  assert.deepEqual(Object.keys(ex).filter((k) => !k.startsWith("_")).sort(), ["control_plane_base", "deployment", "label"]);
});

test("D-218：平台人员登录只要账号与密码——无第二步验证、无网段限制、无二维码；复核只要密码", async () => {
  for (const f of ["qr.js", "mfa.js"]) assert.equal(existsSync(join(consoleDir, f)), false, `${f} 已删除`);
  const all = modules().map((f) => [f, src(f)] as const);
  all.push(["index.html", src("index.html")], ["console.css", src("console.css")]);
  for (const [f, s] of all) {
    assert.doesNotMatch(s, /\/v1\/auth\/mfa\/|mfa_token|mfa_required|staff_network|mfa_enroll|restricted/, `${f} 还调第二步验证接口或读受限会话`);
    assert.doesNotMatch(s, /totp|mfa|otpauth|恢复码|两步验证|运维网段|堡垒机|身份验证器/i, `${f} 还有第二步验证或网段限制的界面文案`);
  }
  const api = await mod("apps/console/api.js");
  for (const k of ["mfaVerify", "totpSetup", "totpEnable", "totpDisable"]) assert.equal(k in api.auth, false, `api.auth.${k} 已删除`);
  assert.equal(api.auth.reauth.length, 1, "复核只收密码");
});

// ─── 上游密钥加密 ────────────────────────────────────────────────────
test("seal-key：公钥取自控制面 routing_key、指纹核对；加密可被网关 P-256 私钥解开，换上游编号解不开", async () => {
  const { sealUpstreamKey, keyHint, SEAL_ALG, checkRoutingKey, spkiFingerprint, sameFingerprint, b64url } = await mod("apps/console/seal-key.js");
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const spki = der.toString("base64");
  const hex = createHash("sha256").update(der).digest("hex");
  assert.equal(await spkiFingerprint(spki), hex);
  assert.equal(b64url(new Uint8Array([251, 255, 254])), Buffer.from([251, 255, 254]).toString("base64url"));
  // 控制面的指纹写法（四位一组、空格分隔）与本页算的一致；不一致即禁用
  const grouped = hex.match(/.{4}/g)!.join(" ");
  assert.equal(sameFingerprint(grouped, hex), true);
  assert.equal(sameFingerprint(`sha256:${hex.toUpperCase()}`, hex), true);
  assert.equal(sameFingerprint("0000 1111 2222 3333", hex), false);
  const ok = await checkRoutingKey({ kid: hex.slice(0, 16), spki_b64: spki, fingerprint: grouped });
  assert.equal(ok.ok, true);
  assert.equal(ok.fingerprint, hex);
  assert.equal((await checkRoutingKey(null)).ok, false);
  assert.equal((await checkRoutingKey({ kid: "k", spki_b64: spki, fingerprint: "ffff ffff ffff ffff" })).ok, false, "指纹不符禁用");
  assert.equal((await checkRoutingKey({ kid: "k", spki_b64: "bm90LWEta2V5" })).ok, false, "不是 P-256 禁用");
  assert.equal((await checkRoutingKey({ spki_b64: spki })).ok, false, "缺编号禁用");

  const plain = "sk-upstream-test-0123456789abcd";
  const sealed = await sealUpstreamKey({ publicKey: ok.key, kid: ok.kid, providerId: "csi-maas", plaintext: plain });
  assert.deepEqual(Object.keys(sealed).sort(), ["alg", "ct", "epk", "iv", "kid"]);
  assert.equal(sealed.alg, SEAL_ALG);
  assert.equal(JSON.stringify(sealed).includes(plain), false);
  const open = (providerId: string) => {
    const epk = Buffer.from(sealed.epk, "base64url");
    assert.equal(epk.length, 65);
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: epk.subarray(1, 33).toString("base64url"), y: epk.subarray(33).toString("base64url") }, format: "jwk" });
    const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: pub });
    const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from("kwl-upstream-key/1"), Buffer.from(providerId), 32));
    const ct = Buffer.from(sealed.ct, "base64url");
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
    d.setAAD(Buffer.from(`kwl-upstream-key/1\n${providerId}`));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
  };
  assert.equal(open("csi-maas"), plain);
  assert.throws(() => open("other-maas"));
  assert.equal(keyHint(plain), "…abcd");
  await assert.rejects(sealUpstreamKey({ publicKey: spki, kid: "k", providerId: "csi-maas", plaintext: "short" }), /太短/);
});

// ─── api.js：复核重试、401 / 426、接口未就绪 ─────────────────────────────
type Call = { url: string; init: any };
function stubFetch(script: ((c: Call, i: number) => { status: number; body?: unknown })[]) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    const c = { url, init };
    calls.push(c);
    const step = script[Math.min(calls.length - 1, script.length - 1)]!(c, calls.length - 1);
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), { status: step.status, headers: { "content-type": "application/json" } });
  };
  return calls;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("api.js：Bearer 会话；401 reauth_required 弹复核后重试一次；取消或再次要求复核即失败；401 session_* 回登录；426 升级提示；404 = 接口未就绪", async () => {
  const api = await mod("apps/console/api.js");
  const realFetch = globalThis.fetch;
  try {
    api.setConfig({ control_plane_base: "https://cp.example.com", deployment: "t", label: "" });
    api.setToken("kws1.test-token-abcdef");
    let reauths = 0;
    let lost: any = null;
    let outdated: any = null;
    let answer = true;
    api.setHooks({ onReauth: async () => (reauths++, answer), onAuthLost: (e: any) => (lost = e), onOutdated: (e: any) => (outdated = e) });

    // 普通请求：Bearer、cors、不带 Cookie
    let calls = stubFetch([() => ({ status: 200, body: { ok: true, n: 1 } })]);
    assert.deepEqual(await api.get("/v1/ops/tenants", { q: "张 三", empty: "" }), { ok: true, n: 1 });
    assert.equal(calls[0]!.url, "https://cp.example.com/v1/ops/tenants?q=%E5%BC%A0+%E4%B8%89");
    assert.equal(calls[0]!.init.headers.authorization, "Bearer kws1.test-token-abcdef");
    assert.equal(calls[0]!.init.credentials, "omit");
    assert.equal(calls[0]!.init.mode, "cors");

    // 复核：第一次 401 reauth_required → 复核框（true）→ 同一请求重发一次
    const reauthErr = { status: 401, body: { error: { code: "reauth_required", message: "这是敏感操作：请重新输入密码确认后再试" } } };
    calls = stubFetch([() => reauthErr, () => ({ status: 200, body: { ok: true, staff: { aid: "stf_x" } } })]);
    const r = await api.post("/v1/ops/staff", { email: "a@b.example", name: "甲", roles: ["viewer"] });
    assert.equal(r.staff.aid, "stf_x");
    assert.equal(reauths, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.init.body, calls[0]!.init.body, "重试的是同一个请求");
    assert.equal(calls[1]!.init.method, "POST");

    // 复核后仍要求复核：只重试一次，不循环
    calls = stubFetch([() => reauthErr]);
    await assert.rejects(api.post("/v1/ops/staff", {}), (e: any) => e.code === "reauth_required");
    assert.equal(calls.length, 2);
    assert.equal(reauths, 2);
    // 取消复核
    answer = false;
    calls = stubFetch([() => reauthErr]);
    await assert.rejects(api.put("/v1/ops/settings", {}), (e: any) => e.code === "reauth_cancelled");
    assert.equal(calls.length, 1);
    // 复核接口本身不再弹复核
    calls = stubFetch([() => reauthErr]);
    await assert.rejects(api.auth.reauth("pw"), (e: any) => e.code === "reauth_required");
    assert.equal(reauths, 3);
    // 复核只发密码（D-218）
    assert.equal(calls[0]!.url, "https://cp.example.com/v1/auth/reauth");
    assert.deepEqual(JSON.parse(calls[0]!.init.body), { password: "pw" });

    // 401 session_expired：回调回登录页
    stubFetch([() => ({ status: 401, body: { error: { code: "session_expired", message: "登录已过期，请重新登录" } } })]);
    await assert.rejects(api.get("/v1/auth/me"), (e: any) => api.isSessionLost(e) && e.message === "登录已过期，请重新登录");
    await tick();
    assert.equal(lost?.code, "session_expired");
    // 登录接口的 401（邮箱或密码错）不当成会话失效，也不带令牌
    lost = null;
    calls = stubFetch([() => ({ status: 401, body: { error: { code: "auth_invalid", message: "邮箱或密码不正确" } } })]);
    await assert.rejects(api.auth.login("a@b.example", "x"), /邮箱或密码不正确/);
    await tick();
    assert.equal(lost, null);
    assert.equal(calls[0]!.init.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(calls[0]!.init.body).client.platform, "web");

    // 426：升级提示
    stubFetch([() => ({ status: 426, body: { error: { code: "client_outdated", message: "客户端版本过旧，请升级到 1.9.0 或以上", min_version: "1.9.0" } } })]);
    await assert.rejects(api.get("/v1/me/usage"), (e: any) => e.status === 426 && e.min_version === "1.9.0");
    await tick();
    assert.equal(outdated?.min_version, "1.9.0");

    // 404 无错误体 = 接口未就绪（不造数）；403 = 没权限（文字照用控制面）
    stubFetch([() => ({ status: 404 })]);
    await assert.rejects(api.get("/v1/firm/overview"), (e: any) => e.code === "not_ready" && e.pathOnly === "/v1/firm/overview");
    stubFetch([() => ({ status: 403, body: { error: { code: "firm_role_required", message: "只有本所管理员或合伙人能查看" } } })]);
    await assert.rejects(api.get("/v1/firm/overview"), (e: any) => e.status === 403 && e.message === "只有本所管理员或合伙人能查看");
    // 写操作不带查询串
    await assert.rejects(api.call("POST", "/v1/ops/x?y=1", {}), /查询串/);
    // 没有会话就不发请求
    api.setToken(null);
    calls = stubFetch([() => ({ status: 200, body: {} })]);
    await assert.rejects(api.get("/v1/auth/me"), (e: any) => e.code === "session_required");
    assert.equal(calls.length, 0);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("页面纯函数：密码预检、人员角色组合、安全提示", async () => {
  const { passwordHint } = await mod("apps/console/auth.js");
  assert.equal(passwordHint("short1", undefined, "a@b.c"), "密码至少 10 位");
  assert.equal(passwordHint("abcdefghijk", undefined, "a@b.c"), "密码须同时包含字母和数字");
  assert.equal(passwordHint("zhangsan123x", undefined, "zhangsan@b.c"), "密码不要包含邮箱前缀");
  assert.equal(passwordHint("Good-pass-123", "Good-pass-124", "a@b.c"), "两次输入的密码不一致");
  assert.equal(passwordHint("Good-pass-123", "Good-pass-123", "a@b.c"), null);
  const { rolesProblem } = await mod("apps/console/pages/staff.js");
  assert.match(rolesProblem([]), /至少/);
  assert.match(rolesProblem(["viewer", "finance", "support", "issuer"]), /至多 3/);
  assert.match(rolesProblem(["operator", "issuer"]), /互斥|兼任/);
  assert.match(rolesProblem(["viewer"], { self: true, wasSysadmin: true }), /自己/);
  assert.match(rolesProblem(["viewer"], { wasSysadmin: true, activeSysadmins: 1 }), /至少保留/);
  assert.equal(rolesProblem(["sysadmin", "finance"]), null);
  const { securityTips } = await mod("apps/console/pages/me-overview.js");
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const tips = securityTips({ account: {}, sessions: [{ current: true }, { current: false }], devices: [{ last_seen_on: old }] });
  assert.deepEqual(tips.map((t: string[]) => t[1]), ["网页登录 1 处（不占电脑名额）", "1 台电脑超过 30 天没在线"]);
  assert.deepEqual(securityTips({ account: {}, sessions: [{ current: true }], devices: [] }), []);
});

test("第 47 批走查：额度说法（重置时刻、周期）；5xx 不露合成错误码；页面不把 null 写成文字", async () => {
  const { fmt, errText } = await mod("apps/console/ui.js");
  const resets = "2026-11-30T16:00:00.000Z";
  assert.equal(fmt.resets(resets), "12 月 1 日 0:00");
  assert.equal(fmt.resetLine(resets), "将于 12 月 1 日 0:00 重置");
  assert.equal(fmt.resetLine(null), "每期开始时重置");
  assert.equal(fmt.period({ key: "2026-11", start: "2026-10-31T16:00:00.000Z", resets_at: resets }), "2026 年 11 月（11 月 1 日 – 11 月 30 日）");
  // 与客户端（apps/desktop/src/lib/firm-usage.ts）逐值一致的对照在客户端一侧：apps/desktop/test/b47-console-consistency.test.ts（独立云端仓库里没有客户端代码）
  // 500 无响应体：中文说明，不再出现“（http_500）”；控制面给了错误码的照常附上便于报障
  const { toError } = await mod("apps/console/api.js");
  const e500 = await toError(new Response("", { status: 500 }), "GET", "/v1/firm/overview");
  assert.equal(e500.code, "http_500");
  assert.match(errText(e500), /^控制面暂时出错（HTTP 500）/);
  assert.doesNotMatch(errText(e500), /http_500/);
  const e503 = await toError(new Response(JSON.stringify({ error: { code: "ledger_down", message: "账本暂时不可用" } }), { status: 503 }), "GET", "/x");
  assert.equal(errText(e503), "账本暂时不可用（ledger_down）");
  // 原生 el.append(null) 会把“null”写进页面（价目表顶部曾出现）：页面里的原生 append 顶层参数不得出现可能为 null 的条件式，改用 ui.js 的 add()
  const bad: string[] = [];
  for (const f of modules()) {
    // 注释换成等长空白（保留行号），免得说明文字里的“el.append(null)”被当成代码
    const s = readFileSync(join(consoleDir, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
      .replace(/(^|[^:"'])\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
    for (const m of s.matchAll(/[\w\])]\.append\(/g)) {
      let i = m.index! + m[0].length;
      let depth = 1;
      let top = "";
      while (depth && i < s.length) {
        const c = s[i++]!;
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        else if (depth === 1) top += c;
      }
      if (/\?[^:]*:\s*null\b|\bnull\s*$/.test(top.replace(/\s+/g, " ").trim())) bad.push(`${f}:${s.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(bad, []);
});
