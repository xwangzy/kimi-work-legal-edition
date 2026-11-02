/**
 * 第 35 批：文书的交付前检查（docx.render_report 返回 quality_check）。
 * 真实走查 N1：股权转让协议第 10.1 条表格写成“著作权登记在转让方一 personal名下”；第 34 批律师验收：交付件里有“amount_yuan”
 * “返回正文为演示数据”“未经金额工具复算”。此前文书工具只核对表格格数，这些要等律师自己读出来。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx } from "@zr-legal/docx-engine";
import { checkDeliverable, cnAmountToNumber } from "../src/services/deliverable-check.ts";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

test("大写金额换算：亿、万、仟佰拾、零、角分", () => {
  assert.equal(cnAmountToNumber("人民币壹亿捌仟万元整"), 180_000_000);
  assert.equal(cnAmountToNumber("叁拾肆万伍仟元整"), 345_000);
  assert.equal(cnAmountToNumber("壹佰贰拾捌万陆仟肆佰元整"), 1_286_400);
  assert.equal(cnAmountToNumber("叁佰柒拾贰万贰仟捌佰零捌元"), 3_722_808);
  assert.equal(cnAmountToNumber("伍万零叁拾元伍角"), 50_030.5);
  assert.equal(cnAmountToNumber("不是金额"), null);
});

test("真实走查里出现过的问题逐类报出，每条有位置与改法", () => {
  const r = checkDeliverable("股权转让协议", [
    { heading: "", paragraphs: ["鉴于：转让价款为人民币180,000,000.00元（大写：人民币壹亿捌仟万元整）。"] },
    { heading: "第1条 定义", paragraphs: ["1.1 定义", "1.2 解释"] },
    { heading: "第2条 押金", paragraphs: ["2.1 押金为人民币345,000元（大写：叁拾肆万元整）。", "2.3 跳号的款"] },
    { heading: "第3条 特别赔偿", paragraphs: ["3.1 见本协议第9条和第2.5款", "3.2 核心软件登记在转让方一 personal名下", "3.3 未经金额工具复算；amount_yuan 为 100；返回正文为演示数据；经 riskcards.submit 提交"], table: { columns: ["事项"], rows: [["**加粗**"]] } },
    { heading: "第3条 重复的条号", paragraphs: ["3.1 x"] },
  ]);
  assert.equal(r.ok, false);
  const kinds = (k: string) => r.issues.filter((i) => i.kind === k).map((i) => i.text);
  assert.ok(kinds("foreign_word").some((t) => t.includes("personal")), "夹杂英文");
  for (const t of ["金额工具", "amount_yuan", "演示数据", "riskcards.submit"]) assert.ok(kinds("internal_term").includes(t), `工具用语 ${t}`);
  assert.ok(kinds("markdown").includes("**加粗**"));
  assert.ok(kinds("amount_words").some((t) => t.includes("345,000")), "大写与小写不一致");
  assert.ok(!kinds("amount_words").some((t) => t.includes("180,000,000")), "一致的不报");
  assert.ok(r.issues.some((i) => i.kind === "numbering" && /重复/.test(i.fix)), "条号重复");
  assert.ok(r.issues.some((i) => i.kind === "numbering" && /应为 2\.2/.test(i.fix)), "款号跳号");
  assert.ok(r.issues.some((i) => i.kind === "cross_ref" && /第9条/.test(i.fix)), "互引超出条数");
  assert.ok(r.issues.some((i) => i.kind === "cross_ref" && /2\.5/.test(i.fix)), "互引不存在的款");
  for (const i of r.issues) assert.ok(i.where && i.fix, "每条有位置与改法");
});

test("合法写法不误报：法律条文引用、全大写缩写、邮箱、常见外来词、连续的条款与互引", () => {
  const r = checkDeliverable("设备买卖合同", [
    { heading: "", paragraphs: ["卖方联系人：钱立峰，电子邮箱 sales_dept@delong-zb.example.com。"] },
    { heading: "第一条 标的", paragraphs: ["1.1 设备清单见附件一；通过app下单的按订单执行。", "1.2 合同总价为人民币4,860,000元（大写：肆佰捌拾陆万元整），含税。"] },
    { heading: "第二条 付款", paragraphs: ["2.1 逾期付款的，按LPR的1.5倍计付资金占用利息。", "2.2 依照《中华人民共和国民法典》第五百八十五条，违约金过高的可以请求调整；依第一条第1.2款约定的总价计算。"] },
    { heading: "第三条 争议解决", paragraphs: ["3.1 提交上海国际仲裁中心仲裁；另见《民事诉讼法》第三十四条。"] },
  ]);
  assert.deepEqual(r.issues, [], JSON.stringify(r.issues));
  assert.equal(r.ok, true);
});

test("占位计数：待填、待确认、待定分别计", () => {
  const r = checkDeliverable("协议", [{ heading: "", paragraphs: ["签署地点【待填】，日期【待填】。", "价款（来源：条款清单）【待确认】；【计息起算点待确认】", "付款期限【待定：多少日】"] }]);
  assert.deepEqual(r.placeholders, { 待填: 2, 待确认: 2, 待定: 1 });
});

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b35-dc-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("经本机端点调用文书工具：照常生成并登记，结果里带交付前检查；问题不阻断生成", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "股权转让协议起草", stance: "受让方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-02" } });
  const sheet = createDocx("交易要点", [{ heading: "价款", paragraphs: ["转让价款合计1.8亿元。"] }]);
  void sheet;
  const live = liveTaskIdentity(tk, matter.matter_id, "b35_dc");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "起草股权转让协议" }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r)}`);
    return r.result.structuredContent;
  };
  const bad = await call("docx.render_report", {
    title: "股权转让协议",
    sections: [
      { heading: "第1条 定义", paragraphs: ["1.1 “标的股权”指目标公司60%股权。"] },
      { heading: "第2条 特别赔偿", paragraphs: ["2.1 核心软件著作权登记在转让方一 personal名下的，转让方一应赔偿。", "2.2 依《中华人民共和国民法典》第一千二百八十八条处理。"] },
      { heading: "第3条 其他", paragraphs: ["3.1 未经金额工具复算。"] },
    ],
  });
  assert.match(bad.artifact_version_id, /^artv_/, "有问题照常生成并登记（检查只提示，不阻断）");
  assert.equal(bad.quality_check.ok, false);
  const kinds = bad.quality_check.issues.map((i: any) => i.kind);
  assert.ok(kinds.includes("foreign_word"));
  assert.ok(kinds.includes("internal_term"));
  assert.ok(kinds.includes("citation"), `编造的条号（民法典只有 1260 条）经法规库核验报出：${JSON.stringify(bad.quality_check.issues)}`);

  const good = await call("docx.render_report", {
    title: "股权转让协议",
    sections: [
      { heading: "第1条 定义", paragraphs: ["1.1 “标的股权”指目标公司60%股权。"] },
      { heading: "第2条 特别赔偿", paragraphs: ["2.1 核心软件著作权登记在转让方一个人名下的，转让方一应赔偿。"] },
      { heading: "第3条 其他", paragraphs: ["3.1 金额为手工计算，请复核。"] },
    ],
  });
  assert.equal(good.quality_check.ok, true, JSON.stringify(good.quality_check));

  // 附件表格（文档工程审查 E-02、E-03）：超长整数按数字传已失真——拒收并说明；未失真的长号按文字写；同名工作表去重；同样带交付前检查
  const rawCall = async (name: string, args: unknown) =>
    (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
  const lost = await rawCall("xlsx.render_table", { title: "当事人信息", sheets: [{ name: "当事人", columns: ["姓名", "身份证号"], rows: [["周牧之", 330106198203154517]] }] });
  assert.equal(lost.result?.isError, true, "超过双精度的整数到这里已经变了，不写错号");
  assert.match(JSON.stringify(lost.result.content), /超长的数字.*改成文字/);
  const ok = await call("xlsx.render_table", {
    title: "起草说明与待定事项-股权转让协议",
    sheets: [
      { name: "说明", columns: ["账号", "金额（元）", "备注"], rows: [[6222020200112233, 1200000, "未经金额工具复算"]] },
      { name: "说明", columns: ["事项"], rows: [["第二张同名表"]] },
    ],
  });
  assert.equal(ok.sheets, 2);
  assert.ok(ok.quality_check.issues.some((i: any) => i.kind === "internal_term" && i.text === "金额工具"), "附件里的工具用语同样报出");
  const art = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [ok.artifact_version_id])!;
  const { readZipEntries } = await import("@zr-legal/docx-engine");
  const z = readZipEntries(tk.kernel.blobs.read(art.storage_uri));
  const wb = z.get("xl/workbook.xml")!.toString("utf8");
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, 2, `工作表名不重复：${names.join("、")}`);
  const all = [...z.entries()].filter(([n]) => /^xl\/(sharedStrings|worksheets\/sheet1)\.xml$/.test(n)).map(([, d]) => d.toString("utf8")).join("");
  assert.match(all, /6222020200112233/, "16 位账号按文字原样写入");
  assert.doesNotMatch(all, /<v>6222020200112233<\/v>/, "不按数字写（Excel 只保留 15 位有效数字）");
});

test("当事人文书（合同、协议）：正文里的内部说明与签署页之后的条款报出；意见书里同样的词不报（第 35 批真实走查 R1）", () => {
  const sections = [
    { heading: "第1条 定义", paragraphs: ["1.1 定义。", "1.2 解释。"] },
    { heading: "第20条 其他", paragraphs: ["20.6 本协议一式捌份。", "20.7 本协议中材料未明确约定的期限均为我方首稿方案，待客户确认。"] },
    { heading: "", paragraphs: ["（以下无正文，为签署页）", "受让方：上海澄远科技集团有限公司（盖章）"] },
    { heading: "附件", paragraphs: ["附件一 披露函", "1.1 披露事项一（附件自己的编号，不报）", "20.8 本协议自各方签署之日起生效。"] },
  ];
  const r = checkDeliverable("股权转让协议", sections);
  const internal = r.issues.filter((i) => i.kind === "internal_term");
  assert.equal(internal.length, 1, `同一段只报一次：${JSON.stringify(internal)}`);
  assert.match(internal[0]!.text, /材料未明确约定/);
  assert.equal(internal[0]!.where, "第20条 其他第 2 段");
  assert.ok(r.issues.some((i) => i.kind === "numbering" && i.text.startsWith("20.8") && /签署页之后/.test(i.fix)), JSON.stringify(r.issues));
  const opinion = checkDeliverable("关于方景行事项的法律意见书", [{ heading: "四、假设", paragraphs: ["本意见书所述事实待客户确认。"] }]);
  assert.equal(opinion.issues.filter((i) => i.kind === "internal_term").length, 0, "律所文书不按合同口径查");
  const clean = checkDeliverable("设备买卖合同", [{ heading: "第1条 标的", paragraphs: ["1.1 设备见附件一。"] }, { heading: "", paragraphs: ["（以下无正文，为签署页）", "甲方（盖章）："] }, { heading: "附件一 设备清单", paragraphs: ["1. 五轴加工中心", "2.1 主机（附件自己的编号）"] }]);
  assert.equal(clean.issues.length, 0, JSON.stringify(clean.issues));
});
