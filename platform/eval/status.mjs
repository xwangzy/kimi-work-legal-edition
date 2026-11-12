// 全部登记任务的状态。用法：node eval/status.mjs [--json]
// node eval/status.mjs --wait [分钟]：等到有任务的提问超过 60 秒没人回答，或全部到终态，或到时间（缺省 8 分钟）；输出待回答的任务（每行一个 JSON）、ALLDONE 或 TICK。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL, WORK, inv, runsOf, sleep, stacks } from "./lib.mjs";

async function rows() {
  const out = [];
  for (const w of stacks()) {
    for (const [tag, run, mat] of runsOf(w)) {
      try {
        const g = await inv(w, "runs.get", { run_id: run });
        out.push({ stack: w.name, tag, run, mat, status: g.run.status, arts: g.artifacts.length });
      } catch {
        out.push({ stack: w.name, tag, run, mat, status: "err", arts: 0 });
      }
    }
  }
  return out;
}

const args = process.argv.slice(2);
if (args[0] === "--wait") {
  const seenF = join(WORK, ".wait.seen");
  const seen = existsSync(seenF) ? JSON.parse(readFileSync(seenF, "utf8")) : {};
  const T = Date.now();
  const MAX = Number(args[1] ?? 8) * 60000;
  const since = {};
  for (;;) {
    const rs = await rows();
    const active = rs.filter((r) => !TERMINAL.test(r.status)).length;
    const out = [];
    for (const r of rs) {
      if (r.status !== "waiting_input") {
        delete since[r.run];
        continue;
      }
      since[r.run] ??= Date.now();
      // 已报告过的 4 分钟内不重复报
      if (Date.now() - since[r.run] > 60000 && Date.now() - (seen[r.run] ?? 0) > 240000) {
        seen[r.run] = Date.now();
        out.push(JSON.stringify(r));
      }
    }
    if (out.length) {
      writeFileSync(seenF, JSON.stringify(seen));
      console.log(out.join("\n"));
      break;
    }
    if (rs.length > 0 && active === 0) {
      console.log("ALLDONE");
      break;
    }
    if (Date.now() - T > MAX) {
      console.log(`TICK active=${active} total=${rs.length}`);
      break;
    }
    await sleep(15000);
  }
} else {
  const rs = await rows();
  if (args.includes("--json")) console.log(JSON.stringify(rs));
  else {
    const c = {};
    for (const r of rs) c[r.status] = (c[r.status] ?? 0) + 1;
    console.log(JSON.stringify(c));
    for (const r of rs) console.log(r.stack.padEnd(6), r.tag.padEnd(34), r.status.padEnd(16), r.arts);
  }
}
