#!/usr/bin/env node
// 逐个用例文件运行、每个文件有硬性时限的测试运行器（第 42 批）。
//
// 为什么要有：Windows 上“关键用例”一步连续几次跑满 240 分钟被杀，同一批用例本机十几分钟跑完——是某个文件挂住了（用例结束后句柄或子进程没收，
// 或某个用例一直等），但 `node --test` 整体挂住时日志里看不出是哪一个。这里一次只跑一个文件：超时就连同子进程一起杀掉、记下文件名与最后的输出，
// 接着跑下一个，最后给出通过 / 失败 / 挂起的清单（写进 GitHub 的步骤摘要），有失败或挂起则以 1 退出。
//
// 用法：node scripts/run-tests-watchdog.mjs [--file-timeout-min=15] [--test-timeout-ms=600000] <文件或通配>…
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, globSync } from "node:fs";

const opt = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split("=")[1]) : def;
};
const FILE_TIMEOUT_MS = opt("file-timeout-min", 15) * 60_000;
const TEST_TIMEOUT_MS = opt("test-timeout-ms", 600_000);
const patterns = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const files = [...new Set(patterns.flatMap((p) => (/[*?[]/.test(p) ? globSync(p).sort() : [p])))];
if (files.length === 0) {
  console.error("没有匹配到用例文件");
  process.exit(2);
}

const WIN = process.platform === "win32";
function killTree(child) {
  try {
    if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

function runFile(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", `--test-timeout=${TEST_TIMEOUT_MS}`, file], { stdio: ["ignore", "pipe", "pipe"], detached: !WIN, env: process.env });
    const tail = [];
    let lastTest = "";
    let buf = "";
    const onData = (d) => {
      process.stdout.write(d);
      buf += String(d);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        tail.push(l);
        if (tail.length > 25) tail.shift();
        // spec 报告器：✔ / ✖ 是已结束的用例，▶ 是刚进入的分组
        if (/^\s*[✔✖▶]/.test(l)) lastTest = l.trim().slice(0, 200);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      killTree(child);
    }, FILE_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ file, code, hung, seconds: Math.round((Date.now() - t0) / 1000), lastTest, tail: [...tail] });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ file, code: -1, hung: false, seconds: 0, lastTest, tail: [String(e)] });
    });
  });
}

const results = [];
for (const [i, f] of files.entries()) {
  console.log(`\n===== [${i + 1}/${files.length}] ${f}`);
  const r = await runFile(f);
  results.push(r);
  if (r.hung) console.log(`\n!!!!! 挂起：${f} 超过 ${FILE_TIMEOUT_MS / 60_000} 分钟未结束，已连同子进程终止。最后一个有结果的用例：${r.lastTest || "（没有任何用例报出结果）"}`);
}

const hung = results.filter((r) => r.hung);
const failed = results.filter((r) => !r.hung && r.code !== 0);
const slow = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 8);
const lines = [];
lines.push(`## 用例文件：共 ${results.length}，通过 ${results.length - hung.length - failed.length}，失败 ${failed.length}，挂起 ${hung.length}（每个文件时限 ${FILE_TIMEOUT_MS / 60_000} 分钟，单个用例时限 ${TEST_TIMEOUT_MS / 1000} 秒；${process.platform}）`);
if (hung.length) {
  lines.push("", "### 挂起（到时限仍未结束，已终止）");
  for (const r of hung) {
    lines.push(`- \`${r.file}\`：最后一个有结果的用例 ${r.lastTest || "（没有）"}——挂住的是它之后的那一个；若全部用例都已报出结果，则是用例结束后进程没退出（句柄、定时器或子进程没收）`);
    lines.push("", "```", ...r.tail.slice(-12), "```");
  }
}
if (failed.length) {
  lines.push("", "### 失败");
  for (const r of failed) lines.push(`- \`${r.file}\`（退出码 ${r.code}，${r.seconds} 秒）`);
}
lines.push("", "### 最慢的文件", ...slow.map((r) => `- ${r.seconds} 秒 \`${r.file}\`${r.hung ? "（挂起）" : ""}`));
const summary = lines.join("\n");
console.log("\n" + summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  } catch {}
}
process.exit(hung.length || failed.length ? 1 : 0);
