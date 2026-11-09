/**
 * 模拟 Kimi 账号中心（第 40 批，只用于开发、演示与用例）：实现控制面用到的三个接口，行为与 Kimi Code `kimi login` 的设备授权一致——
 *   POST /api/oauth/device_authorization  （client_id）→ device_code、user_code、verification_uri(_complete)、expires_in、interval
 *   POST /api/oauth/token                 （device_code、grant_type）→ authorization_pending / access_token / access_denied / expired_token
 *   GET  /me                              （Bearer）→ user_id、nickname、phone（打码）、user_level_name
 * 另有一张授权页 GET /device?user_code=…：选一个演示账号点“授权”（模拟律师在浏览器里登录 Kimi 并确认）。
 *
 * 正式环境连的是 auth.kimi.com 与法律版自己的 client_id；这里不校验 client_id 是否登记，只要求非空。
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const DEMO_KIMI_ACCOUNTS = [
  { user_id: "u_demo_zhang", nickname: "张明远", phone: { country_code: "86", number: "138****0001" }, user_level_name: "Allegro" },
  { user_id: "u_demo_li", nickname: "李书瑶", phone: { country_code: "86", number: "139****0002" }, user_level_name: "Moderato" },
  { user_id: "u_demo_wang", nickname: "王子衡", phone: { country_code: "86", number: "136****0003" }, user_level_name: "Vivace" },
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** 启动模拟账号中心；返回 { base, close, approve(user_code, idx) }。 */
export async function startMockKimi(o = {}) {
  const flows = new Map(); // device_code → { user_code, status, account, expires }
  const tokens = new Map(); // access_token → account
  const accounts = o.accounts ?? DEMO_KIMI_ACCOUNTS;
  let base = "";
  const readBody = (req) =>
    new Promise((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const byUserCode = (code) => [...flows.values()].find((f) => f.user_code === code);
  const approve = (code, idx = 0, deny = false) => {
    const f = byUserCode(code);
    if (!f || f.expires < Date.now()) return false;
    f.status = deny ? "denied" : "approved";
    f.account = accounts[Math.max(0, Math.min(accounts.length - 1, idx))];
    return true;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "POST" && url.pathname === "/api/oauth/device_authorization") {
        const b = new URLSearchParams(await readBody(req));
        if (!b.get("client_id")) return json(res, 400, { error: "invalid_client" });
        const device_code = randomBytes(24).toString("base64url");
        const user_code = `${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
        flows.set(device_code, { user_code, status: "pending", account: null, expires: Date.now() + 600_000 });
        return json(res, 200, { device_code, user_code, verification_uri: `${base}/device`, verification_uri_complete: `${base}/device?user_code=${user_code}`, expires_in: 600, interval: o.interval ?? 2 });
      }
      if (req.method === "POST" && url.pathname === "/api/oauth/token") {
        const b = new URLSearchParams(await readBody(req));
        const f = flows.get(b.get("device_code") ?? "");
        if (!f || f.expires < Date.now()) return json(res, 400, { error: "expired_token" });
        if (f.status === "pending") return json(res, 400, { error: "authorization_pending" });
        flows.delete(b.get("device_code"));
        if (f.status === "denied") return json(res, 400, { error: "access_denied" });
        const at = `mock_at_${randomBytes(16).toString("hex")}`;
        tokens.set(at, f.account);
        return json(res, 200, { access_token: at, refresh_token: `mock_rt_${randomBytes(8).toString("hex")}`, expires_in: 900, token_type: "Bearer", scope: "kimi-code" });
      }
      if (req.method === "GET" && url.pathname === "/me") {
        const tok = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
        const a = tokens.get(tok);
        if (!a) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, { ...a, status: "USER_STATUS_NORMAL", region: "REGION_CN", user_level: 30, domain: 1, domain_name: "DOMAIN_KIMI" });
      }
      if (req.method === "GET" && url.pathname === "/device") {
        const code = url.searchParams.get("user_code") ?? "";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Kimi 账号授权（模拟）</title>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;background:#fbfaf9;color:#0e1219;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="post" action="/device/approve" style="background:#fff;border:1px solid #ebe9e5;border-radius:20px;padding:28px;width:360px;box-shadow:0 8px 24px rgba(0,0,0,.06)">
<div style="font-size:13px;color:#6b6f76">模拟 Kimi 账号中心 · 仅开发演示</div>
<h2 style="margin:6px 0 4px">授权 Kimi Work 法律版</h2>
<p style="color:#3f434a;font-size:14px">核对验证码与客户端上显示的一致：</p>
<div style="font:600 24px 'SF Mono',monospace;letter-spacing:.1em;background:#f6f5f3;border-radius:12px;padding:10px 14px;margin:8px 0 16px">${esc(code)}</div>
<input type="hidden" name="user_code" value="${esc(code)}">
<label style="font-size:13px;color:#3f434a">以哪个 Kimi 账号登录<br><select name="account" style="width:100%;height:38px;border-radius:12px;border:1px solid #d9d6d0;margin-top:6px;padding:0 10px;font:inherit">
${accounts.map((a, i) => `<option value="${i}">${esc(a.nickname)}（${esc(a.phone.number)}）</option>`).join("")}</select></label>
<div style="display:flex;gap:8px;margin-top:18px"><button name="act" value="ok" style="flex:1;height:40px;border:0;border-radius:10px;background:#191919;color:#fff;font:inherit;cursor:pointer">授权</button>
<button name="act" value="deny" style="height:40px;border:1px solid #d9d6d0;border-radius:10px;background:#fff;font:inherit;cursor:pointer;padding:0 16px">拒绝</button></div>
</form></body>`);
      }
      if (req.method === "POST" && url.pathname === "/device/approve") {
        const b = new URLSearchParams(await readBody(req));
        const ok = approve(b.get("user_code") ?? "", Number(b.get("account") ?? 0), b.get("act") === "deny");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,'PingFang SC',sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fbfaf9"><p style="font-size:16px">${ok ? (b.get("act") === "deny" ? "已拒绝授权。" : "已授权：回到 Kimi Work 法律版客户端即可。") : "验证码无效或已过期。"}</p></body>`);
      }
      json(res, 404, { error: "not_found" });
    } catch {
      json(res, 500, { error: "server_error" });
    }
  });
  await new Promise((r) => server.listen(o.port ?? 0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    approve,
    pendingCodes: () => [...flows.values()].filter((f) => f.status === "pending").map((f) => f.user_code),
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

// 直接运行：node scripts/lib/dev-kimi-oauth.mjs [端口]
if (import.meta.url === `file://${process.argv[1]}`) {
  const k = await startMockKimi({ port: Number(process.argv[2]) || 17990 });
  console.log(`模拟 Kimi 账号中心：${k.base}（控制面 kimi_account.oauth_host 与 api_base 都填这个地址）`);
}
