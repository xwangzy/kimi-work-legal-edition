/**
 * 首次登记 / 换账号 / 切换工作空间的分段耗时（第 72 批，A1 §2.4 T1）：读内核与主进程写进脱敏日志的计时事件，按出现先后排成一张表。
 *
 * 日志在 <数据根>/<各工作区>/logs/kwl-YYYYMMDD*.jsonl（每行 {t, lvl, code, proc, f}，t 为秒级 UTC；只有毫秒数、布尔与封闭枚举，
 * 没有身份与内容）。待激活内核的日志在 <数据根>/pending-activation/logs/，**激活后这个目录会被删掉**——测路径 A / B 时用 --watch
 * 在操作前启动、操作完按 Ctrl-C（或 --duration 到时），脚本边跑边把新出现的行收进内存（可 --out 另存），删掉的目录也不丢。
 *
 * 数据根：macOS ~/Library/Application Support/KimiWorkLegal；Windows %APPDATA%\KimiWorkLegal（开发形态另见 ZR_LOCAL_ROOT）。
 *
 * 用法：
 *   node scripts/measure-enroll.mjs --data <数据根> --watch [--duration 120] [--out run-a1.jsonl]   # 先启动，再在应用里登录 / 切换
 *   node scripts/measure-enroll.mjs --data <数据根> [--since 2026-11-27T08:00:00Z]                  # 事后读现有日志（待激活那段可能已删）
 *   node scripts/measure-enroll.mjs --file run-a1.jsonl [--file run-a2.jsonl …] [--format json]     # 读 --out 存下的几轮，逐轮出表 + 各段中位数
 *
 * 表里每行：事件、分段、毫秒；末尾按 A1 的阶段归并：登录 → 补取认领 → 自动登记（含云端签名）→ 写暂存 → 关旧内核 → 取库密钥 / fork →
 * 内核启动各阶段 → 闸门核对 / 拉起 → 首次同步（register / 文档 / 席位）→ AI 可用。“轮”以 KERNEL_ONB_STEP(login) 或 MAIN_KERNEL_RESTARTED 之前的
 * 第一条事件为界；--file 每个文件算一轮。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const opts = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const has = (name) => argv.includes(name);

/** 计时相关的事件码 → 表里的分段名（取 ms 字段；没有 ms 的只作锚点）。 */
const TIMED = {
  KERNEL_ONB_STEP: (f) => `待激活·${f.step}${f.ok === false ? "（失败）" : ""}`,
  KERNEL_ONBOARDING_AUTO_ENROLLED: () => "待激活·自动登记完成（锚点）",
  MAIN_KERNEL_IDENTITY_RESTART: () => "主进程·收到按身份重启（锚点）",
  MAIN_PROFILE_SWITCH: (f) => `主进程·切换档案 ${f.kind}（锚点）`,
  MAIN_KERNEL_STOPPED: (f) => `主进程·关旧内核（${f.how}）`,
  KERNEL_CLOSED: () => "内核·close()",
  MAIN_KERNEL_SPAWNED: () => "主进程·取库密钥 / fork",
  KERNEL_BOOT_PHASE: (f) => `内核启动·${f.phase}${f.onboarding ? "（待激活）" : ""}`,
  MAIN_KERNEL_READY: (f) => `主进程·fork→就绪${f.onboarding ? "（待激活）" : ""}`,
  MAIN_KERNEL_RESTARTED: (f) => `主进程·整次重启 ${f.trigger}（${f.result}）`,
  MAIN_RUNTIME_VERIFIED: (f) => `主进程·随包核对 ${f.scope}`,
  KERNEL_GATE_HASH: (f) => `闸门·运行时核对（${f.how}）`,
  KERNEL_GATE_STARTED: () => "闸门·拉起（含等待核对）",
  KERNEL_CP_SYNC: (f) => `同步${f.first ? "（首轮）" : ""}·总计${f.ok ? "" : "（未全成）"}`,
  KERNEL_AI_READY: () => "AI 可用（内核启动以来）",
};
/** 毫秒取哪个字段。 */
const MS_FIELD = { MAIN_RUNTIME_VERIFIED: "ms", KERNEL_AI_READY: "since_boot_ms", KERNEL_GATE_STARTED: "ms" };

function logFiles(root) {
  const out = [];
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(root, e.name, "logs"));
  } catch {
    return out;
  }
  for (const d of dirs) {
    try {
      for (const n of readdirSync(d)) if (/^kwl-(?:\d{8}|\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/.test(n)) out.push(join(d, n));
    } catch {
      // 没有日志目录
    }
  }
  return out;
}

function parseLines(text) {
  const recs = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.code === "string") recs.push(r);
    } catch {
      // 半行（正在写）：下次再读
    }
  }
  return recs;
}

/** 一条事件 → 表行（不计时的事件返回 null）。 */
function rowOf(r, seq) {
  const label = TIMED[r.code]?.(r.f ?? {});
  if (!label) return null;
  const f = r.f ?? {};
  const ms = typeof f[MS_FIELD[r.code] ?? "ms"] === "number" ? f[MS_FIELD[r.code] ?? "ms"] : null;
  const extra = r.code === "KERNEL_CP_SYNC" ? ` register=${f.register_ms ?? "-"} docs=${f.docs_ms ?? "-"} seat=${f.seat_ms ?? "-"}（${f.seat}）` : r.code === "MAIN_KERNEL_SPAWNED" ? ` key=${f.key_ms} fork=${f.fork_ms}` : "";
  return { seq, t: r.t, proc: r.proc, code: r.code, label, ms, extra };
}

/** 切成几轮：每个“登录”或“整次重启”之前出现的第一条计时事件为界（同一轮里的重启不另起）。 */
function splitRuns(rows) {
  const runs = [];
  let cur = [];
  for (const r of rows) {
    const starts = r.code === "KERNEL_ONB_STEP" && r.label.startsWith("待激活·login");
    if (starts && cur.length && cur.some((x) => x.code === "KERNEL_AI_READY" || x.code === "MAIN_KERNEL_READY")) {
      runs.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

function printRun(rows, title) {
  process.stdout.write(`\n## ${title}\n\n| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |\n|---|---|---|---|---:|---|\n`);
  rows.forEach((r, i) => process.stdout.write(`| ${i + 1} | ${String(r.t).slice(11, 19)} | ${r.proc} | ${r.label} | ${r.ms ?? ""} | ${r.extra.trim()} |\n`));
  const sum = rows.filter((r) => r.ms !== null && !r.label.includes("整次重启") && !r.label.includes("AI 可用") && !r.label.startsWith("主进程·fork→就绪") && !r.label.startsWith("主进程·随包核对") && r.code !== "KERNEL_CLOSED" && r.code !== "KERNEL_GATE_STARTED").reduce((n, r) => n + r.ms, 0);
  const restart = rows.filter((r) => r.label.includes("整次重启")).map((r) => r.ms);
  const ai = rows.filter((r) => r.code === "KERNEL_AI_READY").map((r) => r.ms);
  process.stdout.write(`\n串行分段合计约 ${sum} ms；整次重启 ${restart.join(" / ") || "-"} ms；AI 可用（新内核启动以来）${ai.join(" / ") || "-"} ms\n`);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}

function report(allRuns) {
  if (has("--format") && opt("--format") === "json") {
    process.stdout.write(`${JSON.stringify(allRuns.map((rows) => rows.map(({ t, proc, code, label, ms }) => ({ t, proc, code, label, ms }))), null, 2)}\n`);
    return;
  }
  allRuns.forEach((rows, i) => printRun(rows, `第 ${i + 1} 轮（${rows.length} 条计时事件）`));
  if (allRuns.length > 1) {
    const byLabel = new Map();
    for (const rows of allRuns) for (const r of rows) if (r.ms !== null) byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), r.ms]);
    process.stdout.write(`\n## 各分段中位数（${allRuns.length} 轮）\n\n| 分段 | 中位数 ms | 次数 |\n|---|---:|---:|\n`);
    for (const [label, xs] of byLabel) process.stdout.write(`| ${label} | ${median(xs)} | ${xs.length} |\n`);
  }
}

function rowsFrom(recs, since) {
  return recs
    .filter((r) => !since || String(r.t) >= since)
    .map((r, i) => rowOf(r, i))
    .filter(Boolean);
}

const files = opts("--file");
if (files.length) {
  report(files.map((f) => rowsFrom(parseLines(readFileSync(f, "utf8")), opt("--since"))));
} else {
  const root = opt("--data");
  if (!root || !existsSync(root)) {
    process.stderr.write("请用 --data 给出数据根（macOS ~/Library/Application Support/KimiWorkLegal；Windows %APPDATA%\\KimiWorkLegal），或用 --file 读存下的记录\n");
    process.exit(2);
  }
  if (!has("--watch")) {
    const recs = logFiles(root).flatMap((f) => parseLines(readFileSync(f, "utf8")));
    recs.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    report(splitRuns(rowsFrom(recs, opt("--since"))));
  } else {
    // 边跑边收：每 200 ms 看一遍各工作区的日志，读新增的部分（待激活目录激活后被删也不丢）
    const out = opt("--out");
    if (out) writeFileSync(out, "");
    const offsets = new Map();
    const recs = [];
    const poll = () => {
      for (const f of logFiles(root)) {
        let size = 0;
        try {
          size = statSync(f).size;
        } catch {
          continue;
        }
        // 启动后才出现的文件（如待激活内核的日志）从头读
        const from = offsets.get(f) ?? 0;
        if (size <= from) {
          offsets.set(f, size);
          continue;
        }
        const buf = readFileSync(f).subarray(from, size).toString("utf8");
        const cut = buf.lastIndexOf("\n");
        if (cut < 0) continue;
        offsets.set(f, from + Buffer.byteLength(buf.slice(0, cut + 1)));
        const got = parseLines(buf.slice(0, cut + 1));
        recs.push(...got);
        if (out && got.length) appendFileSync(out, got.map((r) => JSON.stringify(r)).join("\n") + "\n");
        for (const r of got) {
          const row = rowOf(r, recs.length);
          if (row) process.stderr.write(`  ${String(row.t).slice(11, 19)} ${row.label} ${row.ms ?? ""}${row.extra}\n`);
        }
      }
    };
    // 先登记现有文件的末尾（只收之后的新行）
    for (const f of logFiles(root)) {
      try {
        offsets.set(f, has("--from-start") ? 0 : statSync(f).size);
      } catch {}
    }
    const timer = setInterval(poll, 200);
    const finish = () => {
      clearInterval(timer);
      poll();
      report(splitRuns(rowsFrom(recs)));
      process.exit(0);
    };
    process.on("SIGINT", finish);
    const dur = Number(opt("--duration") ?? 0);
    if (dur > 0) setTimeout(finish, dur * 1000);
    process.stderr.write(`正在收集 ${root} 下的计时事件（Ctrl-C 结束${dur > 0 ? `，或 ${dur} 秒后` : ""}）…\n`);
  }
}
