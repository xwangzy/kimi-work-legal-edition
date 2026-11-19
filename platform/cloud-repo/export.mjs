#!/usr/bin/env node
/**
 * 导出独立云端仓库 kimi-work-legal-cloud（第 46 批，D-196）。
 *
 *   node cloud-repo/export.mjs --out <目标仓库目录> [--commit] [--check]
 *
 * - 按 cloud-repo/manifest.json 的 include / exclude 拷贝源码（不拷 node_modules、dist、config.json），再把 cloud-repo/template/ 原样覆盖到仓库根；
 * - 写 SOURCE.json：monorepo 源提交、工作区是否有未提交改动、每个导出文件的 sha256（云端仓库 CI 用它确认没有人在导出物上直接改共享契约包）；
 * - 校验：导出的 .ts/.mjs/.js 不得 import 清单之外的工作区包（forbidden_imports）或用相对路径跳出导出范围；违者列出并以非零退出；
 * - 目标目录里清单之外的旧文件会被删除（保留 .git、node_modules、package-lock.json）；
 * - --commit：在目标仓库里 git add -A && git commit（目标是独立仓库，有自己的暂存区）；--check：只比对不写，有差异即非零退出。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const platform = resolve(here, "..");
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? null : (args[i + 1] ?? "");
};
const outArg = flag("out");
if (!outArg) {
  console.error("用法：node cloud-repo/export.mjs --out <目标仓库目录> [--commit] [--check]");
  process.exit(2);
}
const out = resolve(outArg);
const check = args.includes("--check");
const commit = args.includes("--commit");

const posix = (p) => p.split(sep).join("/");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".data", "coverage", "out"]);
const excluded = (rel) => manifest.exclude.some((x) => rel === x || rel.startsWith(`${x}/`));

/** 列出 platform 下某个 include 项的全部文件（相对 platform）。 */
function walk(rel) {
  const abs = join(platform, rel);
  if (!existsSync(abs)) throw new Error(`清单里的 ${rel} 不存在`);
  const st = statSync(abs);
  if (st.isFile()) return excluded(rel) ? [] : [rel];
  const outFiles = [];
  for (const name of readdirSync(abs).sort()) {
    if (SKIP_DIRS.has(name) || name === ".DS_Store") continue;
    const r = posix(join(rel, name));
    if (excluded(r)) continue;
    const s = statSync(join(platform, r));
    if (s.isDirectory()) outFiles.push(...walk(r));
    else outFiles.push(r);
  }
  return outFiles;
}

function templateFiles(dir = join(here, "template"), base = "") {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === ".DS_Store") continue;
    const abs = join(dir, name);
    const r = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) files.push(...templateFiles(abs, r));
    else files.push(r);
  }
  return files;
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// ─── 1. 收集文件 ───
const srcFiles = manifest.include.flatMap(walk);
const tplFiles = templateFiles();
/** 目标相对路径 → 内容 */
const plan = new Map();
for (const f of srcFiles) plan.set(f, readFileSync(join(platform, f)));
for (const f of tplFiles) plan.set(f, readFileSync(join(here, "template", f)));

// ─── 2. 校验引用 ───
const problems = [];
const exportedDirs = new Set([...plan.keys()].map((f) => posix(dirname(f))));
const IMPORT_RE = /(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
for (const [f, buf] of plan) {
  if (!/\.(m?js|ts|cjs)$/.test(f)) continue;
  const text = buf.toString("utf8");
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    if (manifest.forbidden_imports.some((p) => spec === p || spec.startsWith(`${p}/`))) problems.push(`${f}: 引用了客户端包 ${spec}`);
    if (spec.startsWith(".")) {
      const target = posix(join(dirname(f), spec));
      if (target.startsWith("..")) problems.push(`${f}: 相对路径跳出仓库 ${spec}`);
      else if (!plan.has(target) && !exportedDirs.has(target) && !/\.(json)$/.test(target)) problems.push(`${f}: 引用了未导出的文件 ${spec}`);
    }
  }
  // 按 join(root, "<路径>") 动态拼的引用（cloud-serve 等）
  for (const m of text.matchAll(/join\(\s*root\s*,\s*["']([^"']+)["']/g)) {
    const target = m[1];
    // 构建产物（…/dist）在运行时生成，只要它的上级目录在导出范围内即可
    if (/\/dist(\/|$)/.test(target) && [...plan.keys()].some((k) => k.startsWith(`${target.split("/dist")[0]}/`))) continue;
    if (/^(packages|services|apps|scripts)\//.test(target) && ![...plan.keys()].some((k) => k === target || k.startsWith(`${target.replace(/\/$/, "")}/`))) problems.push(`${f}: 运行时路径 ${target} 不在导出范围`);
  }
}
if (problems.length) {
  console.error(`导出校验失败（${problems.length} 处）：\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

// ─── 3. SOURCE.json ───
const git = (...a) => execFileSync("git", ["-C", platform, ...a], { encoding: "utf8" }).trim();
let source = { commit: null, dirty: null };
try {
  source = { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", ...manifest.include, "cloud-repo").length > 0 };
} catch {
  // 不在 git 里：照样导出
}
const files = Object.fromEntries([...plan].filter(([f]) => f !== "SOURCE.json").sort(([a], [b]) => a.localeCompare(b)).map(([f, b]) => [f, sha(b)]));
const sourceDoc = { format: "kwl-cloud-source/1", repo: manifest.repo, api: manifest.api, monorepo: { path: "platform/", ...source }, shared_contract_packages: manifest.shared_contract_packages.packages, files };
// 生成时刻不进 SOURCE.json：同一源提交导出两次逐字节一致（--check 才有意义）
plan.set("SOURCE.json", Buffer.from(`${JSON.stringify(sourceDoc, null, 2)}\n`));

// ─── 4. 写出 / 比对 ───
const KEEP_TOP = new Set([".git", "node_modules", "package-lock.json"]);
function existing(dir = out, base = "") {
  if (!existsSync(dir)) return [];
  const files2 = [];
  for (const name of readdirSync(dir)) {
    if (!base && KEEP_TOP.has(name)) continue;
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const r = base ? `${base}/${name}` : name;
    if (r === "apps/console/dist" || r === "apps/console/config.json") continue;
    if (statSync(abs).isDirectory()) files2.push(...existing(abs, r));
    else files2.push(r);
  }
  return files2;
}
const stale = existing().filter((f) => !plan.has(f));
const changed = [...plan].filter(([f, b]) => !existsSync(join(out, f)) || !readFileSync(join(out, f)).equals(b)).map(([f]) => f);
if (check) {
  if (stale.length || changed.length) {
    console.error(`云端仓库与 monorepo 不一致：新增或改动 ${changed.length} 个，多出 ${stale.length} 个\n  ${[...changed.map((f) => `~ ${f}`), ...stale.map((f) => `- ${f}`)].slice(0, 40).join("\n  ")}`);
    process.exit(1);
  }
  console.log(`一致：${plan.size} 个文件`);
  process.exit(0);
}
mkdirSync(out, { recursive: true });
for (const f of stale) rmSync(join(out, f));
for (const f of changed) {
  mkdirSync(dirname(join(out, f)), { recursive: true });
  writeFileSync(join(out, f), plan.get(f));
}
// 删空目录
function pruneEmpty(dir) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      pruneEmpty(abs);
      if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true });
    }
  }
}
pruneEmpty(out);
console.log(`已导出到 ${out}：${plan.size} 个文件（改动 ${changed.length}、删除 ${stale.length}）；源提交 ${source.commit ?? "（非 git）"}${source.dirty ? "（含未提交改动）" : ""}`);

if (commit) {
  const g = (...a) => execFileSync("git", ["-C", out, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!existsSync(join(out, ".git"))) g("init", "-b", "main");
  g("add", "-A");
  if (g("status", "--porcelain").length === 0) console.log("目标仓库没有变化，不提交");
  else {
    g("commit", "-q", "-m", `sync: 自 monorepo ${source.commit ? source.commit.slice(0, 12) : "工作区"}${source.dirty ? "（含未提交改动）" : ""} 导出（${manifest.api}）`);
    console.log(`已在目标仓库提交：${g("rev-parse", "--short", "HEAD")}`);
  }
}
