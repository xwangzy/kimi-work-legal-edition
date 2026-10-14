import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 渲染进程 CSP（v9 第 04 篇 §5.1 ③：default-src 'none' 起步）：生产只允许本包脚本与样式、data:/blob: 图片，不允许任何网络连接
 * （界面经主进程 IPC 调用内核）；开发形态另允许 vite 热更新与本机开发桥。Agent 产物在 sandbox 隔离框架中预览（srcdoc，另注入更严的策略）。
 */
function csp(dev: boolean): string {
  return [
    "default-src 'none'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    dev ? "connect-src 'self' http://127.0.0.1:7720 ws://127.0.0.1:5173" : "connect-src 'none'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

function cspPlugin(): Plugin {
  let dev = true;
  return {
    name: "kwl-csp",
    configResolved(c) {
      dev = c.command === "serve";
    },
    transformIndexHtml(html) {
      return html.replace("%KWL_CSP%", csp(dev));
    },
  };
}

export default defineConfig(async ({ command }) => {
  // 开发桥令牌（只在开发形态注入；生产经 IPC，不经开发桥）
  const define: Record<string, string> = {};
  if (command === "serve") {
    const { bridgeToken } = await import("./dev/bridge-token.ts");
    define["import.meta.env.VITE_KWL_BRIDGE_TOKEN"] = JSON.stringify(bridgeToken());
  }
  return {
    plugins: [react(), cspPlugin()],
    base: "./",
    define,
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
    build: { outDir: "dist", target: "es2022" },
  };
});
