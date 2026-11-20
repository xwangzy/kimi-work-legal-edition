#!/usr/bin/env node
/**
 * CI 判定安装后冒烟结果（.github/workflows/desktop-ci.yml 的 Windows 与 macOS 两个 job 共用）：
 *
 *   node scripts/ci/check-smoke.mjs <smoke.json>
 *
 * 通过条件：ok === true，且 checks.children 的四项（gate 出站闸门、kap Agent 宿主、w W 执行域、parse 隔离解析进程）全部为 "ok"。
 * 第 52 批起冒烟逐个真拉起随包子进程（偏离 D-215：安装包里 fork 被拒、子进程全部拉不起来，旧冒烟只看闸门对象存在而照样通过）；
 * 没有 checks.children 的结果（旧版本安装包）一律判失败。结果文件只含结果码，打印出来不泄露路径或内容。
 */
import { readFileSync } from "node:fs";

const CHILDREN = ["gate", "kap", "w", "parse"];
const file = process.argv[2];
if (!file) {
  console.error("用法：node scripts/ci/check-smoke.mjs <smoke.json>");
  process.exit(2);
}
let res;
try {
  res = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
} catch (e) {
  console.error(`读不了冒烟结果 ${file}：${e.message}`);
  process.exit(1);
}
const children = res?.checks?.children ?? null;
console.log(`冒烟：ok=${res?.ok} error=${res?.error ?? "-"} packaged=${res?.packaged} version=${res?.version}`);
console.log(`随包子进程：${CHILDREN.map((k) => `${k}=${children?.[k] ?? "缺失"}`).join(" ")}`);
const problems = [];
if (res?.ok !== true) problems.push(`冒烟未通过（error=${res?.error ?? "无"}）`);
if (!children) problems.push("结果里没有 checks.children（安装包不含随包子进程自检）");
else for (const k of CHILDREN) if (children[k] !== "ok") problems.push(`子进程 ${k} 未通过：${children[k] ?? "缺失"}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log("✓ 冒烟通过，四个随包子进程都在安装包里真拉起来了");
