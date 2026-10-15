/**
 * 样式门禁（Y4 #30 V-1～V-4，代替 stylelint：不新增依赖，规则与令牌测试同源；复核 S8B-01/02/05/06/08/11 加固）：
 * - 组件样式（src 下一切 .css）不得出现颜色字面量：十六进制、rgb/hsl 及新式颜色函数、CSS 具名色（完整关键字表）；
 * - 字号只用 7 级令牌（或 inherit），圆角只用 5 级令牌（或 50%、0）；
 * - 引用的每个令牌都已在 tokens.css 定义，不写回退值；组件样式不直接用基础色板 --p-*，也不另起令牌；
 * - 填充类令牌（--risk-high/--risk-mid/--accent/--status-*-solid）不作文字色；opacity < 1 只用于禁用态；
 * - 纸面：背景用纸面类令牌的规则同时写纸面文字色；纸面容器后代的规则不得用非纸面文字令牌；
 * - 界面源码（TSX/TS）不写颜色字面量与内联颜色/字号样式——隔离预览框架的 srcdoc 两个样式常量除外，且其值必须等于令牌；
 *   主进程窗口首帧底色同样必须等于令牌；
 * - 外观偏好：跟随系统 / 浅色 / 深色的判定，持久化与打印切换（假 window/document）。
 * 每条检查都附反向样本：检查函数对已知违规写法必须判失败，防止日后把正则改松。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTheme } from "../src/lib/ui-prefs.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const TOKENS = strip(readFileSync(join(root, "../../packages/design-tokens/src/tokens.css"), "utf8"));

function walk(dir: string, re: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, re) : re.test(n) ? [p] : [];
  });
}
const rel = (f: string): string => f.slice(root.length).replace(/\\/g, "/");
const CSS_FILES = walk(join(root, "src"), /\.css$/);
const CSS = CSS_FILES.map((f) => strip(readFileSync(f, "utf8"))).join("\n");

interface Decl {
  selector: string;
  prop: string;
  value: string;
  line: string;
}
function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}
function declarations(css: string): Decl[] {
  const out: Decl[] = [];
  for (const r of rules(css)) {
    for (const d of r.body.split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      const prop = d.slice(0, i).trim();
      if (!/^-?-?[a-z-]+$/.test(prop)) continue;
      out.push({ selector: r.selector, prop, value: d.slice(i + 1).trim(), line: `${r.selector} { ${d.trim()} }` });
    }
  }
  return out;
}

/** CSS Color 4 的具名色关键字（全部 148 个，含 rebeccapurple；transparent/currentcolor 不算颜色字面量）。 */
const NAMED_COLORS = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" "),
);
const COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\(/i;
/** 不承载颜色的属性：按词切分时跳过（动画名、字体名、网格区域名可能恰好是颜色词）。 */
const NON_COLOR_PROPS = /^(content|font-family|font|grid-template-areas|grid-area|animation|animation-name|transition|transition-property|counter-reset|counter-increment|list-style-type|will-change)$/;

export function colorLiteralProblem(d: Pick<Decl, "prop" | "value">): boolean {
  const v = d.value.replace(/var\([^)]*\)/g, "");
  if (/#[0-9a-f]{3,8}\b/i.test(v) || COLOR_FN.test(v)) return true;
  if (NON_COLOR_PROPS.test(d.prop) || d.prop.startsWith("--")) return false;
  return v.split(/[^A-Za-z]+/).some((w) => NAMED_COLORS.has(w.toLowerCase()));
}
export function fontSizeProblem(d: Pick<Decl, "prop" | "value">): boolean {
  return d.prop === "font-size" && !/^(var\(--(fs-[a-z0-9]+|font-reading-size|font-table-size|doc-size)\)|inherit)$/.test(d.value);
}
export function radiusProblem(d: Pick<Decl, "prop" | "value">): boolean {
  return /^border(-[a-z]+)*-radius$/.test(d.prop) && !d.value.split(/\s+/).every((v) => /^(var\(--(r-[a-z0-9]+|radius-input|radius-card)\)|50%|0)$/.test(v));
}
/** 填充类令牌作文字色（S8B-05）：#d92d20 等在浅底上不足 4.5:1。 */
export function fillAsTextProblem(d: Pick<Decl, "prop" | "value">): boolean {
  return d.prop === "color" && /var\(--(risk-high|risk-mid|risk-low|accent|status-[a-z]+-solid)\)/.test(d.value);
}
/** 降不透明度会改变实际对比度（S8B-06）：只许禁用态与纯装饰。 */
export function opacityProblem(d: Pick<Decl, "selector" | "prop" | "value">): boolean {
  return d.prop === "opacity" && Number(d.value) < 1 && !/:disabled/.test(d.selector);
}
const PAPER_BG = /var\(--(bg-paper|bg-preview|hl-[a-z]+|paper-mark-(person|partial|org|id|place|negative))\)/;
const PAPER_CONTAINERS = [".wb-doc", ".ev-text", ".vis-sent", ".ev-quote"];
/** 纸面底色的规则必须同规则写纸面文字色（S8B-01：评测页类别按钮曾因整类豁免而浅底浅字）；标注标签的 ::after 用标签令牌。 */
export function paperInkProblem(r: { selector: string; body: string }): boolean {
  if (!/background/.test(r.body) || !PAPER_BG.test(r.body)) return false;
  if (/::after/.test(r.selector)) return !/color:\s*var\(--paper-mark-label-text\)/.test(r.body);
  // 审查工作台的标记只在 .wb-doc 内（.wb-doc 写了纸面文字色，标记 color: inherit）
  if (/^\.wb-mark/.test(r.selector)) return !/color:\s*inherit/.test(r.body) && /color:/.test(r.body);
  // 预览框架：框架内文书自带颜色
  if (/^\.sp-frame/.test(r.selector)) return false;
  return !/(^|;)\s*color:\s*var\(--text-on-paper(-muted)?\)/.test(r.body);
}
/** 纸面容器后代的规则不得用非纸面文字令牌（S8B-02：.wb-doc 里的 .muted 曾在深色下 2.41:1）。 */
export function paperDescendantProblem(r: { selector: string; body: string }): boolean {
  const inPaper = r.selector.split(",").some((s) => PAPER_CONTAINERS.some((c) => s.trim().startsWith(`${c} `)));
  if (!inPaper) return false;
  const m = /(?:^|;)\s*color:\s*([^;]+)/.exec(r.body);
  return !!m && !/^(var\(--text-on-paper(-muted)?\)|inherit|var\(--paper-[a-z-]+\))$/.test(m[1]!.trim());
}

const DECLS = declarations(CSS);
const RULES = rules(CSS);

test("组件样式没有颜色字面量：十六进制、rgb()/hsl() 与新式颜色函数、完整具名色表一律经令牌（附反向样本）", () => {
  assert.deepEqual(DECLS.filter(colorLiteralProblem).map((d) => d.line), []);
  for (const bad of [
    { prop: "color", value: "#fff" },
    { prop: "color", value: "crimson" },
    { prop: "background", value: "lightgray" },
    { prop: "border", value: "1px solid whitesmoke" },
    { prop: "color", value: "oklch(70% 0.1 200)" },
    { prop: "background", value: "color-mix(in srgb, var(--accent) 20%, white)" },
    { prop: "box-shadow", value: "0 0 0 2px hsl(0 0% 0%)" },
  ]) {
    assert.ok(colorLiteralProblem(bad), `反向样本未被拦下：${bad.prop}: ${bad.value}`);
  }
  for (const ok of [{ prop: "animation", value: "pulse-green 1s" }, { prop: "color", value: "var(--text-primary)" }, { prop: "background", value: "transparent" }, { prop: "color", value: "currentColor" }]) {
    assert.ok(!colorLiteralProblem(ok), `误报：${ok.prop}: ${ok.value}`);
  }
});

test("字号只用 7 级令牌（Y4 V-1，不再允许 em/%）、圆角只用 5 级令牌（V-3）（附反向样本）", () => {
  assert.deepEqual(DECLS.filter(fontSizeProblem).map((d) => d.line), [], "字号");
  assert.deepEqual(DECLS.filter(radiusProblem).map((d) => d.line), [], "圆角");
  for (const bad of [{ prop: "font-size", value: "12.5px" }, { prop: "font-size", value: "0.92em" }, { prop: "font-size", value: "90%" }]) assert.ok(fontSizeProblem(bad), bad.value);
  for (const bad of [{ prop: "border-radius", value: "10px" }, { prop: "border-top-left-radius", value: "6px" }]) assert.ok(radiusProblem(bad), bad.value);
});

test("填充类令牌不作文字色（S8B-05）；opacity < 1 只用于禁用态（S8B-06）（附反向样本）", () => {
  assert.deepEqual(DECLS.filter(fillAsTextProblem).map((d) => d.line), [], "填充色作文字");
  assert.deepEqual(DECLS.filter(opacityProblem).map((d) => d.line), [], "降不透明度");
  assert.ok(fillAsTextProblem({ prop: "color", value: "var(--risk-high)" }));
  assert.ok(!fillAsTextProblem({ prop: "border-color", value: "var(--risk-high)" }));
  assert.ok(opacityProblem({ selector: ".card-expired", prop: "opacity", value: "0.85" }));
  assert.ok(!opacityProblem({ selector: "button:disabled", prop: "opacity", value: "0.5" }));
});

test("引用的令牌都已定义、不写回退值；组件样式不直接用基础色板、不另起令牌", () => {
  const defined = new Set([...TOKENS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
  const used = [...CSS.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g)];
  assert.deepEqual([...new Set(used.filter((m) => !defined.has(m[1]!)).map((m) => m[1]))], [], "未定义的令牌");
  assert.deepEqual(used.filter((m) => m[2]).map((m) => m[1]), [], "带回退值的 var()");
  assert.deepEqual([...new Set(used.filter((m) => m[1]!.startsWith("--p-")).map((m) => m[1]))], [], "直接引用基础色板");
  assert.deepEqual([...CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]), [], "组件样式里另起令牌（应放到 tokens.css）");
});

test("纸面：纸面底色的规则同时写纸面文字色（无整类豁免）；纸面容器后代不得用非纸面文字令牌（附反向样本）", () => {
  assert.deepEqual(RULES.filter(paperInkProblem).map((r) => r.selector), [], "纸面底色缺纸面文字色");
  assert.deepEqual(RULES.filter(paperDescendantProblem).map((r) => r.selector), [], "纸面容器后代用了非纸面文字令牌");
  for (const sel of PAPER_CONTAINERS) {
    const r = RULES.find((x) => x.selector === sel);
    assert.ok(r && /color:\s*var\(--text-on-paper\)/.test(r.body), `${sel} 须设纸面文字色`);
  }
  // 纸面容器里会出现的通用类：.muted 有纸面覆盖
  assert.ok(RULES.some((r) => /\.wb-doc \.muted/.test(r.selector) && /--text-on-paper-muted/.test(r.body)));
  assert.ok(RULES.some((r) => /\.wb-doc :focus-visible/.test(r.selector) && /--paper-focus/.test(r.body)), "纸面内焦点环用纸面令牌（S8B-04）");
  assert.ok(paperInkProblem({ selector: ".ev-tone-person", body: "background: var(--paper-mark-person);" }), "反向样本：纸面底色无纸面字色");
  assert.ok(paperDescendantProblem({ selector: ".wb-doc .hint", body: "color: var(--text-secondary);" }), "反向样本：纸面后代用语义文字令牌");
});

/** 去注释：保留字符串里的 //（如 https://）。 */
function stripTs(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}
export function tsxColorProblems(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/["'`][^"'`\n]*?(#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\()/g)) {
    if (/#\//.test(m[0])) continue; // 路由锚点 "#/start"
    out.push(m[0]);
  }
  // 内联样式里的颜色、字号、圆角（S8B-08）：style={{ color: "red" }}、fontSize: 11
  for (const m of text.matchAll(/style=\{\{([^}]*)\}\}/g)) {
    if (/\b(color|background\w*|border\w*|fill|stroke|fontSize|borderRadius|opacity)\s*:/.test(m[1]!)) out.push(`style={{${m[1]}}}`);
  }
  return out;
}

test("界面源码不写颜色字面量与内联颜色/字号样式（隔离预览框架的两个样式常量除外）（附反向样本）", () => {
  const bad: string[] = [];
  for (const f of walk(join(root, "src"), /\.tsx?$/)) {
    let text = stripTs(readFileSync(f, "utf8"));
    if (rel(f) === "src/lib/safe-preview.ts") text = text.replace(/const (PAPER_STYLE|BASE_STYLE) = "[^"\n]*";/g, "");
    for (const p of tsxColorProblems(text)) bad.push(`${rel(f)}: ${p}`);
  }
  assert.deepEqual(bad, []);
  assert.ok(tsxColorProblems(`<p style={{ color: "red" }}/>`).length > 0);
  assert.ok(tsxColorProblems(`<p style={{ fontSize: 11 }}/>`).length > 0);
  assert.ok(tsxColorProblems(`const c = "rgba(0,0,0,.5)";`).length > 0);
  assert.equal(tsxColorProblems(`<p style={{ whiteSpace: "pre-line" }}/>`).length, 0);
  assert.equal(stripTs(`const u = "https://x.example"; // 注释`).includes("https://x.example"), true, "去注释不吞掉字符串里的网址");
});

function tokenValue(name: string, block: "light" | "dark" = "light"): string {
  const css = block === "light" ? TOKENS.slice(0, TOKENS.indexOf("@media screen")) : TOKENS.slice(TOKENS.indexOf(':root[data-theme="dark"]'));
  const v = new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
  assert.ok(v, `${name}（${block}）未定义`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v!);
  return ref ? tokenValue(ref[1]!, block === "dark" && new RegExp(`${ref[1]}:`).test(css) ? "dark" : "light") : v!.toLowerCase();
}

test("手抄的令牌值必须等于 tokens.css（S8B-11）：隔离预览框架的纸面与基础样式、主进程窗口首帧底色", () => {
  const sp = readFileSync(join(root, "src/lib/safe-preview.ts"), "utf8");
  const paper = /const PAPER_STYLE = "([^"\n]*)";/.exec(sp)![1]!;
  const base = /const BASE_STYLE = "([^"\n]*)";/.exec(sp)?.[1];
  assert.ok(base, "基础样式须为具名常量 BASE_STYLE");
  assert.match(paper, new RegExp(`color:${tokenValue("--p-paper-ink")};background:${tokenValue("--p-paper")}`, "i"));
  assert.match(base!, new RegExp(`color:${tokenValue("--p-ink")};background:${tokenValue("--p-white")}`, "i"));
  assert.match(base!, new RegExp(`\\.kwl-link\\{color:${tokenValue("--p-blue-600")}`, "i"));
  const main = readFileSync(join(root, "electron/main.cjs"), "utf8");
  const bg = /shouldUseDarkColors \? "(#[0-9a-f]{6})" : "(#[0-9a-f]{6})"/i.exec(main);
  assert.ok(bg, "窗口首帧底色写法变了，请同步本用例");
  assert.equal(bg![1]!.toLowerCase(), tokenValue("--bg-sidebar", "dark"));
  assert.equal(bg![2]!.toLowerCase(), tokenValue("--bg-sidebar"));
});

test("外观偏好：跟随系统按系统明暗，显式选择优先；持久化、系统切换与打印强制浅色（假 window/document）", async () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  const store = new Map<string, string>();
  const winListeners = new Map<string, () => void>();
  let mqListener: (() => void) | null = null;
  const mq = { matches: true, addEventListener: (_: string, f: () => void) => void (mqListener = f) };
  const html = { dataset: {} as Record<string, string>, style: { setProperty() {} } };
  const g = globalThis as any;
  const saved = { window: g.window, document: g.document };
  g.window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    matchMedia: () => mq,
    addEventListener: (t: string, f: () => void) => void winListeners.set(t, f),
  };
  g.document = { documentElement: html };
  try {
    const m = await import(`../src/lib/ui-prefs.ts?case=${Date.now()}`);
    m.applyUiTheme("system");
    assert.equal(html.dataset.theme, "dark", "跟随系统：系统为深色");
    mq.matches = false;
    mqListener!();
    assert.equal(html.dataset.theme, "light", "系统切换即时生效");
    m.applyUiTheme("dark", true);
    assert.equal(store.get(m.UI_THEME_KEY), "dark");
    mq.matches = true;
    mqListener!();
    assert.equal(html.dataset.theme, "dark");
    mq.matches = false;
    mqListener!();
    assert.equal(html.dataset.theme, "dark", "显式选择时不随系统变");
    winListeners.get("beforeprint")!();
    assert.equal(html.dataset.theme, "light", "打印前切浅色");
    winListeners.get("afterprint")!();
    assert.equal(html.dataset.theme, "dark", "打印后还原显式选择");
    m.applyUiTheme("system", true);
    assert.equal(store.has(m.UI_THEME_KEY), false, "跟随系统 = 删除键");
    assert.equal(m.readUiTheme(), "system");
  } finally {
    g.window = saved.window;
    g.document = saved.document;
  }
});
