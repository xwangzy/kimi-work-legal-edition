/**
 * 样式门禁（Y4 #30 V-1～V-4，代替 stylelint：不新增依赖，规则与令牌测试同源）：
 * - 组件样式（styles.css）不得出现颜色字面量（十六进制、rgb/hsl、具名色），颜色一律经语义令牌；
 * - 字号只用 7 级令牌（或 em/百分比/inherit），圆角只用 5 级令牌（或 50%、0）；
 * - 引用的每个令牌都已在 tokens.css 定义，不写回退值（回退值会把字面量带回来）；
 * - 组件样式不直接用基础色板 --p-*；
 * - 界面源码（TSX/TS）不写颜色字面量——隔离预览框架的 srcdoc 样式除外（框架内取不到本页令牌）；
 * - 外观偏好：跟随系统 / 浅色 / 深色的判定。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTheme } from "../src/lib/ui-prefs.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const STYLES = strip(readFileSync(join(root, "src/styles.css"), "utf8"));
const TOKENS = strip(readFileSync(join(root, "../../packages/design-tokens/src/tokens.css"), "utf8"));

function declarations(css: string): { prop: string; value: string; line: string }[] {
  const out: { prop: string; value: string; line: string }[] = [];
  for (const rule of css.matchAll(/\{([^{}]*)\}/g)) {
    for (const d of rule[1]!.split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      const prop = d.slice(0, i).trim();
      if (!/^-?-?[a-z-]+$/.test(prop)) continue;
      out.push({ prop, value: d.slice(i + 1).trim(), line: d.trim() });
    }
  }
  return out;
}
const DECLS = declarations(STYLES);

const NAMED = /\b(white|black|red|green|blue|orange|yellow|purple|gray|grey|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|pink|brown|gold)\b/i;

test("组件样式没有颜色字面量：十六进制、rgb()/hsl()、具名色一律经令牌", () => {
  const bad = DECLS.filter((d) => /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(d.value) || (!d.prop.startsWith("font") && !/^(content|grid-template-areas)$/.test(d.prop) && NAMED.test(d.value.replace(/var\([^)]*\)/g, ""))));
  assert.deepEqual(bad.map((d) => d.line), []);
});

test("字号只用 7 级令牌（Y4 V-1）、圆角只用 5 级令牌（V-3），中文不用半像素", () => {
  const fs = DECLS.filter((d) => d.prop === "font-size" && !/^(var\(--(fs-[a-z0-9]+|font-reading-size|font-table-size|doc-size)\)|[\d.]+em|\d+%|inherit)$/.test(d.value));
  assert.deepEqual(fs.map((d) => d.line), [], "字号");
  const radius = DECLS.filter((d) => /^border(-[a-z]+)*-radius$/.test(d.prop) && !d.value.split(/\s+/).every((v) => /^(var\(--(r-[a-z0-9]+|radius-input|radius-card)\)|50%|0)$/.test(v)));
  assert.deepEqual(radius.map((d) => d.line), [], "圆角");
  assert.deepEqual(DECLS.filter((d) => /\d\.5px/.test(d.value) && d.prop.startsWith("font")).map((d) => d.line), []);
});

test("引用的令牌都已定义、不写回退值；组件样式不直接用基础色板", () => {
  const defined = new Set([...TOKENS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
  const used = [...STYLES.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g)];
  assert.deepEqual([...new Set(used.filter((m) => !defined.has(m[1]!)).map((m) => m[1]))], [], "未定义的令牌");
  assert.deepEqual(used.filter((m) => m[2]).map((m) => m[1]), [], "带回退值的 var()");
  assert.deepEqual([...new Set(used.filter((m) => m[1]!.startsWith("--p-")).map((m) => m[1]))], [], "直接引用基础色板");
  assert.deepEqual([...STYLES.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]), [], "组件样式里另起令牌（应放到 tokens.css）");
});

test("纸面区域（文书预览、审查原文、评测文书、发送示例）同时写明纸面底色与纸面文字色——深色模式下不出现浅底浅字", () => {
  const rules = [...STYLES.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const bad = rules.filter((r) => /var\(--(bg-paper|hl-[a-z]+|paper-mark-(person|partial|org|id|place|negative))\)/.test(r[2]!) && /background/.test(r[2]!) && !/(^|;)\s*color:\s*var\(--text-on-paper\)/.test(r[2]!) && !/::after/.test(r[1]!) && !/\.(ev-tone|wb-mark)/.test(r[1]!));
  assert.deepEqual(bad.map((r) => r[1]!.trim()), []);
  // 标注与风险标记只出现在纸面容器内（.ev-text、.wb-doc 已设纸面文字色）
  for (const sel of [".wb-doc", ".ev-text"]) {
    const r = rules.find((x) => x[1]!.trim() === sel);
    assert.ok(r && /color:\s*var\(--text-on-paper\)/.test(r[2]!), `${sel} 须设纸面文字色`);
  }
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(n) ? [p] : [];
  });
}

test("界面源码不写颜色字面量（隔离预览框架的 srcdoc 样式除外）", () => {
  const allow = new Set(["src/lib/safe-preview.ts", "src/styles.css"]);
  const bad: string[] = [];
  for (const f of walk(join(root, "src"))) {
    const rel = f.slice(root.length).replace(/\\/g, "/");
    if (allow.has(rel)) continue;
    const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const m of text.matchAll(/["'`][^"'`\n]*?(#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z_-])|rgba?\()/g)) {
      // 选择器里的 # 锚点（如 "#/start"）不是颜色
      if (/#\//.test(m[0])) continue;
      bad.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("外观偏好：跟随系统按系统明暗，显式选择优先", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});
