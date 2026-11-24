/**
 * 第 62 批：安装包里 Word 预览空白（成果区认得文档与版本、右侧预览一片空白）。
 * 根因：sandbox="" 的 srcdoc 隔离框架由独立渲染进程承载，插入后首次导航提交前再改 srcdoc，该框架永久不出图；
 * 安装包里内核走 IPC，代号表与引用角标在 HTML 到达后几毫秒内就到，srcDoc 连变两三次，正好落进这个窗口。
 * 证据：已安装正式包（0.2.0）经调试端口查到框架文档已完整载入（正文、纸面样式），父页面合成却空白；同一 srcdoc 换新元素立即显示；
 * Electron 44.5.1 最小复现：原地改 srcdoc（间隔 0～50 毫秒）0 像素、换新元素每次都出图（研究记录 V36 evidence/preview-blank）。
 * 修复：框架以内容摘要为 key，内容一变就换新元素、绝不原地改 srcdoc；另给“重新载入预览”与生成失败的原因与重试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { previewFrameKey } from "../src/lib/safe-preview.ts";

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

test("框架身份：同内容同 key（刷新不重挂、不闪烁），内容哪怕差一个字也换新框架", () => {
  const a = "<!doctype html><html><body><p>民事起诉状</p></body></html>";
  assert.equal(previewFrameKey(a), previewFrameKey(String(a)));
  assert.notEqual(previewFrameKey(a), previewFrameKey(a.replace("起诉状", "答辩状")));
  assert.notEqual(previewFrameKey(a), previewFrameKey(a + " "));
  assert.match(previewFrameKey(""), /^[0-9a-f]{8}-0$/);
});

test("隔离框架必须按内容摘要换新元素：iframe 带 key（摘要 + 人工重载次数），不在同一元素上改 srcdoc", () => {
  const sp = src("components/SafePreview.tsx");
  const iframes = sp.match(/<iframe\b[^>]*>/g) ?? [];
  assert.equal(iframes.length, 1, "SafePreview 只有一个隔离框架");
  assert.match(iframes[0]!, /\bkey=\{`\$\{frameKey\}:\$\{reloads\}`\}/, "框架必须以内容摘要为 key");
  assert.match(iframes[0]!, /sandbox=""/, "隔离不放松：仍是 sandbox=\"\"");
  assert.match(sp, /previewFrameKey\(srcDoc\)/);
  assert.match(sp, /重新载入预览/);
  // 其他页面不得绕过 SafePreview 自己放 srcdoc 框架
  for (const f of ["pages/RunView.tsx", "pages/Review.tsx", "components/ReviewWorkbench.tsx"]) assert.doesNotMatch(src(f), /srcDoc=|srcdoc=/i, `${f} 不得自建 srcdoc 框架`);
});

test("任务页右栏：预览记着属于哪个成果版本，切换时显示“正在生成预览”，失败给原因与重试（不再误报“不能预览”）", () => {
  const rv = src("pages/RunView.tsx");
  assert.match(rv, /preview\?\.id === selected && <SafePreview/);
  assert.match(rv, /<PreviewError message=\{previewErr\.message\} onRetry=/);
  assert.match(rv, /正在生成预览/);
  assert.doesNotMatch(rv, /\.catch\(\(\) => setPreview\(\{ filename: a\.filename, text: "" \}\)\)/, "Office 渲染失败不得再当成不能预览");
  const review = src("pages/Review.tsx");
  assert.match(review, /preview\.error \? \(\s*<PreviewError/);
});
