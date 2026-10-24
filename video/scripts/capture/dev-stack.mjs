// 宣传片采集：vite（5220）+ 脚本模型开发桥（7800），数据在 /tmp/kwl-film-capture（见 video/README.md）
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
const D = "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/platform/apps/desktop";
const env = { ...process.env, KWL_DEV_WEB_PORT: "5220", ZR_DEV_BRIDGE_PORT: "7800", ZR_KERNEL_DATA_DIR: "/tmp/kwl-film-capture/devdata", ZR_FIRM_SLUG: "dev-firm", ZR_USER_SLUG: "dev-lawyer", ZR_BACKUP_TIMER: "off", ZR_INTERNAL_SECRET: randomBytes(16).toString("hex"), ZR_MODEL_PROVIDER: "mock" };
const kids = [spawn(process.execPath, ["/Users/wangzeyu/Documents/Coding/Kimi Work Legal/video/scripts/capture/script-bridge.ts"], { cwd: D, env, stdio: "inherit" }), spawn("npx", ["vite", "--port", "5220", "--strictPort", "--host", "127.0.0.1"], { cwd: D, env, stdio: "inherit" })];
const stop = () => { for (const k of kids) k.kill("SIGTERM"); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
