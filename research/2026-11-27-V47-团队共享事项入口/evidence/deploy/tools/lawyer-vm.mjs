// 律师端网页开发形态（vite + 开发桥），云端指向 Lima 虚机 kwl-deploy（演示 CA + 钉住）。用法：node lawyer-vm.mjs <env.json> <工作区目录> <vite端口> <桥端口>
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
const [envFile, ws, web, bridge] = process.argv.slice(2);
const env = { ...process.env, ...JSON.parse(readFileSync(envFile, "utf8")) };
Object.assign(env, { ZR_KERNEL_DATA_DIR: resolve(ws), ZR_INTERNAL_SECRET: randomBytes(24).toString("base64url"), ZR_BACKUP_TIMER: "off", ZR_DEMO_SAMPLES: "0", KWL_DEV_WEB_PORT: web, ZR_DEV_BRIDGE_PORT: bridge });
delete env.KWL_MOONSHOT_API_KEY; delete env.ZR_FIRM_SLUG; delete env.ZR_USER_SLUG; delete env.NODE_EXTRA_CA_CERTS;
const D = "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/kimi-legal-b72/platform/apps/desktop";
const kids = [spawn("npx", ["vite", "--port", web, "--strictPort", "--host", "127.0.0.1"], { cwd: D, env, stdio: "inherit" }), spawn(process.execPath, ["dev/bridge.ts"], { cwd: D, env, stdio: "inherit" })];
const stop = () => { for (const k of kids) try { k.kill("SIGTERM"); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
for (const k of kids) k.on("exit", (c) => { console.log("[lawyer] child exit", c); stop(); });
