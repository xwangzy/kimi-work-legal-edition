// 宣传片 V4 采集栈（真实模型）：本机法律模型网关 v0（上游 = 中软 MaaS，kimi-k3.1-pro）+ vite 界面 + 内核开发桥。
// 与客户演示启动器（.claude/kwl-demo/start-demo-fresh.mjs --web）同一链路：内核 → 出站闸门 → 本机网关 → MaaS。
// - MaaS 密钥只从 macOS 钥匙串读取，只放进网关进程的环境；vite、开发桥、内核拿不到它。所有输出先遮盖再写出。
// - 产品源码：FILM_PLATFORM（缺省 .claude/worktrees/film-v4-capture/platform，第 69 批 e56b568a 的干净检出）。
// - 数据目录：FILM_DATA（全新本机工作区，不连控制面）。
// 用法：FILM_DATA=<目录> node video-v4/scripts/capture/stack-real.mjs   （Ctrl+C / SIGTERM 全停）
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PLATFORM = process.env.FILM_PLATFORM ?? join(REPO, ".claude/worktrees/film-v4-capture/platform");
const DATA = process.env.FILM_DATA ?? "/tmp/kwl-film-v4";
export const WEB_PORT = process.env.FILM_WEB_PORT ?? "5261";
export const BRIDGE_PORT = process.env.FILM_BRIDGE_PORT ?? "7861";
const GW_PORT = process.env.FILM_GW_PORT ?? "17861";
const SEARCH_PORT = process.env.FILM_SEARCH_PORT ?? "17862";
const MAAS_BASE = "https://maas.jointpilot.com/v1";
const MAAS_MODEL_K3 = "kimi-k3.1-pro";
mkdirSync(DATA, { recursive: true });

const key = execFileSync("/usr/bin/security", ["find-generic-password", "-a", "kwl-demo", "-s", "kwl-demo-maas-key", "-w"], { encoding: "utf8" }).trim();
if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error("钥匙串里的 MaaS 密钥格式不对（未输出内容）");
const secrets = [key];
const mask = (s) => secrets.reduce((t, x) => (x ? t.split(x).join("[已遮盖]") : t), s).replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[已遮盖]");
const log = createWriteStream(join(DATA, "stack.log"), { flags: "a" });
const out = (tag) => (d) => {
  const text = mask(String(d)).split("\n").filter((l) => l.length > 0).map((l) => `[${tag}] ${l}\n`).join("");
  process.stdout.write(text);
  log.write(text);
};
const kids = [];
const stop = (code = 0) => {
  for (const k of kids) k.kill("SIGTERM");
  setTimeout(() => process.exit(code), 600);
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const gw = spawn(process.execPath, ["scripts/dev-cloud-v0.mjs"], {
  cwd: PLATFORM,
  env: { ...process.env, KWL_MOONSHOT_API_KEY: key, KWL_MOONSHOT_BASE: MAAS_BASE, KWL_CLOUD_DIR: join(DATA, "cloud"), KWL_GATEWAY_PORT: GW_PORT, KWL_SEARCH_PORT: SEARCH_PORT, KWL_UPSTREAM_K3: MAAS_MODEL_K3, KWL_TENANT: "ten_film-firm" },
  stdio: ["ignore", "pipe", "pipe"],
});
kids.push(gw);
gw.stderr.on("data", out("网关"));
gw.on("exit", (c) => { out("网关")(`已退出（${c}）`); stop(1); });
const exported = {};
await new Promise((resolve) => {
  let buf = "";
  gw.stdout.setEncoding("utf8");
  gw.stdout.on("data", (d) => {
    buf += d;
    for (const m of buf.matchAll(/^export (ZR_[A-Z_]+)=(.*)$/gm)) exported[m[1]] = m[2];
    if (exported.ZR_SEAT_TOKEN && !secrets.includes(exported.ZR_SEAT_TOKEN)) secrets.push(exported.ZR_SEAT_TOKEN);
    if (/# 计量/.test(buf)) { out("网关")(buf); gw.stdout.on("data", out("网关")); resolve(); }
  });
});

const { KWL_MOONSHOT_API_KEY: _k, KWL_MOONSHOT_BASE: _b, ...baseEnv } = process.env;
const env = {
  ...baseEnv, ...exported,
  KWL_DEV_WEB_PORT: WEB_PORT, ZR_DEV_BRIDGE_PORT: BRIDGE_PORT, ZR_MODEL_PROVIDER: "upstream",
  ZR_KERNEL_DATA_DIR: join(DATA, "web-data"), ZR_FIRM_SLUG: "film-firm", ZR_USER_SLUG: "film-lawyer", ZR_BACKUP_TIMER: "off",
};
const D = join(PLATFORM, "apps/desktop");
for (const [tag, cmd, args] of [["界面", "npx", ["vite", "--port", WEB_PORT, "--strictPort", "--host", "127.0.0.1"]], ["内核", process.execPath, ["dev/bridge.ts"]]]) {
  const k = spawn(cmd, args, { cwd: D, env, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(k);
  k.stdout.on("data", out(tag));
  k.stderr.on("data", out(tag));
  k.on("exit", (c) => { out(tag)(`已退出（${c}）`); stop(c ?? 1); });
}
out("采集")(`就绪后打开 http://127.0.0.1:${WEB_PORT}/`);
