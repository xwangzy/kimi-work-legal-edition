/**
 * Web 开发桥（仅开发模式）：浏览器调试时 Electron IPC 不可用，
 * 以最小 HTTP 包装内核 invoke（POST /invoke {method, params}）。
 * 生产形态是 Electron utilityProcess IPC；本桥不进生产包。
 *
 * 只接受来自本机 vite 开发页（127.0.0.1:5173 / localhost:5173）且带开发桥令牌的请求（W1：审批、还原等接口在开发形态同样不能被其他网页调用）。
 */
import { createServer } from "node:http";
import { createKernel } from "@zr-legal/kernel";
import { bridgeToken } from "./bridge-token.ts";

const PORT = Number(process.env.ZR_DEV_BRIDGE_PORT ?? 7720);
let kernel = await createKernel();
console.log(`[bridge] kernel up, localPort=${kernel.localPort}, workspace=${kernel.config.workspaceDir}`);
// 开通或入组完成（第 13 批）：与安装包主进程一样按 activation.json 重建内核；重建期间的请求等它就绪
let ready: Promise<void> = Promise.resolve();
const watchIdentity = (k: typeof kernel) =>
  k.onBroadcast((m) => {
    // 从备份恢复（第 14 批）：开发形态没有 DPAPI，直接以恢复的主密钥重建内核（只在待激活模式）
    if (m.type === "kernel.adopt_master_key" && k.config.onboarding && typeof m.key === "string") process.env.ZR_DB_KEY = m.key;
    else if (m.type !== "kernel.restart_for_identity") return;
    ready = (async () => {
      await k.close().catch(() => {});
      kernel = await createKernel();
      watchIdentity(kernel);
      console.log(`[bridge] kernel restarted for identity, workspace=${kernel.config.workspaceDir}`);
    })();
  });
watchIdentity(kernel);

// 令牌：先到者随机生成并写入 dev/.bridge-token（vite 读取后注入开发页）；ZR_DEV_BRIDGE_TOKEN 可覆盖
const BRIDGE_TOKEN = bridgeToken();
const WEB_PORT = Number(process.env.KWL_DEV_WEB_PORT ?? 5173);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${WEB_PORT}`, `http://localhost:${WEB_PORT}`]);

const server = createServer((req, res) => {
  const origin = String(req.headers.origin ?? "");
  if (!ALLOWED_ORIGINS.has(origin)) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: { code: "forbidden", message: "开发桥只接受本机开发页的请求" } }));
  }
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,x-kwl-token");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== "POST" || req.url !== "/invoke") {
    res.writeHead(404);
    return res.end();
  }
  if (req.headers["x-kwl-token"] !== BRIDGE_TOKEN) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: { code: "forbidden", message: "开发桥令牌不符" } }));
  }
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      // 保持 {}
    }
    try {
      await ready;
      const result = await kernel.invoke(String(body.method), body.params ?? {});
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      const err = e as any;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { code: err?.code ?? "internal", message: err?.message ?? String(e), detail: err?.detail } }));
    }
  })();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] dev bridge listening on http://127.0.0.1:${PORT}/invoke`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void kernel.close().then(() => process.exit(0));
  });
}
