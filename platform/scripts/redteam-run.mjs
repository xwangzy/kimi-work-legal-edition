#!/usr/bin/env node
/**
 * P12 注入红队用例运行（v9 阶段 7；第 04 篇 §11 P12、第 06 篇 §2 T08）。
 *
 *   node scripts/redteam-run.mjs                      # 冒烟用例（content/redteam/cases/smoke/）
 *   node scripts/redteam-run.mjs <用例目录>            # 独立红队的用例
 *   node scripts/redteam-run.mjs <用例目录> --only <编号,编号> --report <报告目录>
 *
 * 报告（JSON + Markdown：环境、版本、样本来源、分母、观察时间与失败复现）缺省写到 platform/.redteam-reports/<时间>/。
 * 运行器只在本机回环与临时目录内工作（云端 v0 为测试进程内的模拟），不访问外部主机。
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let cases = null;
let only = null;
let report = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--only") only = args[++i] ?? null;
  else if (args[i] === "--report") report = args[++i] ?? null;
  else cases = args[i];
}
const reportDir = report ? resolve(report) : join(root, ".redteam-reports", new Date().toISOString().replace(/[:.]/g, "-"));
const env = {
  ...process.env,
  KWL_REDTEAM_REPORT: reportDir,
  ...(cases ? { KWL_REDTEAM_CASES: resolve(cases) } : {}),
  ...(only ? { KWL_REDTEAM_ONLY: only } : {}),
};
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", join(root, "packages", "kernel", "test", "p12-redteam.test.ts")], { cwd: root, env, stdio: "inherit" });
console.log(`\n报告：${join(reportDir, "p12-report.md")}`);
process.exit(r.status ?? 1);
