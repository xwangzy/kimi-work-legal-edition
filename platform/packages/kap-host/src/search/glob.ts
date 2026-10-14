/**
 * gitignore 风格的 glob（宿主内检索：`--glob` 覆盖规则、`.ignore` / `.rgignore` / `.gitignore` 规则、文件类型）。
 *
 * 行为对齐 ripgrep 15 所用 ignore/globset 的 gitignore 语义（审计 S3 第 2 步：原生 rg 读不了密文，Grep/Glob 改为宿主内检索）：
 * - `#` 注释、`\#` `\!` 转义、行尾空白去除（`\ ` 保留）；`!` 取反；开头 `/` 或中间有 `/` 即锚定到规则所在目录；
 *   末尾 `/` 只匹配目录；没有 `/` 的规则前加 `**​/`（任意深度）；末尾 `/**` 改为 `/**​/*`；
 * - `*` 不跨 `/`；`?` 单个非 `/` 字符；`**` 跨目录；`[...]`（`[!...]` / `[^...]` 取反）；`{a,b}` 多选；`\x` 转义；
 * - 同一组规则里**最后一条**命中的规则决定结果（忽略 / 白名单）。
 * 匹配引擎：通配不超过两处且没有 `{a,b}` 的规则用 JS 正则（快）；更复杂的用 re2js（线性时间）——规则来自工作区里的忽略文件与
 * 模型给出的 `--glob`，多个 `**` 或 `*` 在回溯式正则里是指数/高次多项式（实测 12 个 `**​/` 单条路径 1.4 秒），会卡住宿主进程。
 */
import { RE2JS } from "re2js";

/** 编译后的 glob（JS 正则与 re2js 的共同形状）。 */
export interface GlobTester {
  test(s: string): boolean;
}

/** 单个忽略文件最多采用的规则数（超出部分忽略：防止病态文件把遍历拖成“规则数 × 路径数”的平方级）。 */
export const MAX_RULES_PER_FILE = 10_000;

function compileGlob(source: string, caseInsensitive: boolean): GlobTester {
  const stars = (source.match(/\[\^\/\]\*|\.\*/g) ?? []).length;
  if (stars <= 2 && !source.includes("|")) return new RegExp(`^${source}$`, caseInsensitive ? "iu" : "u");
  const re = RE2JS.compile(`^${source}$`, caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0);
  return { test: (s) => re.matcher(s).find() };
}

export type GlobMatch = "ignore" | "whitelist" | null;

export interface GitignoreRule {
  re: GlobTester;
  whitelist: boolean;
  dirOnly: boolean;
}

/** 正则语法字符转义（u 标志下只允许转义语法字符与 /；`-` 在类外转义会是语法错误）。 */
function escapeRe(c: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c;
}

export class GlobSyntaxError extends Error {
  constructor(glob: string, detail: string) {
    super(`error parsing glob '${glob}': ${detail}`);
  }
}

/** glob → 正则源（不含 ^$）。未闭合的 `[`、`{` 抛 GlobSyntaxError。 */
export function globToRegexSource(glob: string, o: { allowUnclosedClass?: boolean } = {}): string {
  let out = "";
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "\\" && i + 1 < glob.length) {
      out += escapeRe(glob[i + 1]!);
      i += 2;
      continue;
    }
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length || glob[i + 2] === "/";
        if (atStart && atEnd) {
          if (i + 2 === glob.length) {
            out += ".*"; // 末尾 **：其下一切
            i += 2;
          } else {
            out += "(?:.*/)?"; // **/：零或多级目录
            i += 3;
          }
          continue;
        }
        out += "[^/]*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (c === "[") {
      const end = classEnd(glob, i);
      // 未闭合的 [ 与 ripgrep 一样报错（--glob 退出码 2；忽略文件里的坏规则跳过）
      if (end < 0) {
        // 忽略文件里未闭合的 [ 按字面量（ripgrep 的 ignore crate 如此；复核 S3B 处置复核 B-10）；--glob 里报错
        if (!o.allowUnclosedClass) throw new GlobSyntaxError(glob, "unclosed character class; missing ']'");
        out += "\\[";
        i += 1;
        continue;
      }
      let body = glob.slice(i + 1, end);
      let neg = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        neg = true;
        body = body.slice(1);
      }
      let cls = "";
      for (let k = 0; k < body.length; k++) {
        const ch = body[k]!;
        if (ch === "\\" && k + 1 < body.length) {
          cls += `\\${body[k + 1]!}`;
          k += 1;
        } else if (ch === "-" && k > 0 && k < body.length - 1) cls += "-";
        else cls += /[\]\\^-]/.test(ch) ? `\\${ch}` : ch;
      }
      out += neg ? `[^/${cls}]` : `[${cls}]`;
      i = end + 1;
      continue;
    }
    if (c === "{") {
      braceDepth += 1;
      out += "(?:";
      i += 1;
      continue;
    }
    if (c === "}" && braceDepth > 0) {
      braceDepth -= 1;
      out += ")";
      i += 1;
      continue;
    }
    if (c === "," && braceDepth > 0) {
      out += "|";
      i += 1;
      continue;
    }
    out += escapeRe(c);
    i += 1;
  }
  if (braceDepth > 0) throw new GlobSyntaxError(glob, "unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)");
  return out;
}

/** `[` 起的字符类结束位置（`]` 紧随 `[` 或 `[!` 时是字面量）；没有闭合返回 -1。 */
function classEnd(glob: string, start: number): number {
  let k = start + 1;
  if (glob[k] === "!" || glob[k] === "^") k += 1;
  if (glob[k] === "]") k += 1;
  for (; k < glob.length; k++) {
    if (glob[k] === "\\") {
      k += 1;
      continue;
    }
    if (glob[k] === "]") return k;
  }
  return -1;
}

/** 解析一行 gitignore 规则（注释与空行返回 null）。 */
export function parseGitignoreLine(raw: string, caseInsensitive = false, o: { allowUnclosedClass?: boolean } = {}): GitignoreRule | null {
  let line = raw.replace(/\r$/, "");
  if (line.startsWith("#")) return null;
  // 行尾空白去除（含全角空格等 Unicode 空白，与 ripgrep 一致；反斜杠转义的空格保留）
  while (line.length > 0 && /\s$/u.test(line) && !line.endsWith("\\ ")) line = line.slice(0, -1);
  if (line.endsWith("\\ ")) line = `${line.slice(0, -2)} `;
  if (line === "") return null;
  let whitelist = false;
  let anchored = false;
  if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  } else {
    if (line.startsWith("!")) {
      whitelist = true;
      line = line.slice(1);
    }
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    }
  }
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === "") return null;
  let glob = line;
  if (!anchored && !glob.includes("/") && !glob.startsWith("**/")) glob = `**/${glob}`;
  if (glob.endsWith("/**")) glob = `${glob}/*`;
  return { re: compileGlob(globToRegexSource(glob, o), caseInsensitive), whitelist, dirOnly };
}

/** 一组规则（同一文件或同一组 `--glob`）对相对路径的判定：最后一条命中的规则决定；没有命中返回 null。 */
export function matchRules(rules: readonly GitignoreRule[], rel: string, isDir: boolean): GlobMatch {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!;
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) return r.whitelist ? "whitelist" : "ignore";
  }
  return null;
}

/**
 * 解析整个忽略文件的内容。坏规则（未闭合的 `{`）跳过并经 onError 报告（ripgrep 打印“line N: error parsing glob …”到 stderr、检索照常、退出码不变）；
 * 未闭合的 `[` 按字面量。truncated：内容被截断（只读了前 1 MiB）——最后一行可能残缺（如 `*.log.bak` 截成 `*`），丢弃。
 */
export function parseGitignore(text: string, o: { onError?: (line: number, message: string) => void; truncated?: boolean } = {}): GitignoreRule[] {
  const out: GitignoreRule[] = [];
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  if (o.truncated && lines.length > 0) lines.pop();
  for (let n = 0; n < lines.length; n++) {
    if (out.length >= MAX_RULES_PER_FILE) break;
    try {
      const r = parseGitignoreLine(lines[n]!, false, { allowUnclosedClass: true });
      if (r) out.push(r);
    } catch (e) {
      o.onError?.(n + 1, String((e as Error)?.message ?? e));
    }
  }
  return out;
}

/** 文件名 glob（文件类型用）：只匹配文件名本身。 */
export function basenameGlob(glob: string): GlobTester {
  return compileGlob(globToRegexSource(glob), false);
}
