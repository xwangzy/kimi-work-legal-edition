/**
 * 设计令牌门禁（Y4 #30 V-2、#32 V-10）：三层结构、深色覆盖完整、深浅两套的对比度（WCAG 2.x 实算）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../src/tokens.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

export function tokenBlocks(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const block = (sel: RegExp): Map<string, string> => {
    const m = sel.exec(css);
    assert.ok(m, `缺少选择器 ${sel}`);
    const body = css.slice(m.index + m[0].length, css.indexOf("}", m.index));
    const out = new Map<string, string>();
    for (const d of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      assert.ok(!out.has(d[1]!), `${d[1]} 重复定义`);
      out.set(d[1]!, d[2]!.trim());
    }
    return out;
  };
  return { light: block(/:root\s*\{/), dark: block(/:root\[data-theme="dark"\]\s*\{/) };
}

const { light, dark } = tokenBlocks(CSS);
const themed = new Map([...light, ...dark]);

function resolve(map: Map<string, string>, name: string, seen: string[] = []): string {
  assert.ok(!seen.includes(name), `循环引用 ${[...seen, name].join(" → ")}`);
  const v = map.get(name);
  assert.ok(v !== undefined, `令牌 ${name} 未定义`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  return ref ? resolve(map, ref[1]!, [...seen, name]) : v;
}

type Rgba = [number, number, number, number];
function parseColor(v: string): Rgba {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error(`不是颜色：${v}`);
}
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a)).concat(1) as Rgba;
}
function lum(c: Rgba): number {
  const ch = c.slice(0, 3).map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
export function contrast(fg: string, bg: string): number {
  const b = parseColor(bg);
  const f = over(parseColor(fg), b);
  const [l1, l2] = [lum(f), lum(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** 正文文字（4.5:1）：[前景, 背景…]；所有组合在深浅两套里都要过线。 */
const TEXT_PAIRS: [string, string[]][] = [
  ["--text-primary", ["--bg-main", "--bg-sidebar", "--bg-surface", "--bg-elevated", "--bg-subtle", "--bg-muted", "--bg-hover", "--bg-active", "--accent-bg", "--bg-code"]],
  ["--text-secondary", ["--bg-main", "--bg-sidebar", "--bg-surface", "--bg-elevated", "--bg-subtle", "--bg-muted", "--bg-hover", "--bg-active", "--accent-bg", "--bg-code"]],
  ["--text-label", ["--bg-main", "--bg-sidebar", "--bg-surface", "--bg-hover"]],
  ["--text-strong", ["--bg-main", "--bg-surface"]],
  ["--accent-text", ["--bg-main", "--bg-sidebar", "--bg-surface", "--accent-bg", "--bg-hover"]],
  ["--status-danger-text", ["--bg-main", "--bg-surface", "--bg-elevated", "--status-danger-bg"]],
  ["--status-danger-strong", ["--status-danger-bg", "--bg-surface"]],
  ["--status-warning-text", ["--bg-main", "--bg-surface", "--status-warning-bg", "--status-warning-bg-soft"]],
  ["--status-warning-strong", ["--status-warning-bg", "--bg-surface"]],
  ["--status-success-text", ["--bg-main", "--bg-surface", "--status-success-bg"]],
  ["--status-success-strong", ["--status-success-bg"]],
  ["--status-info-text", ["--bg-main", "--bg-surface", "--status-info-bg"]],
  ["--status-neutral-text", ["--bg-surface", "--status-neutral-bg"]],
  ["--status-neutral-strong", ["--status-neutral-bg"]],
  ["--status-purple-text", ["--bg-surface", "--status-purple-bg"]],
  ["--btn-primary-text", ["--btn-primary", "--btn-primary-hover"]],
  ["--text-on-solid", ["--accent-text"]], // 计数徽标等实色底上的字：底色用 --accent-text（#167ffb 上白字仅 3.8:1）
  ["--text-on-paper-muted", ["--bg-paper", "--paper-quote-bg"]],
  ["--text-on-paper", ["--bg-paper", "--paper-mark-partial", "--hl-citation", "--hl-risk", "--hl-revision", "--hl-added", "--hl-restored", "--paper-mark-person", "--paper-mark-org", "--paper-mark-id", "--paper-mark-place", "--paper-mark-negative", "--paper-quote-bg"]],
  ["--paper-mark-label-text", ["--paper-mark-label-person", "--paper-mark-label-partial", "--paper-mark-label-org", "--paper-mark-label-id", "--paper-mark-label-place", "--paper-mark-label-negative"]],
];
/** 非文本（3:1，WCAG 1.4.11）：表单控件边框、焦点环、出错色条。橙绿状态圆点总与文字说明同现（颜色不是唯一信息），不在此列。 */
const UI_PAIRS: [string, string[]][] = [
  ["--border-strong", ["--bg-main", "--bg-surface"]],
  ["--focus-ring", ["--bg-main", "--bg-surface", "--bg-sidebar", "--bg-elevated"]],
  ["--paper-focus", ["--bg-paper", "--paper-mark-person", "--paper-mark-partial", "--paper-mark-org", "--paper-mark-id", "--paper-mark-place", "--hl-risk", "--hl-citation"]],
  ["--accent", ["--bg-main", "--bg-surface"]],
  ["--status-danger-solid", ["--bg-surface"]],
];

for (const [theme, map] of [["浅色", light], ["深色", themed]] as const) {
  test(`对比度（${theme}）：正文 ≥ 4.5:1、控件与焦点 ≥ 3:1`, () => {
    const bad: string[] = [];
    for (const [pairs, min] of [[TEXT_PAIRS, 4.5], [UI_PAIRS, 3]] as const) {
      for (const [fg, bgs] of pairs) {
        for (const bg of bgs) {
          const r = contrast(resolve(map, fg), resolve(map, bg));
          if (r < min) bad.push(`${fg} / ${bg} = ${r.toFixed(2)} < ${min}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });
}

test("基础色板只放六位十六进制；深色块不改基础色板（深色直接给语义值）", () => {
  for (const [k, v] of light) {
    if (k.startsWith("--p-")) assert.match(v, /^#[0-9a-f]{6}$/i, `${k} 基础色板只放六位十六进制`);
  }
  // 深色块不改基础色板（基础色板是“浅色值”的命名，深色直接给语义值）
  assert.deepEqual([...dark.keys()].filter((k) => k.startsWith("--p-")), []);
});

test("深色覆盖完整：浅色里每个颜色类语义令牌（除纸面类）在深色块都有改写，或经引用随之变化", () => {
  const PAPER = /^--(bg-paper|bg-preview|text-on-paper|paper-|hl-)/;
  const colorish = (v: string): boolean => /^(#|rgba?\()/.test(v) || /^var\(--p-/.test(v);
  const missing: string[] = [];
  for (const [k, v] of light) {
    if (k.startsWith("--p-") || PAPER.test(k) || dark.has(k)) continue;
    if (!colorish(v)) continue; // 引用语义层的：随语义层变化
    missing.push(k);
  }
  assert.deepEqual(missing, [], "这些令牌在深色模式下仍是浅色值");
  // 深色块只改写浅色块里已有的令牌（不新增名字）
  assert.deepEqual([...dark.keys()].filter((k) => !light.has(k)), []);
  // 纸面令牌两套相同（文书预览保持纸面白）
  assert.deepEqual([...dark.keys()].filter((k) => PAPER.test(k)), []);
});

test("字号 7 级、圆角 5 级（Y4 V-1、V-3；中文不用半像素）", () => {
  const fs = [...light].filter(([k, v]) => k.startsWith("--fs-") && !v.startsWith("var(")).map(([, v]) => v);
  assert.deepEqual(fs, ["12px", "13px", "14px", "15px", "16px", "20px", "28px"]);
  // 按用途的字号令牌（v9.4 第 20 批，U1 §3.6）只能是这 7 级的别名，不加新档
  const purpose = [...light].filter(([k, v]) => k.startsWith("--fs-") && v.startsWith("var("));
  assert.ok(purpose.length >= 8);
  for (const [k, v] of purpose) assert.match(v, /^var\(--fs-(xs|sm|base|md|lg|xl|2xl)\)$/, k);
  const r = [...light].filter(([k]) => /^--r-/.test(k)).map(([, v]) => v);
  assert.deepEqual(r, ["4px", "8px", "12px", "16px", "999px"]);
});

test("深色下弹层比卡片亮一级（S8B-09：同色时只剩 1px 暗边区分层次）", () => {
  const l = (v: string) => contrast(v, "#000000");
  assert.ok(l(resolve(themed, "--bg-elevated")) > l(resolve(themed, "--bg-surface")) * 1.05);
});

