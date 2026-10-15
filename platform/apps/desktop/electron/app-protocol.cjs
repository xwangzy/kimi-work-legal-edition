/**
 * 界面经特权自定义协议 kwl://app/ 提供（第 4 批复核 B4-A03）：熔断 grantFileProtocolExtraPrivileges=false 之后，file:// 页面的源是 null，
 * Chromium 会拦下 vite 产物的模块脚本与带 crossorigin 的样式，安装包打开即空白。改为标准、安全的自定义协议后同源规则正常，熔断保持关闭。
 * - 只读本包 dist 目录内、已知类型的文件；目录外、未知类型、非 GET 一律 404；
 * - 生产形态渲染进程不再访问任何 file:// 地址（地址策略见 url-policy.cjs）。
 * resolveAppFile / contentTypeOf 是纯函数（不依赖 electron），可在 Node 下单测。
 */
const path = require("node:path");

const APP_SCHEME = "kwl";
const APP_HOST = "app";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** kwl://app/<路径> → dist 内的文件绝对路径；不在 dist 内、类型未知或地址不合法时返回 null。 */
function resolveAppFile(distDir, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null;
  let rel;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  if (rel === "" || rel === "/") rel = "/index.html";
  const dist = path.resolve(distDir);
  const file = path.resolve(dist, `.${rel}`);
  if (!file.startsWith(dist + path.sep)) return null;
  if (!TYPES[path.extname(file).toLowerCase()]) return null;
  return file;
}

function contentTypeOf(file) {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** 须在 app ready 之前调用（Chromium 启动时登记协议特权）。 */
function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
  ]);
}

/** ready 之后在窗口所用会话上挂处理器；readFile 注入（主进程用 fs.promises.readFile，可读 asar 内文件）。 */
function handleAppProtocol(protocol, distDir, readFile) {
  protocol.handle(APP_SCHEME, async (req) => {
    const file = req.method === "GET" ? resolveAppFile(distDir, req.url) : null;
    if (!file) return new Response("not found", { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: { "content-type": contentTypeOf(file), "x-content-type-options": "nosniff", "cache-control": "no-store" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

module.exports = { APP_SCHEME, APP_HOST, APP_ORIGIN, APP_INDEX_URL, resolveAppFile, contentTypeOf, registerAppScheme, handleAppProtocol };
