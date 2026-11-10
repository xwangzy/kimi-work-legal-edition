/**
 * V16 第 41 批：最终答复里的本机路径链接。真实任务的答复里有“[管辖与时效核查表.xlsx](sandbox:/private/tmp/…/outputs/管辖与时效核查表.xlsx)”，
 * 律师点不开，还露出本机目录。登记最终答复前换成“《文件名》（见本任务的成果）”；网址不动。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubLocalPaths } from "../src/services/reply-local-paths.ts";

test("Markdown 链接指向本机：保留显示文字，换成《文件名》", () => {
  assert.equal(scrubLocalPaths("下载：[管辖与时效核查表.xlsx](sandbox:/private/tmp/kw/abc/outputs/管辖与时效核查表.xlsx)。"), "下载：《管辖与时效核查表.xlsx》（见本任务的成果）。");
  assert.equal(scrubLocalPaths("[《答辩书》](sandbox:/mnt/data/答辩书.docx)"), "《答辩书》（见本任务的成果）");
  // 显示文字不是文件名：保留显示文字，补上文件名（file: 网址里的中文按编码还原）
  assert.equal(scrubLocalPaths("[点击下载](file:///Users/a/%E6%8A%A5%E5%91%8A.docx)"), "点击下载（《报告.docx》，见本任务的成果）");
  assert.equal(scrubLocalPaths("![图](/private/tmp/x/图.png)"), "《图》（见本任务的成果）");
});

test("正文里直接写出的本机路径：sandbox:、/private/、/Users/、/tmp/、盘符路径都换成文件名；反引号一并去掉", () => {
  assert.equal(scrubLocalPaths("见 sandbox:/private/tmp/x/outputs/答辩书.docx，请核对"), "见 《答辩书.docx》（见本任务的成果），请核对");
  assert.equal(scrubLocalPaths("文件在 `/Users/wang/Library/x/起诉状.docx` 里"), "文件在 《起诉状.docx》（见本任务的成果） 里");
  assert.equal(scrubLocalPaths("另见 /tmp/a/b.xlsx 和 C:\\Users\\a\\报告.docx。"), "另见 《b.xlsx》（见本任务的成果） 和 《报告.docx》（见本任务的成果）。");
  assert.equal(scrubLocalPaths("在 /private/tmp/kw/outputs/ 目录下"), "在 本任务的成果 目录下");
  const out = scrubLocalPaths("x sandbox:/private/var/folders/ab/T/outputs/核查表.xlsx y");
  assert.equal(/private|sandbox|folders/.test(out), false, out);
});

test("网址与普通文字不动", () => {
  const t = "参见 https://flk.npc.gov.cn/Users/detail 与 [法规](https://x.cn/a)；第 1/2 页；比例 3/4；《民法典》第 577 条。";
  assert.equal(scrubLocalPaths(t), t);
  assert.equal(scrubLocalPaths("没有路径的答复。"), "没有路径的答复。");
});
