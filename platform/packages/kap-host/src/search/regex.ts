/**
 * 宿主内检索的正则（审计 S3 第 2 步）：ripgrep 用 Rust regex（RE2 语法族、线性时间、默认 Unicode），这里用 re2js（RE2 的 JS 移植，
 * 同样线性时间、无灾难回溯）。两者的差别按 ripgrep 的语义补齐：
 * - `\d \w \s` 在 Rust regex 里是 Unicode 类（`\w` 含汉字与“〇”、`\s` 含全角空格 U+3000），RE2 是 ASCII——改写为 Unicode 类
 *   （`\w` = L + M + Nd + Nl + Pc + ZWNJ/ZWJ；Rust 的 Alphabetic 另含少量 Other_Alphabetic 字符，如带圈字母——如实残余）；
 *   字符类里的 `\W \S`（取反类无法并入外层类）保持 RE2 的 ASCII 语义（如实残余）；`\b` 仍是 ASCII 词边界（如实残余）；
 *   `\<` `\>` `\b{start}` 等（ripgrep 15 支持）近似为 `\b`；嵌套字符类 `[[a-z]]` 按 Rust 语义展平；取反的嵌套类、类集合运算（`&&` `--` `~~`）
 *   与未闭合的类（含 `[[]`）报语法错误（ripgrep 支持前两者——如实残余：报错而不是静默得出不同结果）；
 * - 不区分大小写的判定：-i 或模式里任意位置出现 `(?…i` 即按不区分大小写补类内 ASCII 大小写（局部 `(?i:…)` 也按全局处理——如实残余）；
 * - 非多行模式下模式里出现字面换行（`\n`、`\x0A`、原样换行、只含换行的类）即报错（与 ripgrep 相同：应改用 -U）；`[^\n]`、`[\na]` 照常；
 * - 编译错误按 ripgrep 的格式输出（`rg: regex parse error:` … `error: …`），退出码 2。
 * Rust 独有的写法（`(?x)` 详细模式、字符类集合运算）在这里报语法错误（如实残余）；不区分大小写时类内的非 ASCII 大小写字母不折叠（如实残余）。
 */
import { RE2JS } from "re2js";

const W_CLASS = "\\p{L}\\p{M}\\p{Nd}\\p{Nl}\\p{Pc}\\x{200C}\\x{200D}";
const S_CLASS = "\\t\\n\\x0B\\f\\r \\x{85}\\p{Z}";

export class RegexSyntaxError extends Error {
  constructor(pattern: string, detail: string) {
    super(`regex parse error:\n    ${pattern}\nerror: ${detail}`);
  }
}

/**
 * re2js 1.3.3 的缺陷：不区分大小写时，没有“折叠表”的 Unicode 类（\\p{Han}、\\p{Nd}、\\p{Z}…，即除 L/Ll/Lt/Lu/M/Mn 与
 * Common/Greek/Inherited 之外的全部）编译即崩溃（Map.get 返回 undefined 而代码只判 null）。RE2 里没有折叠表的类本就对大小写折叠
 * 封闭——包进 `(?-i:…)` 语义不变。字符类里含这类成员时整类包进 `(?-i:…)`，类里的 ASCII 字母与字母区间另补大小写（类内的非 ASCII
 * 大小写字母不再折叠：如实残余，中文语境基本不出现）。
 */
const FOLDABLE = new Set(["L", "Ll", "Lt", "Lu", "M", "Mn", "Common", "Greek", "Inherited"]);

function unicodeName(tok: string): string {
  const m = /^\\[pP](?:\{\^?([^}]*)\}|(.))$/.exec(tok);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

/** 读一个转义序列（含 \\p{…}、\\x{…}、\\xHH、\\Q…\\E），返回其源文本。 */
function readEscape(src: string, i: number): string {
  const n = src[i + 1];
  if (n === undefined) return "\\";
  if (n === "Q") {
    const end = src.indexOf("\\E", i + 2);
    return src.slice(i, end < 0 ? src.length : end + 2);
  }
  if (n === "p" || n === "P" || n === "x") {
    if (src[i + 2] === "{") {
      const end = src.indexOf("}", i + 3);
      return src.slice(i, end < 0 ? src.length : end + 1);
    }
    return src.slice(i, i + (n === "x" ? 4 : 3));
  }
  return src.slice(i, i + 2);
}

/** 字符类内容（不含方括号）的结束位置：`]` 紧随 `[` 或 `[^` 时是字面量；`[:name:]`、转义与嵌套类（Rust）跳过。 */
function classBodyEnd(src: string, start: number): number {
  let k = start;
  if (src[k] === "^") k += 1;
  if (src[k] === "]") k += 1;
  while (k < src.length) {
    const c = src[k]!;
    if (c === "\\") {
      k += readEscape(src, k).length;
      continue;
    }
    if (c === "[" && src[k + 1] === ":") {
      const end = src.indexOf(":]", k + 2);
      if (end >= 0) {
        k = end + 2;
        continue;
      }
    }
    if (c === "[") {
      const inner = classBodyEnd(src, k + 1);
      if (inner < 0) return -1;
      k = inner + 1;
      continue;
    }
    if (c === "]") return k;
    k += 1;
  }
  return -1;
}

const isAsciiLetter = (c: string) => /^[A-Za-z]$/.test(c);
const swapCase = (c: string) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());

/** 字符类内容里的 ASCII 字母与同大小写的字母区间补上另一种大小写。 */
function asciiCaseVariants(body: string): string {
  let extra = "";
  for (let k = body.startsWith("^") ? 1 : 0; k < body.length; k++) {
    const c = body[k]!;
    if (c === "\\") {
      k += readEscape(body, k).length - 1;
      continue;
    }
    if (c === "[" && body[k + 1] === ":") {
      const end = body.indexOf(":]", k + 2);
      if (end >= 0) {
        k = end + 1;
        continue;
      }
    }
    if (body[k + 1] === "-" && k + 2 < body.length && body[k + 2] !== "]") {
      const a = c;
      const b = body[k + 2]!;
      if (isAsciiLetter(a) && isAsciiLetter(b) && (a === a.toLowerCase()) === (b === b.toLowerCase())) extra += `${swapCase(a)}-${swapCase(b)}`;
      k += 2;
      continue;
    }
    if (isAsciiLetter(c)) extra += swapCase(c);
  }
  return body + extra;
}

/** 字符类内容的改写（Unicode 简写类展开；嵌套的非取反类展平）。needsNoFold：含没有折叠表的 Unicode 类。 */
function translateClassBody(body: string): { tb: string; needsNoFold: boolean } {
  let tb = "";
  let needsNoFold = false;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k]!;
    if (ch === "\\") {
      const esc = readEscape(body, k);
      k += esc.length - 1;
      const n = esc[1];
      if (n === "d") tb += "\\p{Nd}";
      else if (n === "D") tb += "\\P{Nd}";
      else if (n === "w") tb += W_CLASS;
      else if (n === "s") tb += S_CLASS;
      else {
        if ((n === "p" || n === "P") && !FOLDABLE.has(unicodeName(esc))) needsNoFold = true;
        tb += esc; // \\W \\S 在类内保持 RE2 的 ASCII 语义（如实残余）
        continue;
      }
      needsNoFold = true;
      continue;
    }
    if (ch === "[" && body[k + 1] === ":") {
      const pe = body.indexOf(":]", k + 2);
      if (pe >= 0) {
        tb += body.slice(k, pe + 2);
        k = pe + 1;
        continue;
      }
    }
    if (ch === "[" && body[k + 1] === "^") throw new Error("negated nested character class is not supported by host search");
    if ((ch === "&" || ch === "-" || ch === "~") && body[k + 1] === ch && k > 0 && k + 2 < body.length) {
      throw new Error("character class set operations (&&, --, ~~) are not supported by host search");
    }
    if (ch === "[") {
      const end = classBodyEnd(body, k + 1);
      if (end >= 0) {
        const inner = translateClassBody(body.slice(k + 1, end));
        tb += inner.tb;
        needsNoFold ||= inner.needsNoFold;
        k = end;
        continue;
      }
    }
    tb += ch;
  }
  return { tb, needsNoFold };
}

/**
 * 把 Rust regex 改写为 re2js 可接受的等价写法。没有折叠表的 Unicode 类一律包进 `(?-i:…)`（不区分大小写时不改语义，区分时是空操作）——
 * 内联 `(?i)` 同样会触发 re2js 的缺陷（复核 S3B-B09）；被整类包住的字符类在不区分大小写的语境（-i 或模式里出现 `(?…i`）下另补 ASCII 大小写。
 */
export function translateRustRegex(src: string, ignoreCase = false): string {
  const caseless = ignoreCase || /\(\?[a-zA-Z]*i/.test(src);
  const noFold = (tok: string) => `(?-i:${tok})`;
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const esc = readEscape(src, i);
      i += esc.length - 1;
      const n = esc[1];
      if (n === "p" || n === "P") out += FOLDABLE.has(unicodeName(esc)) ? esc : noFold(esc);
      else if (n === "d") out += noFold("\\p{Nd}");
      else if (n === "D") out += noFold("\\P{Nd}");
      else if (n === "w") out += noFold(`[${W_CLASS}]`);
      else if (n === "W") out += noFold(`[^${W_CLASS}]`);
      else if (n === "s") out += noFold(`[${S_CLASS}]`);
      else if (n === "S") out += noFold(`[^${S_CLASS}]`);
      else if (n === "<" || n === ">") out += "\\b";
      else if (n === "b" && src[i + 1] === "{") {
        // \\b{start} \\b{end} \\b{start-half} \\b{end-half}（ripgrep 15）：近似为 \\b
        const end = src.indexOf("}", i + 2);
        if (end >= 0 && /^[a-z-]+$/.test(src.slice(i + 2, end))) {
          out += "\\b";
          i = end;
        } else out += esc;
      } else out += esc;
      continue;
    }
    if (c === "[") {
      const end = classBodyEnd(src, i + 1);
      // 未闭合（含 `[[]` 这类嵌套未闭合）：与 ripgrep 一样报语法错误（RE2 会把 `[[]` 当作含 `[` 的类）
      if (end < 0) throw new Error("unclosed character class");
      const { tb, needsNoFold } = translateClassBody(src.slice(i + 1, end));
      out += needsNoFold ? `(?-i:[${caseless ? asciiCaseVariants(tb) : tb}])` : `[${tb}]`;
      i = end;
      continue;
    }
    out += c;
  }
  return out;
}

/** 非多行模式下 ripgrep 拒绝的字面换行：类外的 `\n`、`\x0A`、`\x{A}`、原样换行；只含换行的字符类 `[\n]`。 */
function hasLiteralNewline(src: string): boolean {
  const isNl = (esc: string) => esc === "\\n" || /^\\x(?:0[aA]|\{0*[aA]\})$/.test(esc);
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\n") return true;
    if (c === "\\") {
      const esc = readEscape(src, i);
      if (isNl(esc)) return true;
      i += esc.length - 1;
      continue;
    }
    if (c === "[") {
      const end = classBodyEnd(src, i + 1);
      if (end < 0) return false;
      const body = src.slice(i + 1, end);
      if (isNl(body) || body === "\n") return true;
      i = end;
    }
  }
  return false;
}

const META = /[\\.^$|?*+()[\]{}]/;

export interface CompiledPattern {
  /** 一行（不含换行）里是否有匹配。 */
  test(line: string): boolean;
  /** 一段文本里是否有匹配（多行模式的 -l；找到第一个即返回）。 */
  any(text: string): boolean;
  /** 逐个匹配区间回调（非重叠；空匹配后前进一位）；回调返回 false 即停止。不物化全部区间（复核 S3B-B03）。 */
  each(text: string, cb: (start: number, end: number) => boolean | void): void;
  /** 整段文本里是否可能有匹配（预筛：整段都没有命中的文件不必逐行检索；锚点类模式返回 true）。 */
  mayMatch(text: string): boolean;
  /**
   * 匹配个数（--count-matches）：与 ripgrep 一致按字节计空匹配——ripgrep 在 UTF-8 字节上匹配，空匹配出现在每个字节位置；
   * JS 字符串按 UTF-16 码元前进，这里把落在一个字符上的空匹配按该字符的 UTF-8 字节数计。noTerminator：这一行没有行尾换行
   * （文件最后一行），行尾处的空匹配不计（与 ripgrep 一致）。迭代计数，不留区间数组。
   */
  count(text: string, noTerminator?: boolean): number;
}

function utf8LenAt(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (Number.isNaN(c)) return 1; // 文本末尾的空匹配
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c >= 0xd800 && c <= 0xdbff) return 4;
  if (c >= 0xdc00 && c <= 0xdfff) return 0; // 代理对的后半：已随前半计入
  return 3;
}

export function compilePattern(pattern: string, o: { ignoreCase: boolean; multiline: boolean; dotall: boolean }): CompiledPattern {
  if (!o.multiline && hasLiteralNewline(pattern)) {
    throw new RegexSyntaxError(pattern, `the literal '"\\n"' is not allowed in a regex\n\nConsider enabling multiline mode with the --multiline flag (or -U for short).`);
  }
  let each: CompiledPattern["each"];
  let test: (s: string) => boolean;
  let mayMatch: (s: string) => boolean;
  // 字面量快路径：没有元字符、且（不区分大小写时）没有大小写之分的字符
  if (!META.test(pattern) && (!o.ignoreCase || pattern.toLowerCase() === pattern.toUpperCase())) {
    test = (line) => line.includes(pattern);
    mayMatch = test;
    each = (text, cb) => {
      if (pattern === "") {
        for (let i = 0; i <= text.length; i++) if (cb(i, i) === false) return;
        return;
      }
      for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + pattern.length)) if (cb(at, at + pattern.length) === false) return;
    };
  } else {
    let re: RE2JS;
    try {
      re = RE2JS.compile(translateRustRegex(pattern, o.ignoreCase), RE2JS.MULTILINE | (o.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0) | (o.dotall ? RE2JS.DOTALL : 0));
    } catch (e) {
      throw new RegexSyntaxError(pattern, String((e as Error)?.message ?? e).replace(/^error parsing regexp: /, ""));
    }
    const anchoredToText = /\\[Az]/.test(pattern);
    test = (line) => re.matcher(line).find();
    mayMatch = (text) => anchoredToText || re.matcher(text).find();
    each = (text, cb) => {
      const m = re.matcher(text);
      while (m.find()) if (cb(m.start(), m.end()) === false) return;
    };
  }
  return {
    test,
    mayMatch,
    each,
    any(text) {
      let found = false;
      each(text, () => {
        found = true;
        return false;
      });
      return found;
    },
    count(text, noTerminator = false) {
      let n = 0;
      each(text, (s, e) => {
        if (s === e && s === text.length && noTerminator) return;
        n += s === e ? utf8LenAt(text, s) : 1;
      });
      return n;
    },
  };
}
