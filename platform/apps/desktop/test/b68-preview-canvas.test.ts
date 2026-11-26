/**
 * V42（第 68 批）预览“草稿纸”：文书纸放在画布上（画布 + 极淡点阵只在纸外，纸面纯白、三层投影），深色界面换深色画布、纸仍是白纸；
 * Markdown 草稿用同一张画布上的便笺纸。底纹只是界面：不改隔离框架的安全策略、不进下载件 / 导出 PDF / 打印。
 * 手抄令牌值与 tokens.css 相等由 style-tokens.test.ts 核对；这里核对接线与隔离。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PREVIEW_CSP } from "../src/lib/safe-preview.ts";

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
const repo = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");

test("隔离框架的安全策略不因底纹放宽：CSP 原样，底纹全用 CSS 渐变（不引用任何图片，含 data:）", () => {
  assert.equal(PREVIEW_CSP, "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'");
  const sp = src("lib/safe-preview.ts");
  for (const name of ["PAPER_STYLE", "PAPER_DARK_STYLE", "SHEET_STYLE", "SHEET_DARK_STYLE"]) {
    const css = new RegExp(`const ${name} = "([^"\\n]*)";`).exec(sp)?.[1];
    assert.ok(css, name);
    assert.doesNotMatch(css!, /url\(|@import|https?:/i, `${name} 不引用外部或内联图片`);
  }
  // 点阵只画在 html（纸外），正文的祖先链上（body、.kwl-paper）没有画布底色：复制时 Chromium 取到的“生效底色”是白纸
  const paper = /const PAPER_STYLE = "([^"\n]*)";/.exec(sp)![1]!;
  assert.match(paper, /^html\{background-color:[^;]+;background-image:radial-gradient/);
  assert.doesNotMatch(paper, /body\{[^}]*background-image/);
  assert.doesNotMatch(paper, /\.kwl-paper\{[^}]*background-image/);
});

test("深色画布排在内核样式之后、只在界面深色且是 Office 预览时加；打印媒体下画布与投影都去掉", () => {
  const sp = src("lib/safe-preview.ts");
  assert.match(sp, /styles,\n\s*\/\/[^\n]*\n\s*o\.dark && o\.sheet \? `<style>\$\{SHEET_DARK_STYLE\}<\/style>` : o\.dark && o\.paper \? `<style>\$\{PAPER_DARK_STYLE\}<\/style>` : "",/);
  for (const name of ["PAPER_STYLE", "PAPER_DARK_STYLE", "SHEET_STYLE", "SHEET_DARK_STYLE"]) {
    const css = new RegExp(`const ${name} = "([^"\\n]*)";`).exec(sp)![1]!;
    assert.match(css, /@media print\{html\{[^}]*background:none;\}/, `${name} 打印时去掉画布`);
  }
  const comp = src("components/SafePreview.tsx");
  assert.match(comp, /attributeFilter: \["data-theme"\]/, "跟着 <html data-theme> 变（ui-prefs 写入）");
  assert.match(comp, /\.\.\.\(office && dark \? \{ dark: true \} : \{\}\)/, "只有 Office 预览换深色画布（任意 HTML 产物仍按原样白底）");
  assert.match(comp, /\[isHtml, docHtml, tokenMap, office, isSheet, dark, cites, citePrefix\]/, "主题变了 srcDoc 跟着变，框架按摘要换新元素");
});

test("Markdown 草稿：画布与便笺纸只作用在预览容器里（不波及问答等处的 .md），打印时去掉", () => {
  const css = src("styles-preview.css");
  assert.match(css, /\.safe-preview\.sp-md \{[^}]*background-color: var\(--preview-canvas\);[^}]*radial-gradient\(circle, var\(--preview-canvas-dot\)/);
  assert.match(css, /\.sp-md > \.md \{[^}]*background: var\(--bg-surface\);[^}]*box-shadow: var\(--preview-note-shadow\);/);
  assert.match(css, /\.sp-is-doc \.sp-frame, \.sp-is-sheet \.sp-frame \{ background: var\(--preview-canvas\); \}/);
  assert.match(css, /@media print \{\n\s*\.safe-preview\.sp-md \{ padding: 0; background: none; \}\n\s*\.sp-md > \.md \{[^}]*box-shadow: none; \}/);
  assert.doesNotMatch(css, /(^|\n)\.md \{/, "不改全局 .md");
});

test("导出与预览两条路：下载件是内核给的原文件字节，导出 PDF 用内核打印页且不印背景，都不经过预览样式", () => {
  const api = src("api.ts");
  assert.match(api, /invoke<\{ filename: string; html: string \}>\("artifacts\.print_html"/);
  assert.doesNotMatch(api, /buildPreviewDoc|PAPER_STYLE/);
  const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
  assert.match(main, /printToPDF\(\{[^}]*printBackground: false/);
  const printHtml = repo("packages/docx-engine/src/print-html.ts");
  assert.match(printHtml, /html,body\{margin:0;padding:0;color:#000;background:#fff\}/);
  assert.doesNotMatch(printHtml, /preview-canvas|radial-gradient|kwl-paper/);
});
