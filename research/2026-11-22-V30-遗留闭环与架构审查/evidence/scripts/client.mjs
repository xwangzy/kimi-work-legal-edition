// 起一个浏览器形态的客户端（vite + 开发桥 + 内核），连本机栈。用法：node client.mjs <栈目录> <名字> <web端口> <桥端口>
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, createWriteStream, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const [dir, name, web, bridge] = process.argv.slice(2);
const desktop = "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/kimi-legal-architecture-review-c6783f/platform/apps/desktop";
const env = { ...process.env };
for (const l of readFileSync(`${dir}/client.env`, "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1); }
delete env.ZR_FIRM_SLUG;
const data = `${dir}/clients/${name}`;
mkdirSync(data, { recursive: true });
const token = randomBytes(24).toString("base64url");
writeFileSync(`${data}/bridge.json`, JSON.stringify({ web: Number(web), bridge: Number(bridge), token }), { mode: 0o600 });
Object.assign(env, { ZR_KERNEL_DATA_DIR: `${data}/data`, KWL_DEV_WEB_PORT: web, ZR_DEV_BRIDGE_PORT: bridge, ZR_DEV_BRIDGE_TOKEN: token, ZR_AT_REST: "off", ...(process.env.KWL_CLIENT_EXTRA ? JSON.parse(process.env.KWL_CLIENT_EXTRA) : {}) });
const log = createWriteStream(`${data}/client.log`, { flags: "a" });
const kids = [];
const run = (cmd, args) => { const p = spawn(cmd, args, { cwd: desktop, env, stdio: ["ignore", "pipe", "pipe"] }); p.stdout.pipe(log, { end: false }); p.stderr.pipe(log, { end: false }); kids.push(p); p.on("exit", (c) => { log.write(`[client] ${args.join(" ")} exit ${c}\n`); for (const k of kids) k.kill("SIGTERM"); process.exit(0); }); };
run(process.execPath, ["dev/bridge.ts"]);
run(process.execPath, ["../../node_modules/vite/bin/vite.js"]);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { for (const k of kids) k.kill("SIGTERM"); process.exit(0); });
