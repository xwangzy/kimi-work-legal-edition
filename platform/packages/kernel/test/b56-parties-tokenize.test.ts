/**
 * D-224 / D-231 当事人信息材料的令牌化与还原核对（包括括号楼栋）：
 * 律师填写的《当事人信息（律师填写）.txt》经现有令牌化后（与 A1 材料快照同一个内核侧令牌化器），发往模型的形态里没有
 * 信用代码、身份证号、电话、自然人姓名、出生日期与住址门牌这些真值；机构名称在一般事项里按设计原文发出，住址的省市区保留原文。
 * 模型按代号写出的文书段落，经 export-restore 导出还原后真值回到 Word 里。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipText } from "@zr-legal/docx-engine";
import { findTokens } from "@zr-legal/tokenizer";
import { MatterTokenStore } from "../src/egress/matter-tokens.ts";
import { restoreArtifactBytes } from "../src/services/export-restore.ts";
import { importText, makeKernel, type TestKernel } from "./helpers.ts";

// 与界面 apps/desktop/src/lib/parties.ts serializeParties 的输出同一格式（号码与地址已去掉中间空格）
const TEXT = [
  "【当事人信息（律师填写）】本文件由承办律师填写，文书首部的当事人身份事项以此为准。",
  "",
  "一、我方（原告）：华诚贸易有限公司（单位）",
  "统一社会信用代码：91310115MA1H7K2X3Q",
  "住所：上海市浦东新区张江路1288号（3幢）501室",
  "法定代表人：王建国，职务：执行董事",
  "联系电话：021-58881234",
  "",
  "二、对方（被告）：李秀英（自然人）",
  "性别：女",
  "出生日期：1985年3月2日",
  "身份证号：110105198503021241",
  "住址：北京市朝阳区建国路88号院(2号楼)1203室",
  "联系电话：13912345678",
  "",
].join("\n");

// 第 58 批（D-240）：住址只有道路门牌是真值（门牌之后的楼栋室号保留原文、不指向任何人）
const SECRETS = ["91310115MA1H7K2X3Q", "张江路1288号", "王建国", "021-58881234", "李秀英", "1985年3月2日", "110105198503021241", "建国路88号院", "13912345678"];

let tk: TestKernel | null = null;
after(async () => {
  await tk?.kernel.close();
});

test("当事人信息材料：发往模型的形态不含身份真值；机构名与省市区按设计原文；导出 Word 时还原", async () => {
  tk = await makeKernel({}, "b56-parties-tokenize-firm");
  // 一般事项（非敏感、未开全部化名）：客户是单位，相对方是自然人（事项头名称进当事人词典）
  const { matter } = await tk.inv("matters.create", { title: "华诚公司诉李秀英买卖合同纠纷", client_name: "华诚贸易有限公司", counterparty: "李秀英", stance: "原告", consent_status: "not_required" });
  const mid = matter.matter_id;
  const doc = await importText(tk.inv, mid, "当事人信息（律师填写）.txt", TEXT);
  assert.ok(doc.document_version_id);

  const store = new MatterTokenStore(tk.kernel.db);
  const oldAddress = "张江路1288号";
  const before = store.tokenize(mid, `住所：上海市浦东新区${oldAddress}`).text;
  const sent = store.tokenize(mid, TEXT).text;
  for (const s of SECRETS) assert.equal(sent.includes(s), false, `真值原文发出：${s}\n${sent}`);
  // 现状如实断言：机构名称在一般事项里原文发出；住址只换行政区划之后的部分
  assert.ok(sent.includes("一、我方（原告）：华诚贸易有限公司（单位）"), sent);
  assert.match(sent, /^住所：上海市浦东新区〔地址·[0-9A-Z]{6}〕（3幢）501室$/m);
  assert.match(sent, /^住址：北京市朝阳区〔地址·[0-9A-Z]{6}〕\(2号楼\)1203室$/m);
  assert.equal(store.restore(mid, before).text, `住所：上海市浦东新区${oldAddress}`, "已有成果中的旧地址代号照常还原");
  // 不是号码的事项原样（性别、职务）
  assert.ok(sent.includes("性别：女") && sent.includes("职务：执行董事"), sent);
  const cats = new Set(findTokens(sent).map((t) => t.slice(1, t.indexOf("·"))));
  for (const c of ["信用代码", "地址", "自然人", "电话", "出生日期", "证件号"]) assert.ok(cats.has(c), `应有${c}代号：${[...cats].join("、")}`);

  // 模型按代号写出的首部段落（照抄材料里的代号）→ Word 草稿（库里是代号形态）→ 导出还原
  const line = (prefix: string) => sent.split("\n").find((l) => l.startsWith(prefix))!.slice(prefix.length);
  const ours = sent.split("\n").slice(0, 8).filter((l) => l.startsWith("统一社会信用代码") || l.startsWith("住所") || l.startsWith("法定代表人") || l.startsWith("联系电话"));
  const plaintiff = `原告：华诚贸易有限公司，${ours.join("，")}。`;
  const defendant = `被告：${line("二、对方（被告）：").replace("（自然人）", "")}，女，${line("出生日期：")}出生，公民身份号码${line("身份证号：")}，住${line("住址：")}，联系电话${sent.split("\n").filter((l) => l.startsWith("联系电话："))[1]!.slice(5)}。`;
  assert.equal(findTokens(plaintiff + defendant).some((t) => !store.table(mid).some((e) => e.token === t)), false, "段落里的代号都在本事项令牌表里");
  const docx = createDocx("民事起诉状", [{ heading: "", paragraphs: [plaintiff, defendant] }]);
  const out = restoreArtifactBytes("民事起诉状（草稿）.docx", docx, (t) => store.restore(mid, t));
  assert.deepEqual(out.unresolved, []);
  assert.ok(out.restored >= 8, `还原次数 ${out.restored}`);
  const text = (readZipText(out.bytes, "word/document.xml") ?? "").replace(/<[^>]+>/g, "");
  assert.equal(findTokens(text).length, 0, text);
  for (const s of SECRETS) assert.ok(text.includes(s), `导出后应有真值：${s}\n${text}`);
  assert.ok(text.includes("原告：华诚贸易有限公司，统一社会信用代码：91310115MA1H7K2X3Q，住所：上海市浦东新区张江路1288号（3幢）501室，法定代表人：王建国，职务：执行董事，联系电话：021-58881234。"), text);
  assert.ok(text.includes("被告：李秀英，女，1985年3月2日出生，公民身份号码110105198503021241，住北京市朝阳区建国路88号院(2号楼)1203室，联系电话13912345678。"), text);
});

// 第 64 批：新格式（民族、委托诉讼代理人、末尾按各项生成的“文书首部写法”）。与界面 serializeParties 的输出逐字相同
// （apps/desktop/test/b56-parties.test.ts“内核令牌化用例的新格式样例”逐字核对）
const TEXT_B64 = [
  "【当事人信息（律师填写）】本文件由承办律师填写，文书首部的当事人身份事项以此为准。",
  "",
  "一、我方（原告）：王超（自然人）",
  "性别：男",
  "民族：汉族",
  "出生日期：1966年2月5日",
  "公民身份号码：110105196602051234",
  "住址：北京市朝阳区建国路88号院(2号楼)1203室",
  "联系电话：13912345678",
  "委托诉讼代理人一：张明远（律师）",
  "执业机构：北京某某律师事务所",
  "联系电话：13800001111",
  "授权范围：特别授权（代为承认、放弃、变更诉讼请求，进行和解，提起反诉、上诉）",
  "",
  "二、对方（被告）：上海某某有限公司（法人）",
  "统一社会信用代码：91310115MA1H7K2X3Q",
  "住所：上海市浦东新区张江路1288号3幢501室",
  "法定代表人：李建国，职务：执行董事",
  "联系电话：021-58881234",
  "",
  "——以下为文书首部写法（按上面各项自动生成，照抄即可）——",
  "原告：王超，男，汉族，1966年2月5日出生，公民身份号码110105196602051234，住北京市朝阳区建国路88号院(2号楼)1203室，联系电话13912345678。",
  "委托诉讼代理人：张明远，北京某某律师事务所律师，联系电话13800001111。",
  "被告：上海某某有限公司，统一社会信用代码91310115MA1H7K2X3Q，住所上海市浦东新区张江路1288号3幢501室，联系电话021-58881234。",
  "法定代表人：李建国，执行董事。",
  "",
].join("\n");
const SECRETS_B64 = ["王超", "1966年2月5日", "110105196602051234", "建国路88号院", "13912345678", "张明远", "13800001111", "91310115MA1H7K2X3Q", "张江路1288号", "李建国", "021-58881234"];

test("第 64 批 当事人信息新格式：代理人姓名与电话、首部写法里的身份真值都换成代号；模型照抄首部写法，导出 Word 时逐字还原", async () => {
  tk ??= await makeKernel({}, "b56-parties-tokenize-firm");
  const { matter } = await tk.inv("matters.create", { title: "王超诉上海某某公司买卖合同纠纷", client_name: "王超", counterparty: "上海某某有限公司", stance: "原告", consent_status: "not_required" });
  const mid = matter.matter_id;
  await importText(tk.inv, mid, "当事人信息（律师填写）.txt", TEXT_B64);
  // 界面保存时把代理人登记进当事人词典（称谓是自由文字“委托诉讼代理人”）
  await tk.inv("matters.parties.upsert", { matter_id: mid, name: "张明远", kind: "person", aliases: [], role: "委托诉讼代理人" });
  assert.ok((await tk.inv("matters.parties.list", { matter_id: mid })).parties.some((p: { name: string; role: string | null }) => p.name === "张明远" && p.role === "委托诉讼代理人"));

  const store = new MatterTokenStore(tk.kernel.db);
  const sent = store.tokenize(mid, TEXT_B64).text;
  for (const s of SECRETS_B64) assert.equal(sent.includes(s), false, `真值原文发出：${s}\n${sent}`);
  // 律所名称、民族、授权范围按设计原文
  assert.ok(sent.includes("执业机构：北京某某律师事务所") && sent.includes("民族：汉族") && sent.includes("授权范围：特别授权（代为承认、放弃、变更诉讼请求，进行和解，提起反诉、上诉）"), sent);
  // 同一真值在各方各项与首部写法里是同一个代号（照抄不会出现对不上的代号）
  const lines = sent.split("\n");
  const agentTok = /^委托诉讼代理人一：(〔自然人·[0-9A-Z]{6}〕)（律师）$/m.exec(sent)?.[1];
  assert.ok(agentTok, sent);
  assert.ok(sent.includes(`委托诉讼代理人：${agentTok}，北京某某律师事务所律师，联系电话〔电话·`), sent);

  // 模型照抄首部写法（代号形态）→ Word 草稿 → 导出还原：首部逐字回到律师填写的真值
  const head = lines.slice(lines.indexOf("——以下为文书首部写法（按上面各项自动生成，照抄即可）——") + 1).filter(Boolean);
  assert.equal(head.length, 4);
  assert.equal(findTokens(head.join("")).some((t) => !store.table(mid).some((e) => e.token === t)), false, "首部写法里的代号都在本事项令牌表里");
  const docx = createDocx("民事起诉状", [{ heading: "", paragraphs: head }]);
  const out = restoreArtifactBytes("民事起诉状（草稿）.docx", docx, (t) => store.restore(mid, t));
  assert.deepEqual(out.unresolved, []);
  const text = (readZipText(out.bytes, "word/document.xml") ?? "").replace(/<[^>]+>/g, "");
  assert.equal(findTokens(text).length, 0, text);
  const want = TEXT_B64.split("\n").slice(-5, -1);
  for (const l of want) assert.ok(text.includes(l), `导出后应有：${l}\n${text}`);
});
