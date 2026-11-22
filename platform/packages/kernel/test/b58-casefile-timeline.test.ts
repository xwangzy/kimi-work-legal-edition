/**
 * 第 58 批复测 m01（整理案卷·本机规则，17 分）独立评分指出的确定性规则缺陷：
 * - 事实时间轴的“事件”把表格行、签署栏原样搬进来（“| 卖方：……（合同专用章） 授权代表（签字）……|”“1 2025-09-16 …… 405000.0 设备预付款”），
 *   同一句话重复几行（2025-10-28 三行、2025-11-03 五行）；
 * - 证据目录没有形成日期，页数写“未知”，名称带 .docx；
 * - 没写年份的日期写成“年份不明-07-15”，年份其实能从同一份材料推定；
 * - 补证清单不看律师填写的争点。
 * 正反例都写：句子里的“签字确认”“盖章确认”是事件不是签署栏；账号、发票号不加千分位；推定不了的年份写“年份待核”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractParagraphs, xlsxToText } from "@zr-legal/docx-engine";
import { buildS2Deliverables, extractFacts, formationDate, inferYear, issueEvidenceRows, pageLabel, tidyNumber } from "../src/executor/casefile.ts";

const mat = (id: string, filename: string, text: string, extra: { page_count?: number } = {}) => ({ document_version_id: id, parse_version_id: `p${id}`, filename, sha256: "0".repeat(64), chars: text.length, quality_flags: [], text, ...extra });
const build = (materials: ReturnType<typeof mat>[], issues: string[] = []) => buildS2Deliverables({ runId: "run_b58t", matter: { title: "示例", client_name: null, counterparty: null, stance: "原告" }, materials, issues });
/** 表格每行按列切开（xlsxToText 的输出：首行“【表名】”，之后一行一行、制表符分隔）。 */
const rowsOf = (b: ReturnType<typeof build>, prefix: string): string[][] =>
  xlsxToText(Buffer.from(b.files.find((x) => x.filename.startsWith(prefix))!.bytes)).text.split("\n").filter((l) => l && !/^【/.test(l)).map((l) => l.split("\t"));
const timeline = (b: ReturnType<typeof build>) => rowsOf(b, "事实时间轴").slice(1);
const factsOf = (id: string, text: string) => extractFacts({ document_version_id: id, parse_version_id: `p${id}`, filename: `${id}.docx`, text }).filter((f) => f.kind === "date");

const XLSX_TEXT =
  "【收款记录】\n序号\t到账日期\t付款单位\t付款账户\t金额（元）\t对应款项\n1\t2025-09-16\t嘉兴禾丰包装科技有限公司\t中国农业银行嘉兴南湖支行 19380101040056789\t405000.0\t30%预付款\n\t合计\t\t\t905000.0\n" +
  "【开票明细】\n序号\t开票日期\t发票号码\t价税合计（元）\n1\t2025-09-18\t32012500000041387726\t405000.0";

test("表格行按列写成可读的事件句：带表名与列名，Excel 的“405000.0”写成“405,000”，账号、发票号原样，合计行标“合计”", () => {
  const ev = timeline(build([mat("d3", "03-收款记录与开票明细.xlsx", XLSX_TEXT)])).map((r) => r[1]!);
  assert.ok(ev.includes("收款记录：到账日期：2025-09-16；付款单位：嘉兴禾丰包装科技有限公司；付款账户：中国农业银行嘉兴南湖支行 19380101040056789；金额（元）：405,000；对应款项：30%预付款"), ev.join("\n"));
  assert.ok(ev.includes("开票明细：开票日期：2025-09-18；发票号码：32012500000041387726；价税合计（元）：405,000"), ev.join("\n"));
  assert.ok(ev.every((e) => !/\|/.test(e) && !/\d{4,}\.0\b/.test(e)), "事件栏不带“|”，不带“.0”");
  assert.ok(ev.every((e) => !/^1 2025/.test(e)), "不再原样搬“1 2025-09-16 ……”");

  const docx = timeline(build([mat("d4", "04-对账确认函.docx", "往来款项对账确认函\n| 项目 | 金额（元） | 备注 |\n| 贵司累计已付 | 905,000.00 | 2025-09-16、2025-12-26 |\n合同编号信息\n| 签订日期 | 2025年9月12日 |\n| 合同编号 | RC-1 |")])).map((r) => r[1]!);
  assert.ok(docx.includes("项目：贵司累计已付；金额（元）：905,000.00；备注：2025-09-16、2025-12-26"), docx.join("\n"));
  assert.ok(docx.includes("签订日期：2025年9月12日"), "两栏的“名目｜内容”表写成“名目：内容”");

  assert.equal(tidyNumber("405000.0"), "405,000");
  assert.equal(tidyNumber("945000", "价税合计（元）"), "945,000");
  assert.equal(tidyNumber("32012500000041387726", "发票号码"), "32012500000041387726");
  assert.equal(tidyNumber("202512", "付款账号"), "202512", "账号栏的数不加千分位");
  assert.equal(tidyNumber("2025", "年度"), "2025");
  assert.equal(tidyNumber("3.5"), "3.5");
});

test("签署栏、落款写成“落款：××”；同一份材料同一天另有事件的不再单列；句子里的“签字确认”“盖章确认”照常是事件", () => {
  const b = build([
    mat("d1", "01-合同.docx", "设备买卖合同\n| 卖方：苏州锐川精密机械有限公司（合同专用章） 授权代表（签字）：韩启明 日期：2025年9月12日 | 买方：嘉兴禾丰包装科技有限公司（合同专用章） 授权代表（签字）：周宏亮 日期：2025年9月12日 |"),
    mat("d5", "05-质量异议函.docx", "请贵司于收到本函后5个工作日内书面回复。\n嘉兴禾丰包装科技有限公司（公章）\n2026年7月15日"),
    mat("d6", "06-催款函.docx", "贵司已于2026年7月3日在对账确认函上盖章确认上述欠款。我司于2026年7月28日更换链条，贵司设备部已签字确认。\n苏州锐川精密机械有限公司（公章）\n2026年8月18日\n邮寄记录：EMS 1186，2026年8月18日寄出。"),
  ]);
  const tl = timeline(b);
  const at = (d: string) => tl.filter((r) => r[0] === d).map((r) => r[1]);
  assert.deepEqual(at("2025-09-12"), ["落款：苏州锐川精密机械有限公司、嘉兴禾丰包装科技有限公司"]);
  assert.deepEqual(at("2026-07-15"), ["落款：嘉兴禾丰包装科技有限公司"]);
  assert.deepEqual(at("2026-07-03"), ["贵司已于2026年7月3日在对账确认函上盖章确认上述欠款。"], "句子里的“盖章确认”是事件");
  assert.deepEqual(at("2026-07-28"), ["我司于2026年7月28日更换链条，贵司设备部已签字确认。"], "句子里的“签字确认”是事件");
  assert.deepEqual(at("2026-08-18"), ["邮寄记录：EMS 1186，2026年8月18日寄出。"], "同一份材料同一天另有事件，落款不再单列");
  assert.ok(tl.every((r) => !/授权代表|（签字）|\|/.test(r[1]!)), "签署栏原文不进事件栏");
});

test("同一日期同一事件合并成一行、出处合并；不同事件各列一行", () => {
  const form = "安装调试完成日期：2025年10月28日　　验收日期：2025年11月3日";
  const b = build([
    mat("d2", "02-验收单.docx", `设备验收单（1号机）\n${form}\n设备验收单（2号机）\n${form}\n设备验收单（3号机）\n${form}`),
    mat("d6", "06-催款函.docx", "三台设备均于2025年11月3日验收合格。"),
    mat("d9", "09-情况说明.docx", "三台设备均于2025年11月3日验收合格。卖方于2025年11月3日派员回访。"),
    mat("d7", "07-纪要.docx", "2025年10月28日安装调试完成。"),
    mat("d8", "08-记录.docx", "记录：2025年10月28日安装调试完成。"),
  ]);
  const tl = timeline(b);
  const oct = tl.filter((r) => r[0] === "2025-10-28");
  assert.equal(oct.length, 2, oct.map((r) => r.join("｜")).join("\n"));
  const form28 = oct.find((r) => r[1]!.startsWith("安装调试完成日期"))!;
  assert.equal(form28[3], "02-验收单.docx");
  assert.equal(form28[5]!.split("；").length, 3, "三处出处合并进一行的“原文位置”");
  const contained = oct.find((r) => r[1] === "记录：2025年10月28日安装调试完成。")!;
  assert.equal(contained[3], "07-纪要.docx、08-记录.docx", "一句包含另一句的：留文字最全的一条，出处合并");
  assert.match(contained[5]!, /《07-纪要\.docx》第 .*；《08-记录\.docx》第 /);
  const nov = tl.filter((r) => r[0] === "2025-11-03").map((r) => r[1]);
  assert.equal(nov.filter((e) => e === "三台设备均于2025年11月3日验收合格。").length, 1, "两份材料同一句只列一行");
  assert.ok(nov.includes("卖方于2025年11月3日派员回访。"), "同一天的不同事件照列");
});

test("金额行：同一句几笔合成一行，千分位、不带 .0；大小写不一致的提示跟着那一笔", () => {
  const tl = timeline(build([mat("d5", "05-异议函.docx", "就3号机整机价款386,000元减价30%，即115,800元；截至本函发出之日，贵司尚欠我司货款人民币肆拾伍万伍仟元整（¥445,000.00）。")]));
  const am = tl.filter((r) => r[0] === "（日期未明）");
  assert.equal(am.length, 2, am.map((r) => r.join("｜")).join("\n"));
  assert.equal(am[0]![2], "金额：386,000 元、115,800 元");
  assert.match(am[1]![2]!, /^金额：455,000 元（大写与小写不一致，见补证清单）、445,000 元（大写与小写不一致，见补证清单）$/);
});

test("没写年份的日期按同一份材料推定年份并标明；推定不了写“年份待核”，不再出现“年份不明-07-15”", () => {
  const letter = "关于贵司7月15日来函所称3号机问题，我司已于2026年7月28日更换链条。\n苏州锐川精密机械有限公司（公章）\n2026年8月18日";
  const svc = "服务内容：按11月3日验收单遗留事项调整刀位。\n客户确认：以上属实。李国栋　2025年11月12日";
  const multi = "贵司于2025年12月26日付款200,000元。7月15日贵司来函提出异议。\n苏州锐川精密机械有限公司（公章）\n2026年8月18日";
  const b = build([mat("d6", "06-催款函.docx", letter), mat("d2", "02-服务单.docx", svc), mat("d3", "03-多年份函.docx", multi), mat("d7", "07-便条.txt", "周一说3月5日前付清。")]);
  const tl = timeline(b);
  const dates = tl.map((r) => r[0]!);
  assert.ok(dates.every((d) => !d.includes("年份不明")), dates.join("\n"));
  assert.ok(tl.some((r) => r[0] === "2026-07-15（年份按本文其他日期推定）" && r[3] === "06-催款函.docx"));
  assert.ok(tl.some((r) => r[0] === "2025-11-03（年份按本文其他日期推定）" && r[3] === "02-服务单.docx"));
  assert.ok(tl.some((r) => r[0] === "2026-07-15（年份按本文其他日期推定）" && r[3] === "03-多年份函.docx"), "出现两个年份：按落款日期 2026-08-18 的年份推定");
  const chat = factsOf("c", "2023-11-20 10:00 葛：余款要在11月27日前付到结算价的95%。\n2025-03-10 09:05 葛：我调到湖州项目了。\n2026-11-04 导出");
  const chatText = "2023-11-20 10:00 葛：余款要在11月27日前付到结算价的95%。\n2025-03-10 09:05 葛：我调到湖州项目了。\n2026-11-04 导出";
  assert.equal(inferYear(chat.find((f) => f.normalized.startsWith("年份不明"))!, chat, "2026-11-04", chatText), "2023-11-27", "聊天记录按同一行的时间戳推年份，不按导出日期");
  const cross = factsOf("y", "2024-01-05 周：12月30日那批货还没结。\n2024-03-01 韩：好的。");
  assert.equal(inferYear(cross.find((f) => f.normalized.startsWith("年份不明"))!, cross, "2024-03-01", "2024-01-05 周：12月30日那批货还没结。\n2024-03-01 韩：好的。"), "2023-12-30", "跨年：取离同一行时间戳最近的一年");
  const period = factsOf("q", "竞业限制期限自2026年9月5日至2027年2月28日。\n员工于2026年9月12日接受访谈。");
  assert.equal(formationDate("竞业限制期限自2026年9月5日至2027年2月28日。\n员工于2026年9月12日接受访谈。", period)?.label, "2026-09-12（文中最晚的明确日期）", "期间终点“至2027年2月28日”不算形成日期");
  const last = tl.filter((r) => r[0] !== "（日期未明）").at(-1)!;
  assert.equal(last[0], "3月5日（年份待核）", "推定不了的写“年份待核”，排在有日期的行之后");
  assert.ok(tl.some((r) => r[1] === "客户确认：以上属实。李国栋 2025年11月12日"), "句子只剩日期加人名的，写整行");

  const rel = factsOf("r", "双方于2025年3月1日签约，次年5月10日付款，同年6月1日结清。");
  const anchor = formationDate("x", rel)?.iso ?? null;
  assert.deepEqual(rel.filter((f) => f.normalized.startsWith("年份不明")).map((f) => inferYear(f, rel, anchor)), ["2026-05-10", "2025-06-01"], "相对年份以前面最近的明确日期为基准（“同年”承接的是 2025 年那个明确日期）");
  const rangeText = "裁决支付2026年9月5日至10月31日竞业限制补偿。另据2023年版手册……\n人事部\n2023年6月1日";
  const range = factsOf("g", rangeText);
  assert.equal(inferYear(range.find((f) => f.normalized.startsWith("年份不明"))!, range, "2023-06-01", rangeText), "2026-10-31", "区间后一端跟前一端同年");
  const ahead = factsOf("h", "2025年版制度已废止。公司要求11月15日前返还设备。\n2026年11月2日");
  assert.equal(inferYear(ahead.find((f) => f.normalized.startsWith("年份不明"))!, ahead, "2026-11-02", "x"), "2026-11-15", "几个年份的段落取离形成日期最近的一年：预告的期限在同年");
  const none = factsOf("n", "3月5日前付清。");
  assert.equal(inferYear(none[0]!, none, null), null);
});

test("证据目录：名称去扩展名；形成日期取落款日期、其次文中最晚的明确日期（截止日期除外），写明取法；页数用解析结果、换页符、工作表或字数估算", () => {
  const b = build([
    mat("d5", "05-质量异议函.docx", "我司于2025年9月12日与贵司签订合同。\n嘉兴禾丰包装科技有限公司（公章）\n2026年7月15日"),
    mat("d4", "04-对账确认函.docx", "苏州锐川精密机械有限公司（财务专用章）\n2026年6月30日\n回执：以上金额属实。\n嘉兴禾丰包装科技有限公司（财务专用章）　经办：朱丽　2026年7月3日"),
    mat("d7", "07-微信聊天摘录.txt", "2025-11-20 09:12 周：老卡纸。\n2026-03-10 16:05 周：20万今天走的账。\n请于2026年12月31日前付清。"),
    mat("d8", "08-扫描件.pdf", "第一页\f第二页\f第三页"),
    mat("d9", "09-说明.docx", "没有日期的说明。", { page_count: 2 }),
    mat("d3", "03-收款记录.xlsx", XLSX_TEXT),
  ]);
  const ev = rowsOf(b, "证据目录");
  assert.deepEqual(ev[0], ["编号", "证据名称", "形成日期", "来源", "页数", "原件状态", "证明目的（律师填写）", "待证事实（律师填写）"]);
  const by = (name: string) => ev.find((r) => r[1] === name)!;
  assert.ok(ev.slice(1).every((r) => !/\.(docx|pdf|xlsx|txt)$/.test(r[1]!)), "证据名称不带扩展名");
  assert.equal(by("05-质量异议函")[2], "2026-07-15（落款日期）");
  assert.equal(by("04-对账确认函")[2], "2026-07-03（落款日期；另有落款 2026-06-30）");
  assert.equal(by("07-微信聊天摘录")[2], "2026-03-10（文中最晚的明确日期）", "“2026年12月31日前”是截止日期，不算形成日期");
  assert.equal(by("09-说明")[2], "未见明确日期");
  assert.equal(by("08-扫描件")[4], "3", "换页符分页");
  assert.equal(by("09-说明")[4], "2", "解析结果有页数的用它");
  assert.equal(by("03-收款记录")[4], "2 个工作表（收款记录、开票明细）");
  assert.match(by("05-质量异议函")[4]!, /^约 1 页（按字数估算，以打印为准）$/);
  assert.equal(pageLabel({ filename: "x.zip", text: "abc" }), "未计页");
  const cat = rowsOf(b, "案卷总目录");
  assert.ok(cat.some((r) => r[1] === "08-扫描件.pdf" && r[2] === "3"), "案卷总目录同一口径，文件名保留扩展名");
});

test("补证清单按律师填写的争点列常用证据：争点点名了才列，“；”分开的几个争点各自判断，不凭空推", () => {
  assert.deepEqual(issueEvidenceRows([]), []);
  assert.deepEqual(issueEvidenceRows(["管辖法院如何确定"]), [], "没点名的类型不列");
  const rows = issueEvidenceRows(["原纸含水率是否超标；3号机质量异议能否对抗付款", "违约金日万分之五是否过高", "质保金是否已到期", "验收款是否到期"]);
  assert.equal(rows.length, 4, rows.join("\n"));
  assert.match(rows[0]!, /^争点“原纸含水率是否超标”：含水率的原始检测记录/);
  assert.match(rows[1]!, /^争点“3号机质量异议能否对抗付款”：质量问题的原始检测或检验记录/);
  assert.match(rows[2]!, /^争点“违约金日万分之五是否过高”：我方实际损失的证据/);
  assert.match(rows[3]!, /^争点“质保金是否已到期”：到期起算事实的凭证/);
  assert.ok(!rows.some((r) => r.startsWith("争点“验收款是否到期”")), "同一类证据只列一次");

  const sup = extractParagraphs(Buffer.from(build([mat("d1", "01-合同.docx", "本合同于2025年9月12日签订。")], ["原纸含水率是否超标"]).files.find((x) => x.filename.startsWith("补证清单"))!.bytes)).map((p) => p.text).join("\n");
  assert.match(sup, /争点“原纸含水率是否超标”：含水率的原始检测记录/);
  assert.match(sup, /以“争点”开头的几项按律师填写的争点列出/);
  assert.equal(/本机|接着做|系统/.test(sup), false);
});
