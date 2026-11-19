#!/usr/bin/env node
/**
 * 统一云端控制台打包（第 44 批起；第 46 批加 --control-plane）：把 apps/console 的页面、ES 模块、样式与
 * packages/design-tokens 的 tokens.css 拼成 apps/console/dist/（部署只拷这个目录，另由运维放 config.json）。无打包器：原样拷贝，再核对一遍——
 *   - index.html 引用的本地文件都在；每个模块的相对 import 都能解析到 dist 里的文件；
 *   - 没有外部地址（http/https 的 src、href、import、@import）；
 *   - tokens.css 与桌面端同一份（逐字节）；
 *   - config.example.json 不进 dist（部署只放真的 config.json）；
 *   - 页内兜底 CSP 的 connect-src：给了 --control-plane 就收紧为 'self' + 该来源（审计 cloud §9-11）；不给保持 'self' https: 并提示。
 *
 *   node scripts/build-console.mjs [--out <目录>] [--control-plane https://cp.example.com]
 *   （--control-plane 只收 https 来源；回环地址 127.0.0.1 / localhost / [::1] 也收 http，供本机栈用）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const SRC = join(root, "apps/console");
export const TOKENS = join(root, "packages/design-tokens/src/tokens.css");
const PAGE_FILES = ["index.html", "console.css"];
export const DEFAULT_CONNECT = "'self' https:";

/** 源目录里要发布的模块：顶层 *.js + pages/*.js（不含 dist/ 与测试） */
export function sourceModules() {
  const top = readdirSync(SRC).filter((f) => f.endsWith(".js"));
  const pages = existsSync(join(SRC, "pages")) ? readdirSync(join(SRC, "pages")).filter((f) => f.endsWith(".js")).map((f) => `pages/${f}`) : [];
  return [...top, ...pages].sort();
}

/** 控制面来源 → connect-src 片段（不合法即抛错） */
export function connectSrcFor(origin) {
  if (!origin) return DEFAULT_CONNECT;
  let u;
  try {
    u = new URL(origin);
  } catch {
    throw new Error(`--control-plane 不是合法地址：${origin}`);
  }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (loop && u.protocol === "http:"))) throw new Error("--control-plane 必须是 https 来源（回环地址可用 http）");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) throw new Error("--control-plane 只写来源（不带路径、查询串与口令）");
  return `'self' ${u.origin}`;
}
/** 把 index.html 里 CSP 的 connect-src 换成给定值 */
export function withConnectSrc(html, connect) {
  const re = /(<meta http-equiv="Content-Security-Policy" content="[^"]*?connect-src )([^;"]*)(;)/;
  if (!re.test(html)) throw new Error("index.html 里找不到 CSP 的 connect-src");
  return html.replace(re, (_, a, _b, c) => `${a}${connect}${c}`);
}
export const cspOf = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? null;

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
  for (const f of files) if (/^config(\.example)?\.json$/.test(f)) problems.push(`dist 里不应有 ${f}（config.json 由运维部署时放）`);
  const csp = cspOf(html);
  if (!csp) problems.push("index.html 缺页内 CSP");
  else {
    for (const need of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) if (!csp.includes(need)) problems.push(`CSP 缺 ${need}`);
    if (/unsafe-inline|unsafe-eval|\*/.test(csp)) problems.push("CSP 不得含 unsafe-inline / unsafe-eval / 通配");
  }
  return problems;
}

function walk(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * 打包到 out（缺省 apps/console/dist）；返回 [{path, bytes, sha256}]
 * @param {string} [out]
 * @param {{controlPlane?: string}} [o]
 */
export function buildConsole(out = join(SRC, "dist"), o = {}) {
  const connect = connectSrcFor(o.controlPlane);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "pages"), { recursive: true });
  const list = [...PAGE_FILES, ...sourceModules()];
  for (const f of list) copyFileSync(join(SRC, f), join(out, f));
  writeFileSync(join(out, "index.html"), withConnectSrc(readFileSync(join(SRC, "index.html"), "utf8"), connect));
  copyFileSync(TOKENS, join(out, "tokens.css"));
  const problems = verifyDist(out);
  if (problems.length) throw new Error(`控制台打包核对失败：\n  ${problems.join("\n  ")}`);
  const files = [...list, "tokens.css"].sort().map((f) => {
    const b = readFileSync(join(out, f));
    return { path: f, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex").slice(0, 16) };
  });
  Object.defineProperty(files, "connectSrc", { value: connect });
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const out = arg("--out") ? resolve(arg("--out")) : join(SRC, "dist");
  try {
    const files = buildConsole(out, { controlPlane: arg("--control-plane") });
    console.log(`统一云端控制台已打包：${out}`);
    for (const f of files) console.log(`  ${f.path.padEnd(24)} ${String(f.bytes).padStart(7)} B  ${f.sha256}`);
    console.log(`页内 CSP connect-src：${files.connectSrc}`);
    if (files.connectSrc === DEFAULT_CONNECT) console.log("提示：没有给 --control-plane，页内 CSP 允许连任意 https 来源。正式部署请用 --control-plane https://<控制面来源> 重新打包，或由 Web 服务器下发只含控制面来源的 CSP 头。");
    console.log("部署：把整个目录拷到 Web 服务器，另放 config.json（字段见 apps/console/config.example.json：control_plane_base、deployment、label）。");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
