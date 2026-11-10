/**
 * V16 第 41 批：工作流与质量门禁的四处修复（卡片—方法盘点 03 与 V14 已证实未修问题）。
 * - 独立复核逐条核对“律师在任务中的答复”是否落实（V14 I1-C：律师选“先发最后催告”，函件仍写“已有权主张解除”，复核没有发现）；
 * - 律师函、催告函、解除通知按“函件”复核，案件进展汇报按“汇报”复核；补上此前不经复核的诉讼文书与意见类方法；
 * - 主交付物核对：只交了附件类 Word（起草说明、签署页、核对清单……）不算交出主文书；
 * - 审查要点的“不可谈”须有范本原句为证（V14 I1-B：属性栏为“—”的条款被写成不可谈）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { REVIEW_KIND_OF_SKILL, reviewMessages } from "../src/services/independent-review.ts";
import { primaryDeliverableMissing } from "../src/executor/executor.ts";
import { checkRedLineSources } from "../src/tools/tools/review.ts";
import { findTool } from "../src/tools/registry.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b41-firm");
});
after(async () => {
  await tk.kernel.close();
});

const base = { stance: "买方", jurisdiction: "中国大陆", asOf: "2026-11-10", goal: "就对方逾期交货起草函件", materials: [{ filename: "供货合同.txt", text: "8.1 逾期交货超过30日，经书面催告后15日内仍未交付的，买方有权解除。" }], docs: [{ filename: "催告函.docx", text: "我司已有权主张解除合同。" }] };

test("独立复核：有律师答复时先逐条核对是否落实，相反或只落实一半的列为必须改", () => {
  const withAnswers = reviewMessages({ ...base, kind: "letter", answers: ["问：走哪条路径？　答：先发书面催告，给 15 日，期满未交付再解除"] });
  const user = withAnswers.find((m) => m.role === "user")!.content;
  assert.match(user, /【律师在任务中的答复】/);
  assert.match(user, /先发书面催告，给 15 日/);
  assert.match(user, /【先做这一步】逐条核对上面每一项答复是否落实/);
  assert.match(user, /与答复相反、只落实了一半、按另一个选项写/);
  assert.match(user, /列为“必须改”/);
  // 答复排在复核方法之前：先核对答复，再做其余各项
  assert.ok(user.indexOf("【先做这一步】") < user.indexOf("【复核方法】"));
  // 没有答复时不出现这一步（不给复核人制造空任务）
  const without = reviewMessages({ ...base, kind: "letter" }).find((m) => m.role === "user")!.content;
  assert.equal(without.includes("【先做这一步】"), false);
});

test("独立复核：函件与汇报有各自的复核清单", () => {
  const letter = reviewMessages({ ...base, kind: "letter" });
  assert.match(letter.find((m) => m.role === "system")!.content, /律师函、催告函或通知/);
  const lu = letter.find((m) => m.role === "user")!.content;
  assert.match(lu, /函件类型与法律效果/);
  assert.match(lu, /权利是否已经产生/);
  assert.equal(lu.includes("诉讼请求、金额与材料逐项对照"), false, "函件不再套诉讼文书的清单");
  const report = reviewMessages({ ...base, kind: "report" });
  assert.match(report.find((m) => m.role === "system")!.content, /案件进展汇报/);
  assert.match(report.find((m) => m.role === "user")!.content, /答辩期、举证期、上诉期/);
});

test("独立复核覆盖面：律师函按函件；补上代理词、质证意见、保全与执行申请、制度审查、劳动应对方案、尽调报告、进展汇报", () => {
  assert.equal(REVIEW_KIND_OF_SKILL["demand-letter"], "letter");
  for (const s of ["agency-statement", "cross-exam-opinion", "preservation-application", "enforcement-application"]) assert.equal(REVIEW_KIND_OF_SKILL[s], "pleading", s);
  for (const s of ["policy-review", "labor-dispute", "due-diligence"]) assert.equal(REVIEW_KIND_OF_SKILL[s], "opinion", s);
  assert.equal(REVIEW_KIND_OF_SKILL["case-report"], "report");
  // 原有的不变
  assert.equal(REVIEW_KIND_OF_SKILL["contract-draft"], "draft");
  assert.equal(REVIEW_KIND_OF_SKILL["doc-revise"], "revise");
  // V16 第 41 批回归评分二：表格类与整理审查要点也复核（见 b41-review-coverage）；表格审阅（逐格回填工作台的表）仍不复核
  for (const s of ["amount-calc", "casefile-organize", "citation-check"]) assert.equal(REVIEW_KIND_OF_SKILL[s], "table", s);
  assert.equal(REVIEW_KIND_OF_SKILL["review-rules-draft"], "rules");
  assert.equal(REVIEW_KIND_OF_SKILL["tabular-review"], undefined);
});

test("主交付物核对：只交了附件类 Word 不算交出主文书；主文书在、或主交付物本身就是说明类的不报", async () => {
  const { matter } = await tk.inv("matters.create", { title: "核对主交付物 V16", stance: "买方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-10" } });
  const db = tk.kernel.db;
  const fresh = (label: string) => liveTaskIdentity(tk, matter.matter_id, label);
  let ver = 0;
  const art = (live: { tid: string; rid: string; uid: string }, kind: string, filename: string) =>
    db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by) VALUES (?,?,?,?,?,?,'internal','draft',?,?,?,'[]','{}',?)`,
      [`art_${Math.random().toString(36).slice(2, 10)}`, live.tid, matter.matter_id, live.rid, kind, ++ver, filename, "x".repeat(64), "blob://x", live.uid],
    );
  // 合同起草：只交了《起草说明与待定事项》
  const a = fresh("only-notes");
  art(a, "agent_report", "起草说明与待定事项-设备买卖合同.docx");
  const miss = primaryDeliverableMissing(db, a.rid, "合同草稿.docx");
  assert.ok(miss);
  assert.equal(miss.cause, "only_attachments");
  assert.match(miss.note, /没有交出《合同草稿》：助手只交了附件（《起草说明与待定事项-设备买卖合同》）/);
  // 合同正文交出后不报（文书名称不必与方法里的“合同草稿”相同）
  art(a, "agent_report", "设备买卖合同.docx");
  assert.equal(primaryDeliverableMissing(db, a.rid, "合同草稿.docx"), null);
  // 股东会文件：只交了签署页与核对表
  const b = fresh("only-sign");
  art(b, "agent_report", "股东会决议签署页.docx");
  art(b, "agent_table", "召集与表决核对表.xlsx");
  assert.equal(primaryDeliverableMissing(db, b.rid, "决议（草稿）.docx")?.cause, "only_attachments");
  // 在原件上修订：修订稿、清洁稿与修改对照表——修订稿是主交付物
  const c = fresh("revise");
  art(c, "revision_draft", "技术服务合同（修订稿）.docx");
  art(c, "agent_report", "技术服务合同（修改对照表）.docx");
  assert.equal(primaryDeliverableMissing(db, c.rid, "修订稿.docx"), null);
  // 主交付物本身就是附件类名称（例如对照表、核对清单类方法）：不套这条规则
  const d = fresh("aux-primary");
  art(d, "agent_report", "上诉理由与一审认定对照表.docx");
  assert.equal(primaryDeliverableMissing(db, d.rid, "上诉理由对照表.docx"), null);
  // 一份 Word 都没有：仍是原来的原因
  const e = fresh("none");
  art(e, "agent_table", "证据目录.xlsx");
  assert.equal(primaryDeliverableMissing(db, e.rid, "民事起诉状（草稿）.docx")?.cause, "no_word_output");
});

test("审查要点：不可谈须有范本原句为证——没给原句、原句不在范本里、原句没写明底线的都不写入，其余照常", () => {
  const template =
    "销售合同审核标准\n条款主题 公司标准 可接受的让步 属性\n" +
    "责任上限 卖方赔偿责任以合同总价为限 可降至合同总价的 50% —\n" +
    "知识产权 交付成果的知识产权归我方所有，不得约定归对方或者共有 无 不可谈\n" +
    "管辖 争议必须提交我方所在地人民法院管辖 无 不可谈\n" +
    "账期 验收合格后 60 日内付款 最长不超过 90 日\n";
  const ctx = { db: { all: () => [{ content: template }] } } as any;
  const rules = [
    { topic: "责任上限", standard: "卖方赔偿责任以合同总价为限", fallback: "可降至合同总价的 50%", red_line: "不得低于合同总价的 50%", red_line_quote: "可降至合同总价的 50%" },
    { topic: "知识产权", standard: "交付成果的知识产权归我方所有", red_line: "不得约定归对方或者共有", red_line_quote: "交付成果的知识产权归我方所有，不得约定归对方或者共有" },
    { topic: "管辖", standard: "我方所在地人民法院", red_line: "必须由我方所在地法院管辖", red_line_quote: "争议必须提交我方所在地  人民法院管辖" },
    { topic: "账期", standard: "验收合格后 60 日内付款", red_line: "不接受超过 90 日" },
    { topic: "违约金", standard: "不超过合同总价 20%", red_line: "不接受超过 30%", red_line_quote: "违约金不接受超过合同总价 30%" },
    { topic: "保密", standard: "保密期三年" },
  ];
  const r = checkRedLineSources(ctx, "mat_x", rules);
  const out = r.rules as Record<string, unknown>[];
  assert.deepEqual(r.dropped.map((d) => d.no), [1, 4, 5]);
  assert.match(r.dropped[0]!.reason, /没有写明不能接受或必须如此/, "属性栏为“—”：原句只是让步幅度");
  assert.match(r.dropped[1]!.reason, /没有给出范本里写明这条底线的原句/);
  assert.match(r.dropped[2]!.reason, /不是范本里逐字出现的句子/);
  assert.equal(out[0]!.red_line, undefined);
  assert.equal(out[0]!.fallback, "可降至合同总价的 50%", "只去掉不可谈，其余字段保留");
  assert.equal(out[1]!.red_line, "不得约定归对方或者共有");
  assert.equal(out[2]!.red_line, "必须由我方所在地法院管辖", "空白差异不影响逐字核对");
  assert.equal(out[3]!.red_line, undefined);
  assert.equal(out[5]!.red_line, undefined);
  // red_line_quote 只用于核对，不进入存下的要点
  for (const x of out) assert.equal("red_line_quote" in x, false);
  // 工具入参结构声明了 red_line_quote（否则带这个字段的提交会被结构校验拒收）
  const tool = findTool("rules.propose")!;
  const props = (tool.inputSchema as any).properties.rules.items.properties;
  assert.ok(props.red_line_quote);
  assert.match(tool.description, /red_line_quote/);
});

// —— 在原件上修订：表格新增行、删除行、表后插入（真实走查 D1） ——
import { createDocx, docxListLabels, extractParagraphs, readZipEntries, writeZip } from "@zr-legal/docx-engine";
import { importBytes } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const WNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${WNS}>
<w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="multilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1.%2"/></w:lvl>
</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`;
const wp = (text: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const wnum = (ilvl: number) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>`;
const wtc = (text: string, tcPr = "") => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${tcPr}</w:tcPr>${wp(text)}</w:tc>`;
const wtr = (cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const wtbl = (rows: string[]) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows.join("")}</w:tbl>`;

function serviceContract(): Buffer {
  const body = [
    wp("服务水平", wnum(0)),
    wp("乙方应按下表约定的时限响应和恢复故障：", wnum(1)),
    wtbl([wtr([wtc("故障等级"), wtc("响应时间"), wtc("恢复时间")]), wtr([wtc("一级"), wtc("15分钟"), wtc("4小时")]), wtr([wtc("二级"), wtc("8小时"), wtc("24小时")])]),
    wp("乙方应在每次故障恢复后24小时内提交故障报告。", wnum(1)),
    wp("违约责任", wnum(0)),
    wp("乙方未提交第1.2款约定的故障报告的，每次支付违约金1,000元。", wnum(1)),
    wp("附件 联系人"),
    wtbl([wtr([wtc("类别"), wtc("角色"), wtc("电话")]), wtr([wtc("联系人", '<w:vMerge w:val="restart"/>'), wtc("甲方项目负责人"), wtc("0573-82910001")]), wtr([wtc("", "<w:vMerge/>"), wtc("甲方运维对接人"), wtc("0573-82910002")])]),
    wp("本附件是合同的组成部分。"),
  ].join("");
  const files = readZipEntries(createDocx("运维服务合同", [{ heading: "占位", paragraphs: ["占位"] }]));
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  files.set("word/numbering.xml", Buffer.from(NUMBERING));
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

async function reviseAgent(matterId: string, label: string) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 600)}`);
    return r.result.structuredContent;
  };
  return { live, call, close: () => agent.close() };
}

test("docx.revise：表后新增一款、表格新增一行、删除一行——试写写清落位，正式写入后清洁稿编号顺延、表格多一行，对照表写明位置", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "运维服务合同修订 V16", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-10" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "运维服务合同（定稿）.docx", serviceContract(), DOCX_MIME);
  const a = await reviseAgent(matter.matter_id, "tables");
  try {
    // 把锚点写在表格里用普通的段后插入：退回，并说明该用哪一种
    const wrong = await a.call("docx.revise", { document_version_id: doc.document_version_id, dry_run: true, patches: [{ anchor: "甲方运维对接人", proposed_text: "\t甲方数据安全联系人\t0573-82916627", insert_after: true }] });
    assert.equal(wrong.status, "not_applied");
    assert.equal(wrong.conflicts[0].reason, "bad_placement");
    assert.match(wrong.conflicts[0].detail, /insert_row_after/);
    assert.match(wrong.conflicts[0].fix, /insert_after_table/);
    const patches = [
      { anchor: "乙方应按下表约定的时限响应和恢复故障：", proposed_text: "1.2 发生一级故障的，乙方应在故障恢复后48小时内组织复盘会议。", insert_after_table: true, comment: "律师意见第 2 点" },
      { anchor: "甲方运维对接人", proposed_text: "甲方数据安全联系人｜0573-82916627", insert_row_after: true, comment: "律师意见第 5 点" },
      { anchor: "二级", proposed_text: "", delete_row: true, comment: "律师意见：删除二级故障一行" },
      { anchor: "第1.2款", proposed_text: "第1.3款", comment: "编号顺延联动" },
    ];
    const dry = await a.call("docx.revise", { document_version_id: doc.document_version_id, dry_run: true, patches });
    assert.equal(dry.status, "preview", JSON.stringify(dry).slice(0, 800));
    const flat = JSON.stringify(dry.changes);
    assert.match(flat, /inserted_after_table/);
    assert.match(flat, /row_inserted_after/);
    assert.match(flat, /row_deleted/);
    assert.deepEqual(dry.label_notes?.[0]?.dropped, ["1.2"], "新款开头抄进去的编号按表前那一段的编号样式去掉");
    assert.deepEqual(dry.numbering_changes.renumbered.map((x: any) => `${x.from}→${x.to}`), ["1.2→1.3"]);
    const out = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches });
    assert.equal(out.status, "applied", JSON.stringify(out).slice(0, 800));
    const dl = async (id: string) => Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: id })).data_base64, "base64");
    const clean = await dl(out.clean.artifact_version_id);
    const t = extractParagraphs(clean).map((p) => p.text);
    const labels = docxListLabels(clean);
    assert.equal(labels[t.indexOf("发生一级故障的，乙方应在故障恢复后48小时内组织复盘会议。")], "1.2");
    assert.equal(labels[t.indexOf("乙方应在每次故障恢复后24小时内提交故障报告。")], "1.3");
    assert.ok(t.includes("乙方未提交第1.3款约定的故障报告的，每次支付违约金1,000元。"));
    assert.equal(t.includes("二级"), false, "删除的行不在清洁稿里");
    const cleanXml = readZipEntries(clean).get("word/document.xml")!.toString("utf8");
    const tables = [...cleanXml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((m) => (m[0].match(/<w:tr\b/g) ?? []).length);
    assert.deepEqual(tables, [2, 4], "服务水平表少一行、联系人表多一行");
    const gap = t.indexOf("甲方数据安全联系人") - t.indexOf("甲方运维对接人");
    assert.ok(gap >= 2 && gap <= 3 && t.indexOf("甲方数据安全联系人") < t.indexOf("本附件是合同的组成部分。"), `新行紧接在“甲方运维对接人”行之后（相隔 ${gap} 段）`);
    // 修订稿：行级修订标记
    const revXml = readZipEntries(await dl(out.revision.artifact_version_id)).get("word/document.xml")!.toString("utf8");
    assert.match(revXml, /<w:trPr><w:ins [^>]*\/><\/w:trPr>/);
    assert.match(revXml, /<w:trPr><w:del [^>]*\/><\/w:trPr>/);
    // 修改对照表：写明表格上的位置
    const cmp = extractParagraphs(await dl(out.comparison.artifact_version_id)).map((p) => p.text).join("\n");
    assert.match(cmp, /之后新增一行/);
    assert.match(cmp, /整行删除/);
    assert.match(cmp, /（删除整行）/);
    assert.ok(cmp.includes("甲方数据安全联系人｜0573-82916627"));
    assert.ok(cmp.includes("二级｜8小时｜24小时"), "整行删除的修改前写整行文字");
  } finally {
    await a.close();
  }
});

test("独立复核看到的修订稿文字：表格按行写出，一行的内容被塞进同一格时看得出来", async () => {
  const { labeledTextWithRows, reviewMessages: rm } = await import("../src/services/independent-review.ts");
  const lines = labeledTextWithRows(serviceContract());
  assert.ok(lines.includes("［表格行］故障等级｜响应时间｜恢复时间"));
  assert.ok(lines.includes("［表格行］一级｜15分钟｜4小时"));
  assert.ok(lines.some((l) => l.startsWith("1.1 乙方应按下表约定的时限")), "正文段落仍带自动编号");
  // 把一行内容塞进最后一格（真实走查 D1 的样子）：同一格里两段，用“ / ”隔开，行数没有变
  const files = readZipEntries(serviceContract());
  const xml = files.get("word/document.xml")!.toString("utf8").replace("<w:r><w:t xml:space=\"preserve\">0573-82910002</w:t></w:r></w:p>", "<w:r><w:t xml:space=\"preserve\">0573-82910002</w:t></w:r></w:p><w:p><w:r><w:t xml:space=\"preserve\">甲方数据安全联系人 0573-82916627</w:t></w:r></w:p>");
  files.set("word/document.xml", Buffer.from(xml));
  const stuffed = labeledTextWithRows(writeZip([...files.entries()].map(([name, data]) => ({ name, data }))));
  assert.ok(stuffed.includes("［表格行］｜甲方运维对接人｜0573-82910002 / 甲方数据安全联系人 0573-82916627"), JSON.stringify(stuffed.slice(-4)));
  const user = rm({ ...base, kind: "revise", docs: [{ filename: "x（清洁稿）.docx", text: stuffed.join("\n") }] }).find((m) => m.role === "user")!.content;
  assert.match(user, /是否真的多了或少了一行/);
});

test("任务失败的说法：AI 服务账户余额或额度不足时，不把上游的金额与请求编号原样给律师看", async () => {
  const { agentFailureText } = await import("../src/executor/executor.ts");
  // 真实走查里上游返回的两种原话
  for (const raw of ["403 预扣费额度失败, 用户剩余额度: ¥0.959866, 需要预扣费额度: ¥1.386286 (request id: 202611100322146653457258268d9d6Bj7ZAfmc)", "403 用户额度不足, 剩余额度: ¥-0.152098 (request id: 202611100320009358618848268d9d6tSjbVaE0)", "insufficient_quota: You exceeded your current quota"]) {
    const t = agentFailureText("host_reported_failure", raw);
    assert.match(t, /AI 服务账户的余额或额度不足/);
    assert.match(t, /律所管理员或 Kimi Work 客服/);
    assert.match(t, /重新运行/);
    assert.equal(/¥|request id|0\.95|预扣费/.test(t), false, t);
  }
  // 其他情形不受影响
  assert.match(agentFailureText(null, "429 Too Many Requests"), /AI 服务繁忙/);
  assert.match(agentFailureText(null, "模型通道不可达"), /暂时连不上/);
  assert.match(agentFailureText(null, "文书工具返回了错误"), /^任务没有完成：文书工具返回了错误/);
});
