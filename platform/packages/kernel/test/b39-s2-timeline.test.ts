/**
 * V14 第 39 批真实走查（L1 整理案卷，本机确定性流程）：《事实时间轴》的“事件/金额”一栏只写日期本身（“2025年9月12日｜日期”），
 * 同一日期在一份材料里出现几次就列几行，看不出那天发生了什么；《案卷总目录》《证据目录》按勾选先后倒序（08 在前、01 在后）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readZipEntries } from "@zr-legal/docx-engine";
import { buildS2Deliverables } from "../src/executor/casefile.ts";

const mat = (id: string, filename: string, text: string) => ({ document_version_id: id, parse_version_id: `p${id}`, filename, sha256: "0".repeat(64), chars: text.length, quality_flags: [], text });
const built = buildS2Deliverables({
  runId: "run_b39",
  matter: { title: "示例", client_name: null, counterparty: null, stance: "原告" },
  // 勾选顺序是倒序的（界面材料列表新的在上）
  materials: [
    mat("d3", "10-催款函.docx", "我方于2026年8月18日发出催款函，要求禾丰于2026年8月31日前付清。"),
    mat("d2", "02-验收单.docx", "设备于2025年11月3日安装调试完毕并经验收。"),
    mat("d1", "01-合同.docx", "本合同于2025年9月12日签订。买方应于验收后30日内支付验收款810,000元。签订日期：2025年9月12日。"),
  ],
  issues: [],
});
const sheetText = (name: string) => {
  const f = built.files.find((x) => x.filename.startsWith(name))!;
  return [...readZipEntries(f.bytes).entries()].filter(([k]) => /\.xml$/.test(k)).map(([, v]) => v.toString("utf8")).join("\n");
};

test("时间轴的“事件”是日期所在的那句话，不是日期本身", () => {
  const t = sheetText("事实时间轴");
  assert.match(t, /事件（所在原句）/);
  assert.match(t, /设备于2025年11月3日安装调试完毕并经验收。/);
  assert.match(t, /我方于2026年8月18日发出催款函/);
});

test("同一份材料同一句里的同一日期只列一次；不同句子各列一行", () => {
  const t = sheetText("事实时间轴");
  assert.equal((t.match(/本合同于2025年9月12日签订。/g) ?? []).length, 1);
  assert.equal((t.match(/签订日期：2025年9月12日。/g) ?? []).length, 1);
});

test("案卷总目录与证据目录按文件名编号排列（01、02、10），不按勾选先后", () => {
  for (const name of ["案卷总目录", "证据目录"]) {
    const t = sheetText(name);
    const i1 = t.indexOf("01-合同.docx"), i2 = t.indexOf("02-验收单.docx"), i10 = t.indexOf("10-催款函.docx");
    assert.ok(i1 >= 0 && i1 < i2 && i2 < i10, `${name} 顺序不对`);
  }
});

test("只有货币符号的小写金额摘得出；大写与小写对不上的列进补证清单（催款函：大写 455,000、小写 ¥445,000）", () => {
  const b = buildS2Deliverables({
    runId: "run_b39b",
    matter: { title: "示例", client_name: null, counterparty: null, stance: "原告" },
    materials: [
      mat("e1", "06-催款函.docx", "贵司已于2025年12月26日付款200,000元。截至本函发出之日，贵司尚欠我司货款人民币肆拾伍万伍仟元整（¥445,000.00）。"),
      mat("e2", "01-合同.docx", "合同总价人民币壹佰贰拾万元整（¥1,200,000.00）。"),
    ],
    issues: [],
  });
  const text = (name: string) => [...readZipEntries(b.files.find((x) => x.filename.startsWith(name))!.bytes).entries()].filter(([k]) => /\.xml$/.test(k)).map(([, v]) => v.toString("utf8")).join("\n");
  const tl = text("事实时间轴");
  // 时间轴一句一行：这句只列一行，写明大小写对不上
  assert.match(tl, /金额：455000 元（大写“人民币肆拾伍万伍仟元整”（455000 元）与小写“¥445,000\.00”（445000 元）不一致，见补证清单）/);
  const sup = text("补证清单").replace(/<[^>]+>/g, "");
  assert.match(sup, /《06-催款函\.docx》第 \d+–\d+ 字：大写“人民币肆拾伍万伍仟元整”（455000 元）与小写“¥445,000\.00”（445000 元）不一致/);
  assert.equal(/01-合同\.docx》第/.test(sup), false, "一致的大小写不报");
  assert.equal(/200000 元/.test(sup), false, "前一句的付款额不与下一句的大写配对（复测误报）");
  assert.equal(b.factsCount.amounts, 4, "合同的大小写合并为一条，催款函三条");
});
