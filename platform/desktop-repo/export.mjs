#!/usr/bin/env node
/**
 * 导出独立桌面客户端仓库 kimi-work-legal-desktop（Windows EXE / macOS DMG；偏离 D-214）。
 *
 *   node desktop-repo/export.mjs --out <目标仓库目录> [--lock] [--commit] [--check]
 *
 * - 文件来源：清单 include 范围内 git 跟踪的文件 + 未被忽略的新文件（`git ls-files -co --exclude-standard`），
 *   所以构建产物（dist、runtime、kernel.bundle.cjs、lawdb 构建物）、node_modules、开发桥令牌、release.json / trial.json 一律不出；
 *   再把 desktop-repo/template/ 原样覆盖到仓库根；
 * - 引用闭包校验：导出的 .ts/.tsx/.mjs/.cjs/.js 引用的工作区包（@zr-legal/*）与相对路径都必须在导出范围内。
 *   非用例文件违例 → 列出并非零退出；用例文件（路径含 /test/）违例（多为要起本机云端栈的联调用例）→ 不导出、记入
 *   SOURCE.json 的 monorepo_only_tests（这些用例继续在 monorepo 跑，见 CONTRACT.md）；按不动点迭代（助手被剔除，引用它的用例也剔除）；
 * - SOURCE.json：monorepo 源提交、是否有未提交改动、每个文件的 sha256、共享契约包清单；同一源提交导出两次逐字节一致；
 * - 目标目录里多出的旧文件会删除（保留 .git、node_modules、package-lock.json）；--lock 按本仓库工作区重写锁文件（从 monorepo 锁文件裁剪）；
 *   --commit 在目标仓库提交；--check 只比对。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
  console.error("用法：node desktop-repo/export.mjs --out <目标仓库目录> [--commit] [--check]");
  process.exit(2);
}
const out = resolve(outArg);
if (args.includes("--commit") && !existsSync(join(out, ".git"))) {
  mkdirSync(out, { recursive: true });
  execFileSync("git", ["-C", out, "init", "-q", "-b", "main"]);
}
const check = args.includes("--check");
const commit = args.includes("--commit");
const posix = (p) => p.split(sep).join("/");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const git = (...a) => execFileSync("git", ["-C", platform, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

// ─── 1. 收集文件 ───
const excluded = (rel) => manifest.exclude.some((x) => rel === x || rel.startsWith(`${x}/`));
const listed = git("ls-files", "-co", "--exclude-standard", "-z", "--", ...manifest.include.filter((p) => !(manifest.optional ?? []).includes(p) || existsSync(join(platform, p))))
  .split("\0")
  .filter(Boolean)
  .map(posix)
  .filter((f) => !excluded(f) && existsSync(join(platform, f)) && !f.endsWith(".DS_Store"));
for (const inc of manifest.include) {
  if ((manifest.optional ?? []).includes(inc)) continue;
  if (!listed.some((f) => f === inc || f.startsWith(`${inc}/`))) {
    console.error(`清单里的 ${inc} 没有任何受 git 管理的文件`);
    process.exit(1);
  }
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
/** 目标相对路径 → 内容 */
const plan = new Map();
for (const f of listed) plan.set(f, readFileSync(join(platform, f)));
// 模板里的文件名 _gitignore → .gitignore（npm 发布与部分工具会吞掉模板目录里的点文件）
for (const f of templateFiles()) plan.set(f.replace(/(^|\/)_gitignore$/, "$1.gitignore"), readFileSync(join(here, "template", f)));

// ─── 2. 引用闭包 ───
/** 工作区包名 → 目录（在 monorepo 全部 package.json 里找） */
const pkgDir = new Map();
for (const group of ["packages", "apps", "services"]) {
  for (const name of readdirSync(join(platform, group))) {
    const pj = join(platform, group, name, "package.json");
    if (existsSync(pj)) pkgDir.set(JSON.parse(readFileSync(pj, "utf8")).name, `${group}/${name}`);
  }
}
const IMPORT_RE = /(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;
const CODE_RE = /\.(m?[jt]sx?|cjs|mts)$/;
const isTest = (f) => /(^|\/)test\//.test(f);
const isVendor = (f) => (manifest.vendor_bundles ?? []).some((v) => f.startsWith(v));
const exportedDir = (dirs, d) => dirs.has(d);
function violations(f, files) {
  const text = files.get(f).toString("utf8");
  const dirs = new Set([...files.keys()].map((k) => posix(dirname(k))));
  const bad = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!spec) continue;
    if (manifest.forbidden_imports.some((p) => spec === p || spec.startsWith(`${p}/`))) {
      bad.push(`引用了云端包 ${spec}`);
      continue;
    }
    const ws = /^(@zr-legal\/[a-z0-9-]+)(\/.*)?$/.exec(spec);
    if (ws) {
      const d = pkgDir.get(ws[1]);
      if (!d) bad.push(`引用了不存在的工作区包 ${spec}`);
      else if (!files.has(`${d}/package.json`)) bad.push(`引用了未导出的工作区包 ${spec}`);
      continue;
    }
    if (spec.startsWith(".")) {
      const target = posix(join(dirname(f), spec));
      if (target.startsWith("..")) bad.push(`相对路径跳出仓库 ${spec}`);
      else if (!files.has(target) && !exportedDir(dirs, target) && !files.has(`${target}.ts`) && !files.has(`${target}/index.ts`)) {
        // 构建产物（…bundle、dist）运行时生成：上级目录在导出范围内即可
        if (/(bundle|\/dist\/|\.generated\.)/.test(target) && exportedDir(dirs, posix(dirname(target)))) continue;
        bad.push(`引用了未导出的文件 ${spec}`);
      }
    }
  }
  // 脚本里按 join(root, "<路径>") 动态拼的引用
  for (const m of text.matchAll(/join\(\s*root\s*,\s*["']((?:packages|services|apps|scripts|content)\/[^"']+)["']/g)) {
    const target = m[1].replace(/\/$/, "");
    if (files.has(target) || [...files.keys()].some((k) => k.startsWith(`${target}/`))) continue;
    // 构建或下载生成、不入库的目录（构建产物、随包运行时、OCR 模型、开发内容密钥）
    if (/(\/dist|\/runtime|\.stage|\/release|bundle|\/lawdb$|\/skills$|\/tool-manifest$|\/migrations$|(^|\/)keys(\/|$)|ocr-models)/.test(target)) continue;
    bad.push(`运行时路径 ${target} 不在导出范围`);
  }
  return bad;
}
const dropped = new Map();
for (const [f, why] of Object.entries(manifest.monorepo_only_explicit ?? {})) {
  if (f.startsWith("$") || !plan.has(f)) continue;
  dropped.set(f, `跨两端核对：${why}`);
  plan.delete(f);
}
for (;;) {
  let changed = false;
  for (const f of [...plan.keys()]) {
    if (!CODE_RE.test(f) || f.startsWith("template/")) continue;
    if (!isTest(f)) continue;
    const bad = violations(f, plan);
    if (bad.length) {
      dropped.set(f, bad[0]);
      plan.delete(f);
      changed = true;
    }
  }
  if (!changed) break;
}
const problems = [];
for (const f of plan.keys()) {
  if (!CODE_RE.test(f) || isTest(f) || isVendor(f)) continue;
  for (const b of violations(f, plan)) problems.push(`${f}: ${b}`);
}
if (problems.length) {
  console.error(`导出校验失败（${problems.length} 处）：\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

// ─── 3. SOURCE.json ───
let source = { commit: null, dirty: null };
try {
  source = { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", ...manifest.include.filter((p) => existsSync(join(platform, p))), "desktop-repo").length > 0 };
} catch {
  // 不在 git 里：照样导出
}
const files = Object.fromEntries([...plan].sort(([a], [b]) => a.localeCompare(b)).map(([f, b]) => [f, sha(b)]));
const sourceDoc = {
  format: "kwl-desktop-source/1",
  repo: manifest.repo,
  api: manifest.api,
  monorepo: { path: "platform/", ...source },
  shared_contract_packages: manifest.shared_contract_packages.packages,
  monorepo_only_tests: Object.fromEntries([...dropped].sort(([a], [b]) => a.localeCompare(b))),
  files,
};
plan.set("SOURCE.json", Buffer.from(`${JSON.stringify(sourceDoc, null, 2)}\n`));

// ─── 4. 写出 / 比对 ───
const KEEP_TOP = new Set([".git", "node_modules", "package-lock.json"]);
const SKIP = new Set(["node_modules", ".git", ".cache", "dist", "runtime", ".stage", "release"]);
function existing(dir = out, base = "") {
  if (!existsSync(dir)) return [];
  const list = [];
  for (const name of readdirSync(dir)) {
    if (!base && KEEP_TOP.has(name)) continue;
    if (SKIP.has(name)) continue;
    const abs = join(dir, name);
    const r = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) list.push(...existing(abs, r));
    else list.push(r);
  }
  return list;
}
// 目标仓库里构建产生的文件（被目标 .gitignore 忽略）不算“多出”
let ignoredInTarget = new Set();
if (existsSync(join(out, ".git"))) {
  try {
    ignoredInTarget = new Set(execFileSync("git", ["-C", out, "ls-files", "-oi", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean));
  } catch {
    // 目标不是 git 仓库
  }
}
// 目标不是 git 仓库时分不清“构建产物”与“多余旧文件”：只覆盖、不删（否则会删掉 pretest 生成的法规库、密钥与夹具）
const targetIsRepo = existsSync(join(out, ".git"));
const stale = targetIsRepo ? existing().filter((f) => !plan.has(f) && !ignoredInTarget.has(f)) : [];
if (!targetIsRepo && existsSync(out) && !check) console.warn("目标目录不是 git 仓库：多出的文件不删除（--commit 会先 git init）");
const changed = [...plan].filter(([f, b]) => !existsSync(join(out, f)) || !readFileSync(join(out, f)).equals(b)).map(([f]) => f);
if (check) {
  if (stale.length || changed.length) {
    console.error(`桌面仓库与 monorepo 不一致：新增或改动 ${changed.length} 个，多出 ${stale.length} 个\n  ${[...changed.map((f) => `~ ${f}`), ...stale.map((f) => `- ${f}`)].slice(0, 40).join("\n  ")}`);
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
console.log(`已导出到 ${out}：${plan.size} 个文件（改动 ${changed.length}、删除 ${stale.length}；留在 monorepo 的联调用例 ${dropped.size} 个）；源提交 ${source.commit ?? "（非 git）"}${source.dirty ? "（含未提交改动）" : ""}`);

// 独立锁文件（--lock）：从 monorepo 的锁文件出发，按本仓库的工作区裁剪（不联网解析新版本；云端包的条目随之去掉）
if (args.includes("--lock")) {
  writeFileSync(join(out, "package-lock.json"), readFileSync(join(platform, "package-lock.json")));
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--package-lock-only", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], { cwd: out, stdio: "inherit", shell: process.platform === "win32" });
  console.log("已按本仓库工作区重写 package-lock.json");
}

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
