/**
 * 交付件按内容命名（UIUX 增量评审 D-2）：取第一个非空行、去掉 Markdown 符号、至多 40 字；代号原样保留（界面还原）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstLineTitle, isTitledFilename } from "../src/services/artifact-title.ts";

test("成果标题：第一个非空行、去标题与强调符号、40 字截断、代号原样；非文本文件不取", () => {
  assert.equal(firstLineTitle(Buffer.from("\n\n## **研究备忘**：〔自然人·ABC123〕借款纠纷\n正文")), "研究备忘：〔自然人·ABC123〕借款纠纷");
  assert.equal(firstLineTitle(Buffer.from("- `要点` 一")), "要点 一");
  assert.equal([...firstLineTitle(Buffer.from("甲".repeat(100)))!].length, 40);
  assert.equal(firstLineTitle(Buffer.from("   \n\n")), null);
  assert.ok(isTitledFilename("agent草稿-1.md") && isTitledFilename("说明.TXT"));
  assert.ok(!isTitledFilename("修订稿.docx") && !isTitledFilename("表.xlsx"));
});

test("截断不切开代号（复核 S6B-14）", async () => {
  const { cutKeepingTokens } = await import("../src/services/artifact-title.ts");
  const s = "甲".repeat(36) + "〔自然人·ABC123〕";
  assert.equal(cutKeepingTokens(s, 40), "甲".repeat(36));
  assert.equal(cutKeepingTokens("短标题", 40), "短标题");
});
