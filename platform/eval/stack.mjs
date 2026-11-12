// 起一套真实模型的测试栈（界面 + 内核开发桥 + 本机网关），前台运行，Ctrl-C 停。一般不直接用，用 up.mjs 按 stacks.json 后台起。
// 用法：node eval/stack.mjs <栈名>
// 上游密钥只从 macOS 钥匙串读（KWL_EVAL_KEYCHAIN_ACCOUNT / _SERVICE，缺省 kwl-demo / kwl-demo-maas-key），只交给网关进程；日志里遮盖密钥与席位令牌。
// 别的系统上先把密钥放进环境变量 KWL_MOONSHOT_API_KEY 再起（不要写进任何文件）。
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM, stackDir, stackOf, syncMaterials } from "./lib.mjs";

const w = stackOf(process.argv[2] ?? "");
const DIR = stackDir(w);
mkdirSync(DIR, { recursive: true });
// 题库材料与界面驱动脚本同步到界面开发服务器的目录；经 up.mjs 起的已由它同步过一次
if (process.env.KWL_EVAL_SYNCED !== "1") syncMaterials();

const BASE = process.env.KWL_EVAL_UPSTREAM_BASE ?? "https://maas.jointpilot.com/v1";
const MODEL = w.model ?? process.env.KWL_EVAL_MODEL ?? "kimi-k3.1-pro";
const key = process.env.KWL_MOONSHOT_API_KEY ?? execFileSync("/usr/bin/security", ["find-generic-password", "-a", process.env.KWL_EVAL_KEYCHAIN_ACCOUNT ?? "kwl-demo", "-s", process.env.KWL_EVAL_KEYCHAIN_SERVICE ?? "kwl-demo-maas-key", "-w"], { encoding: "utf8" }).trim();
if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error("上游密钥格式不对（未输出内容）");
const secrets = [key];
const mask = (s) => secrets.reduce((t, x) => (x ? t.split(x).join("[已遮盖]") : t), s);
const log = createWriteStream(join(DIR, "stack.log"), { flags: "a" });
const out = (tag) => (d) => log.write(mask(String(d)).split("\n").filter((l) => l.length > 0).map((l) => `[${tag}] ${l}\n`).join(""));
const kids = [];
const stop = (code = 0) => {
  for (const k of kids) k.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const gw = spawn(process.execPath, ["scripts/dev-cloud-v0.mjs"], { cwd: PLATFORM, env: { ...process.env, KWL_MOONSHOT_API_KEY: key, KWL_MOONSHOT_BASE: BASE, KWL_CLOUD_DIR: join(DIR, "cloud"), KWL_GATEWAY_PORT: String(w.gw), KWL_SEARCH_PORT: String(w.search), KWL_UPSTREAM_K3: MODEL }, stdio: ["ignore", "pipe", "pipe"] });
kids.push(gw);
gw.stderr.on("data", out("网关"));
gw.on("exit", (c) => {
  out("网关")(`已退出（${c}）`);
  stop(1);
});
const exported = {};
await new Promise((resolve) => {
  let buf = "";
  gw.stdout.setEncoding("utf8");
  gw.stdout.on("data", (d) => {
    buf += d;
    for (const m of buf.matchAll(/^export (ZR_[A-Z_]+)=(.*)$/gm)) exported[m[1]] = m[2];
    if (exported.ZR_SEAT_TOKEN && !secrets.includes(exported.ZR_SEAT_TOKEN)) secrets.push(exported.ZR_SEAT_TOKEN);
    if (/# 计量/.test(buf)) {
      out("网关")(buf);
      gw.stdout.on("data", out("网关"));
      resolve();
    }
  });
});
const { KWL_MOONSHOT_API_KEY: _k, KWL_MOONSHOT_BASE: _b, ...baseEnv } = process.env;
// ZR_AT_REST=off：账本不加密，跑完可以直接用 ledger-summary.mjs 读用量与耗时（只用于测试栈）
const env = { ZR_AT_REST: "off", ZR_KERNEL_CONCURRENCY: "3", ZR_KAP_CONCURRENCY: "3", ...baseEnv, ...exported, KWL_DEV_WEB_PORT: String(w.web), ZR_DEV_BRIDGE_PORT: String(w.bridge), ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_DATA_DIR: join(DIR, "web-data"), ZR_FIRM_SLUG: "demo-firm", ZR_USER_SLUG: "demo-lawyer", ZR_BACKUP_TIMER: "off" };
const D = join(PLATFORM, "apps/desktop");
for (const [tag, cmd, args] of [
  ["界面", "npx", ["vite", "--port", String(w.web), "--strictPort", "--host", "127.0.0.1"]],
  ["内核", process.execPath, ["dev/bridge.ts"]],
]) {
  const k = spawn(cmd, args, { cwd: D, env, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(k);
  k.stdout.on("data", out(tag));
  k.stderr.on("data", out(tag));
  k.on("exit", (c) => {
    out(tag)(`已退出（${c}）`);
    stop(c ?? 1);
  });
}
out("栈")(`${w.name}：http://127.0.0.1:${w.web}/ 上游型号 ${MODEL}`);
