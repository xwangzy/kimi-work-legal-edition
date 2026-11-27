// 故障注入轮的事件时间线：node faults.mjs —— 读 results-rerun.jsonl 里 fault* 轮，列出点击后各计时 / 同步 / 失败事件（相对点击的毫秒，100 ms 采样）
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(join(here, "results-rerun.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.tag.startsWith("fault"));
const KEEP = /CP_SYNC|AI_READY|ONB_|ONBOARDING|RESTART|KERNEL_READY|SPAWNED|STOPPED|SEAT|REGISTER|RETRY|FAIL|ERROR|DENIED|GATE_STARTED|PROFILE_SWITCH|ACCOUNT/;
for (const r of rows) for (const p of ["A", "B"]) {
  const x = r[p];
  if (!x) continue;
  console.log(`\n## ${r.tag} 路径 ${p}：首屏 ${x.ms ?? "—"} ms，出口文案首次 ${x.err_first_ms ?? "—"} ms，文案 ${JSON.stringify(x.errors)}`);
  for (const e of x.events ?? []) if (KEEP.test(e[3]) || e[2] !== "info") console.log(`  +${(e[0] / 1000).toFixed(1)}s ${e[1]} ${e[2]} ${e[3]} ${e[4]}`);
  const sq = x.seq ?? [];
  console.log("  文字序列：" + sq.filter((s, i) => i === 0 || s[1].slice(0, 40) !== sq[i - 1][1].slice(0, 40)).slice(0, 14).map((s) => `${(s[0] / 1000).toFixed(1)}s ${s[1].replace(/^Kimi Work 法律版 /, "").slice(0, 50)}`).join(" → "));
}
