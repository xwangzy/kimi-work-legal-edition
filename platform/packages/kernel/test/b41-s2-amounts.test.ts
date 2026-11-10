/**
 * V16 第 41 批真实走查 E1（幕墙分包欠款，整理案卷·本机流程，独立评分 12/24）：
 * - 结算书是表格，“结算总价（小写）｜9,135,420.00”“结算总价（大写）｜人民币玖佰壹拾叁万伍仟贰佰肆拾元整”各占一行：
 *   小写没带“元”摘不出来、两行不挨着，不一致没查出，补证清单却写“本机规则没有发现大写与小写金额不一致”；
 * - 2023-08-10 那笔付款，我方台账、会议纪要写 500,000 元，对方回函写 600,000 元，没有任何提示。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractParagraphs, readZipEntries } from "@zr-legal/docx-engine";
import { buildS2Deliverables, extractFacts } from "../src/executor/casefile.ts";

const mat = (id: string, filename: string, text: string) => ({ document_version_id: id, parse_version_id: `p${id}`, filename, sha256: "0".repeat(64), chars: text.length, quality_flags: [], text });
const build = (materials: ReturnType<typeof mat>[]) => buildS2Deliverables({ runId: "run_b41", matter: { title: "示例", client_name: null, counterparty: null, stance: "原告" }, materials, issues: [] });
const supplement = (b: ReturnType<typeof build>) => extractParagraphs(Buffer.from(b.files.find((x) => x.filename.startsWith("补证清单"))!.bytes)).map((p) => p.text).join("\n");

const SETTLEMENT = "澄岸广场二期幕墙专业分包工程结算书\n| 结算总价（小写） | 9,135,420.00 |\n| 结算总价（大写） | 人民币玖佰壹拾叁万伍仟贰佰肆拾元整 |\n说明：质量保证金按结算总价的5%预留。";

test("表格里分两行标注的大写与小写金额：小写没写“元”也摘得出，对不上时两条都标不一致并进补证清单", () => {
  const facts = extractFacts({ document_version_id: "d2", parse_version_id: "p2", filename: "02-结算书.docx", text: SETTLEMENT });
  const amounts = facts.filter((f) => f.kind === "amount");
  assert.deepEqual(amounts.map((f) => f.normalized).sort(), ["9135240 元", "9135420 元"]);
  for (const f of amounts) assert.match(f.conflict ?? "", /“结算总价”的大写.*9135240 元.*与小写“9,135,420\.00”（9135420 元）不一致/);
  const text = supplement(build([mat("d2", "02-结算书.docx", SETTLEMENT)]));
  assert.match(text, /《02-结算书\.docx》.*“结算总价”的大写.*不一致/);
  assert.equal(text.includes("没有比出不一致"), false);
});

test("大写、小写相符的不报；名目不同的两行不配对；没有标“大写 / 小写”的表格数字不当金额摘", () => {
  const ok = "| 合同价（小写） | 8,600,000.00 |\n| 合同价（大写） | 人民币捌佰陆拾万元整 |";
  assert.equal(extractFacts({ document_version_id: "d", parse_version_id: "p", filename: "a.docx", text: ok }).some((f) => f.conflict), false);
  const other = "| 合同价（小写） | 8,600,000.00 |\n| 结算价（大写） | 人民币玖佰壹拾叁万伍仟贰佰肆拾元整 |";
  assert.equal(extractFacts({ document_version_id: "d", parse_version_id: "p", filename: "a.docx", text: other }).some((f) => f.conflict), false, "名目不同不比");
  const plain = "| 工程量 | 12,500.00 |\n| 面积 | 8600 |";
  assert.equal(extractFacts({ document_version_id: "d", parse_version_id: "p", filename: "a.docx", text: plain }).filter((f) => f.kind === "amount").length, 0);
  // 紧挨着写的一对照旧（V14）
  const inline = "尚欠货款人民币肆拾伍万伍仟元整（¥445,000.00）。";
  assert.equal(extractFacts({ document_version_id: "d", parse_version_id: "p", filename: "a.docx", text: inline }).filter((f) => f.conflict).length, 2);
});

test("不同材料对同一天的付款写了不同金额：列出各自的出处请律师核对；同一份材料同一天写了两个金额的（两笔）不报", () => {
  const b = build([
    mat("d3", "03-收款台账.txt", "2023年8月10日收到进度款500,000元。"),
    mat("d7", "07-对方回复函.docx", "我司已于2023年8月10日向贵司支付工程款600,000元。"),
    mat("d8", "08-会议纪要.docx", "双方确认：2023年8月10日付款500,000元；2023年9月1日付款300,000元。"),
    mat("d9", "09-情况说明.docx", "2023年9月1日对方支付300,000元，同日另付100,000元。"),
  ]);
  const text = supplement(b);
  assert.match(text, /2023-08-10 的付款，各份材料写的金额不一样/);
  assert.match(text, /《03-收款台账\.txt》、《08-会议纪要\.docx》写 500,000 元；《07-对方回复函\.docx》写 600,000 元/);
  assert.match(text, /可能是同一笔，请对照银行回单或收款凭证核对/);
  assert.equal(/2023-09-01 的付款/.test(text), false, "09 号材料自己写了 300,000 与 100,000 两笔，不当成矛盾");
});

test("两类都没有比出不一致时：写清只比了哪两类、不等于没有矛盾，不再说“没有发现大写与小写金额不一致”", () => {
  const text = supplement(build([mat("d1", "01-合同.docx", "本合同于2025年9月12日签订。买方应于验收后30日内支付验收款810,000元。")]));
  assert.match(text, /本机规则只比对两类/);
  assert.match(text, /不等于材料之间没有矛盾/);
});

test("一方自己的情况说明标“一方陈述”；材料里提到还没提供的文件进待补材料", () => {
  const b = build([
    mat("d9", "09-项目负责人情况说明（我方）.docx", "工程于2023年6月30日通过竣工验收。2023年8月10日那笔的银行回单原件在财务部，尚未提供给律师。"),
    mat("d1", "01-分包合同.docx", "本合同于2022年3月25日签订。"),
  ]);

  const timeline = [...readZipEntries(Buffer.from(b.files.find((x) => x.filename.startsWith("事实时间轴"))!.bytes)).entries()].filter(([k]) => /\.xml$/.test(k)).map(([, v]) => v.toString("utf8")).join("\n");
  assert.match(timeline, /一方陈述，待其他材料印证/);
  assert.match(timeline, /材料记/);
  const text = supplement(b);
  assert.match(text, /《09-项目负责人情况说明（我方）\.docx》提到：“2023年8月10日那笔的银行回单原件在财务部，尚未提供给律师。”——请向委托人调取/);
  assert.equal(text.includes("（由律师按争点矩阵缺口补充）"), false);
});
