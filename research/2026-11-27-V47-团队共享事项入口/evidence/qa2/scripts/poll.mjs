// node poll.mjs <vite端口> <事项标题片段> [最长秒数]：每 5 秒看 matters.list 和 relay/status，出现即退出
import { execFileSync } from "node:child_process";
const [, , web, frag, max = "900"] = process.argv;
const inv = (m, p) => execFileSync(process.execPath, [new URL("../inv.mjs", import.meta.url).pathname, web, m, p || "{}"], { env: { ...process.env, N: "200000" } }).toString();
const t0 = Date.now();
let last = "";
while ((Date.now() - t0) / 1000 < Number(max)) {
  const ml = inv("matters.list");
  const st = inv("kernel.status");
  const allowed = /"share_relay_allowed": true/.test(st);
  const line = `allowed=${allowed} has=${ml.includes(frag)}`;
  if (line !== last) { console.log(new Date().toISOString(), line); last = line; }
  if (ml.includes(frag)) { console.log("FOUND after", Math.round((Date.now() - t0) / 1000), "s of polling"); break; }
  await new Promise((r) => setTimeout(r, 5000));
}
