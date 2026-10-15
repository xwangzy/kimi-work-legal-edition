/**
 * 源码静态扫描的公共部分（日志面、落盘面门禁共用；出网面扫描 outbound-surface.test.ts 自带同一实现）。
 * 只读源码，不执行。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * 去掉注释（尊重字符串与模板字面量，避免字符串里的 "/*" 吞掉代码）。
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (q !== "`" && src[i] === "\n") break;
        out += src[i];
        i++;
      }
      if (i < src.length) out += src[i];
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 从 `open` 处（指向左括号）取出括号平衡的参数文本（尊重字符串）；取不到返回 null。
 * @param {string} text
 * @param {number} open
 * @returns {string | null}
 */
export function balancedArgs(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name) && !name.includes(".bundle.")) out.push(p);
  }
}

/**
 * 律师电脑上各进程的生产源码：packages/*\/src、apps/*\/src、apps/desktop/electron（不含构建产物 *.bundle.*）。
 * @param {{ outOfScope?: string[] }} [o]
 * @returns {{ rel: string; raw: string; text: string }[]}
 */
export function productionSources(o = {}) {
  const files = [];
  for (const top of ["packages", "apps"]) {
    for (const name of readdirSync(join(PLATFORM_ROOT, top))) {
      const src = join(PLATFORM_ROOT, top, name, "src");
      try {
        if (statSync(src).isDirectory()) walk(src, files);
      } catch {
        // 没有 src 目录
      }
    }
  }
  const electron = join(PLATFORM_ROOT, "apps/desktop/electron");
  for (const name of readdirSync(electron)) if (/\.(cjs|mjs|js)$/.test(name) && !name.includes(".bundle.")) files.push(join(electron, name));
  const skip = o.outOfScope ?? [];
  return files
    .map((f) => relative(PLATFORM_ROOT, f).replaceAll("\\", "/"))
    .filter((rel) => !skip.some((d) => rel.startsWith(d)))
    .sort()
    .map((rel) => {
      const raw = readFileSync(join(PLATFORM_ROOT, rel), "utf8");
      return { rel, raw, text: stripComments(raw) };
    });
}

/** 能写盘（新建、写入、改名、复制、链接、截断）的 fs 接口。 */
export const FS_WRITE_APIS = Object.freeze([
  "writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream",
  "rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync",
  "link", "linkSync", "symlink", "symlinkSync", "truncate", "truncateSync",
  "open", "openSync", "mkdtemp", "mkdtempSync", "write", "writeSync", "writev", "writevSync",
]);

/**
 * 找出源码里经 node:fs / node:fs/promises 调用的写盘接口（具名导入、命名空间导入、require 绑定与解构、require(...).x 直接调用）。
 * 只看与 fs 模块绑定的名字，不把同名的变量或方法（如子进程变量 cp、编解码器的 open）算进来。
 * @param {string} text 已去注释的源码
 * @returns {string[]} 排序去重的接口名
 */
export function fsWriteCalls(text) {
  // Electron 的 original-fs 与 node:fs 同一套接口（复核 S5A-07）
  const MOD = `["'](?:(?:node:)?fs(?:\\/promises)?|original-fs)["']`;
  const found = new Set();
  const apis = new Set(FS_WRITE_APIS);
  const nsNames = new Set();
  const direct = new Map(); // 本地名 → 接口名
  const addSpecs = (specs) => {
    for (const part of specs.split(",")) {
      const m = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*)|\s*:\s*([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (m && apis.has(m[1])) direct.set(m[3] ?? m[2] ?? m[1], m[1]);
      if (m && m[1] === "promises") nsNames.add(m[3] ?? m[2] ?? m[1]);
    }
  };
  for (const m of text.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${MOD}`, "g"))) addSpecs(m[1]);
  for (const m of text.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+)?([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{([^}]*)\\})?\\s*from\\s*${MOD}`, "g"))) {
    nsNames.add(m[1]);
    if (m[2]) addSpecs(m[2]);
  }
  for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*${MOD}\\s*\\)(?:\\.promises)?`, "g"))) nsNames.add(m[1]);
  for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*${MOD}\\s*\\)(?:\\.promises)?`, "g"))) addSpecs(m[1]);
  /** open/openSync 以只读方式打开（"r" 或只有 O_RDONLY 等只读标志）不算写盘。 */
  const consider = (api, parenIdx) => {
    if (!apis.has(api)) return;
    if (api === "open" || api === "openSync") {
      const args = balancedArgs(text, parenIdx) ?? "";
      const flags = args.split(",").slice(1).join(",");
      const readOnly = /^\s*["']r["']\s*(?:,|$)/.test(flags) || (/O_RDONLY/.test(flags) && !/O_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)|["'][wa]/.test(flags));
      if (readOnly) return;
    }
    found.add(api);
  };
  for (const m of text.matchAll(new RegExp(`require\\(\\s*${MOD}\\s*\\)(?:\\.promises)?\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g"))) consider(m[1], m.index + m[0].length - 1);
  for (const ns of nsNames) {
    for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${ns.replace(/\$/g, "\\$")}\\s*(?:\\.\\s*promises\\s*)?\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g"))) consider(m[1], m.index + m[0].length - 1);
  }
  for (const [local, api] of direct) {
    for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${local.replace(/\$/g, "\\$")}\\s*\\(`, "g"))) consider(api, m.index + m[0].length - 1);
  }
  return [...found].sort();
}
