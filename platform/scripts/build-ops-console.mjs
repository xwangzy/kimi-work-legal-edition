#!/usr/bin/env node
/**
 * 运营控制台打包（第 44 批）：把 apps/ops-console 的页面、ES 模块、样式与 packages/design-tokens 的 tokens.css 拼成
 * apps/ops-console/dist/（部署只拷这个目录，另由运维放 config.json）。无打包器：原样拷贝，再核对一遍——
 *   - index.html 引用的本地文件都在；每个模块的相对 import 都能解析到 dist 里的文件；
 *   - 没有外部地址（http/https 的 src、href、import、@import）；
 *   - tokens.css 与桌面端同一份（逐字节）。
 *
 *   node scripts/build-ops-console.mjs [--out <目录>]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const SRC = join(root, "apps/ops-console");
export const TOKENS = join(root, "packages/design-tokens/src/tokens.css");
const PAGE_FILES = ["index.html", "console.css", "config.example.json"];

/** 源目录里要发布的模块：顶层 *.js + pages/*.js（不含 dist/ 与测试） */
export function sourceModules() {
  const top = readdirSync(SRC).filter((f) => f.endsWith(".js"));
  const pages = existsSync(join(SRC, "pages")) ? readdirSync(join(SRC, "pages")).filter((f) => f.endsWith(".js")).map((f) => `pages/${f}`) : [];
  return [...top, ...pages].sort();
}

const IMPORT_RE = /\b(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g;

/** 核对 dist：返回问题列表（空 = 通过） */
export function verifyDist(out) {
  const problems = [];
  const files = new Set(walk(out).map((f) => relative(out, f).split(sep).join("/")));
  const html = readFileSync(join(out, "index.html"), "utf8");
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const ref = m[1];
    if (ref.startsWith("data:")) continue;
    if (/^[a-z]+:|^\/\//i.test(ref)) problems.push(`index.html 引用外部地址 ${ref}`);
    else if (!files.has(ref)) problems.push(`index.html 引用的 ${ref} 不在 dist`);
  }
  for (const f of files) {
    if (!f.endsWith(".js")) continue;
    const text = readFileSync(join(out, f), "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        problems.push(`${f} 引入非相对模块 ${spec}`);
        continue;
      }
      const target = relative(out, resolve(dirname(join(out, f)), spec)).split(sep).join("/");
      if (!files.has(target)) problems.push(`${f} 引入的 ${spec} 不在 dist`);
    }
  }
  for (const f of files) if (f.endsWith(".css") && /@import|url\(\s*["']?(https?:)?\/\//i.test(readFileSync(join(out, f), "utf8"))) problems.push(`${f} 引用外部样式或资源`);
  if (!readFileSync(join(out, "tokens.css")).equals(readFileSync(TOKENS))) problems.push("dist/tokens.css 与 packages/design-tokens 不一致");
  return problems;
}

function walk(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** 打包到 out（缺省 apps/ops-console/dist）；返回 [{path, bytes, sha256}] */
export function buildOpsConsole(out = join(SRC, "dist")) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "pages"), { recursive: true });
  const list = [...PAGE_FILES, ...sourceModules()];
  for (const f of list) copyFileSync(join(SRC, f), join(out, f));
  copyFileSync(TOKENS, join(out, "tokens.css"));
  const problems = verifyDist(out);
  if (problems.length) throw new Error(`运营控制台打包核对失败：\n  ${problems.join("\n  ")}`);
  return [...list, "tokens.css"].sort().map((f) => {
    const b = readFileSync(join(out, f));
    return { path: f, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex").slice(0, 16) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--out");
  const out = i > 0 ? resolve(process.argv[i + 1]) : join(SRC, "dist");
  try {
    const files = buildOpsConsole(out);
    console.log(`运营控制台已打包：${out}`);
    for (const f of files) console.log(`  ${f.path.padEnd(22)} ${String(f.bytes).padStart(7)} B  ${f.sha256}`);
    console.log("部署：把整个目录拷到 Web 服务器，另放 config.json（见 config.example.json）。");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
