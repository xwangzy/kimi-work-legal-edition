/**
 * 令牌化覆盖扩展（审计 2026-10-13 §2.1、P1-3）：案号（按选项）、出生日期、带提示词的个人编号、微信号/QQ、音译名与拉丁字母姓名、
 * 昵称与职务称呼、无门牌地址。每类规则都配反例：合同编号、法条编号、签订/生效日期、金额、“老板/小区/王总监”等常见法律文本不得误判。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORY_LABEL, findTokens, MatterTokenizer, normalizeValue, residualIdentifiers, restoreTokens, tokenCategory, type TokenizeResult } from "../src/index.ts";

const KEY = Buffer.alloc(32, 5);
const tz = (o: { caseNumbers?: boolean; fullPseudonym?: boolean; parties?: { name: string; kind: "person" | "org" }[] } = {}) => new MatterTokenizer({ matterKey: KEY, ...o });

/** 断言文本完全不变（反例）。 */
function untouched(t: MatterTokenizer, text: string): void {
  const r = t.tokenize(text);
  assert.equal(r.text, text, `误判：${text} → ${r.text}`);
}

/** 断言 `piece` 被替换为指定类别的代号。 */
function replacedAs(r: TokenizeResult, piece: string, category: string): void {
  assert.ok(!r.text.includes(piece), `残留：${piece}｜${r.text}`);
  const e = r.entries.find((x) => x.value === piece);
  assert.ok(e, `没有条目：${piece}｜${r.entries.map((x) => x.value).join("/")}`);
  assert.equal(e.category, category, piece);
}

// ── 案号 ───────────────────────────────────────────────────────────

test("案号：选项开启时识别全角/半角/六角括号、最高法、之一、旧式“字第”、仲裁文号；括号与空白写法同一代号", () => {
  const t = tz({ caseNumbers: true });
  for (const c of ["（2026）京0105民初1234号", "(2025)最高法民终12号", "（2024）沪74民初5号之一", "〔2023〕粤03执456号", "（2015）朝民初字第12345号", "京劳人仲字〔2023〕第123号", "［2022］浙0102刑初45号"]) {
    const r = tz({ caseNumbers: true }).tokenize(`本案案号为${c}，现已审结。`);
    replacedAs(r, c, "case_no");
    assert.match(r.text, /〔案号·[0-9A-Z]{6}〕/);
  }
  const one = (s: string) => findTokens(t.tokenize(s).text)[0];
  assert.equal(one("（2026）京0105民初1234号"), one("(2026)京0105民初1234号"));
  assert.equal(one("（2026）京0105民初1234号"), one("〔2026〕京0105民初1234号"));
  assert.equal(one("（2026）京0105民初1234号"), one("（ 2026 ）京0105民初1234号"));
  assert.equal(normalizeValue("case_no", "〔2023〕粤03执456号"), "(2023)粤03执456号");
  assert.notEqual(one("（2026）京0105民初1234号"), one("（2026）京0105民初1235号"));
});

test("案号：缺省（L2）不识别——法律研究需要案号原文；文件文号、法条与普通编号即使开启也不算案号", () => {
  untouched(tz(), "参见（2024）京0105民初12345号、(2025)最高法民终12号判决。");
  assert.equal(residualIdentifiers("参见（2024）京0105民初12345号").length, 0);
  assert.equal(residualIdentifiers("参见（2024）京0105民初12345号", { caseNumbers: true })[0]?.category, "case_no");
  const on = tz({ caseNumbers: true });
  for (const s of ["依据法释〔2020〕17号第三条", "国发〔2020〕5号文件", "京政发〔2021〕12号", "（2024）年度第3号公告", "依据《民法典》第五百七十七条", "合同编号HT-2024-000123", "第（2）项约定"]) untouched(on, s);
});

test("案号：接线语义——开关与全部化名同一条件（内核 MatterTokenStore.tokenizer、闸门 tokenizerFor 均按 fullPseudonym 传入）", () => {
  const text = "（2026）京0105民初1234号";
  assert.equal(tz({ fullPseudonym: true }).tokenize(text).text, text, "开关只由 caseNumbers 决定，不隐式跟随 fullPseudonym");
  assert.notEqual(tz({ fullPseudonym: true, caseNumbers: true }).tokenize(text).text, text);
});

// ── 出生日期 ─────────────────────────────────────────────────────────

test("出生日期：有上下文时识别（出生日期：/出生于/生于/出生年月/……出生/……生，）；多种写法统一为 YYYY-MM-DD", () => {
  const t = tz();
  const cases: [string, string][] = [
    ["原告：赵某某，男，1985年3月2日出生，汉族。", "1985年3月2日"],
    ["出生日期：1985-03-02", "1985-03-02"],
    ["该员工出生于1985.3.2，现年四十一岁。", "1985.3.2"],
    ["被告人，男，生于1985/3/2，户籍所在地略。", "1985/3/2"],
    ["被告，女，1990年12月生，汉族。", "1990年12月"],
    ["出生年月：1985.03", "1985.03"],
    ["生日：1985年03月02日", "1985年03月02日"],
  ];
  for (const [text, piece] of cases) replacedAs(tz().tokenize(text), piece, "birth_date");
  const one = (s: string) => findTokens(t.tokenize(s).text)[0];
  assert.equal(one("出生日期：1985年3月2日"), one("出生日期：1985-03-02"));
  assert.equal(one("出生日期：1985年3月2日"), one("生于1985.3.2"));
  assert.equal(normalizeValue("birth_date", "1985年3月2日"), "1985-03-02");
  assert.equal(normalizeValue("birth_date", "1990年12月"), "1990-12");
});

test("出生日期：无上下文的日期、签订/生效/发生日期、“王先生于……”、金额不识别", () => {
  const t = tz();
  for (const s of [
    "双方于2026年3月2日签订本合同，自2026年3月2日生效。",
    "事故发生于2026年3月2日，损失金额1,234,567.89元。",
    "王先生于2020年3月2日签订合同。",
    "学生于2021年9月1日入学。",
    "截止日期：2026-03-02。",
    "2024年出生人口统计显示下降。",
    "依据《民法典》第五百七十七条。",
  ]) untouched(t, s);
});

// ── 带提示词的个人编号 ───────────────────────────────────────────────

test("个人编号：社保/医保号、病历号、住院号、门诊号、工号、学号、档案号 → 证件号（必须紧跟提示词）", () => {
  const t = tz();
  const cases: [string, string][] = [
    ["社会保障号码 A12345678", "A12345678"],
    ["医保卡号：1100123456789", "1100123456789"],
    ["病历号：MZ2023-0001", "MZ2023-0001"],
    ["住院号20231234，门诊号：MZ88123", "20231234"],
    ["门诊号：MZ88123", "MZ88123"],
    ["该员工工号：007", "007"],
    ["学号为2021010123", "2021010123"],
    ["档案号：DA-2019-88", "DA-2019-88"],
  ];
  for (const [text, piece] of cases) replacedAs(tz().tokenize(text), piece, "id_number");
});

test("个人编号反例：合同编号、发票号、施工号段、无数字的写法、提示词与编号之间隔了其他字", () => {
  const t = tz();
  for (const s of ["合同编号：HT-2024-000123", "发票号码 No.00123456", "施工号段A3", "员工花名册（工号由公司编制）", "工号：未分配", "学号查询系统", "档案号码见附件"]) untouched(t, s);
});

test("微信号与 QQ 号 → 账号（必须有提示词）；“微信转账”“微信支付”“QQ群”不识别", () => {
  const t = tz();
  replacedAs(t.tokenize("对方微信号：zhangsan_1985，"), "zhangsan_1985", "account");
  replacedAs(t.tokenize("微信：wxid_abc123def"), "wxid_abc123def", "account");
  replacedAs(t.tokenize("联系方式：QQ 123456789"), "123456789", "account");
  replacedAs(t.tokenize("QQ号：12345"), "12345", "account");
  for (const s of ["通过微信转账5000元", "微信支付凭证一份", "QQ群：123456", "微信聊天记录截图共12页", "微信 Pay"]) untouched(t, s);
});

// ── 音译名与拉丁字母姓名 ─────────────────────────────────────────────

test("音译名（含“·”及变体）：角色词之后、称谓或言语动词之前识别；分隔点写法不同仍是同一代号；词典命中照常", () => {
  const t = tz();
  const r1 = t.tokenize("原告阿卜杜拉·买买提诉称，被告拖欠货款。");
  replacedAs(r1, "阿卜杜拉·买买提", "person");
  assert.ok(r1.text.startsWith("原告〔自然人·") && r1.text.includes("诉称"));
  const r2 = t.tokenize("证人约翰·史密斯先生到庭作证。");
  assert.ok(r2.text.startsWith("证人〔自然人·"), r2.text);
  const r3 = t.tokenize("据约翰•史密斯回忆，货物当日送达。");
  assert.ok(r3.text.startsWith("据〔自然人·") && r3.text.includes("回忆"), r3.text);
  assert.equal(findTokens(r2.text)[0], findTokens(r3.text)[0], "· 与 • 写法同一代号");
  // 识别过的音译名进入令牌表，之后无上下文也替换
  assert.ok(!t.tokenize("约翰·史密斯在合同上签了字。").text.includes("史密斯"));
  const d = tz({ parties: [{ name: "热依拉·吐尔逊", kind: "person" }] }).tokenize("热依拉・吐尔逊于次日付款。");
  assert.ok(!d.text.includes("吐尔逊"), d.text);
});

test("音译名反例：无上下文的带点短语、机构名、目录标题不识别", () => {
  const t = tz();
  for (const s of ["第一章·总则", "被告：阿里·巴巴有限公司", "被告：约翰·史密斯贸易有限公司", "中国·上海国际会展中心举行签约仪式。"]) untouched(t, s);
  // 角色词之后的“音译名 + 律师事务所”不按音译名整体识别（既有称谓规则仍会把“律师”前的“史密斯”当作姓名——偏向召回，见报告）
  assert.ok(t.tokenize("原告约翰·史密斯律师事务所").text.includes("约翰·"));
});

test("拉丁字母姓名：只在角色词之后识别（John Smith、Li Ming、ZHANG SAN）；按词边界传播，不命中更长的单词", () => {
  const t = tz();
  replacedAs(t.tokenize("原告：John Smith，男，美国国籍。"), "John Smith", "person");
  replacedAs(t.tokenize("委托代理人：Li Ming，北京某律师事务所律师。"), "Li Ming", "person");
  replacedAs(t.tokenize("被申请人 ZHANG SAN，护照持有人。"), "ZHANG SAN", "person");
  const r = t.tokenize("申请人：Li Na。Li Na lives in South Carolina; CAROLINA LINAS");
  assert.equal(r.counts.person, 2, r.text);
  assert.ok(r.text.includes("South Carolina") && r.text.includes("CAROLINA LINAS"), r.text);
});

test("拉丁字母姓名反例：无角色词、机构词（Inc/Ltd/Group/Law Firm）、单个词、Party A", () => {
  const t = tz();
  for (const s of ["John Smith signed the contract.", "姓名 Full Name", "被告 Apple Inc.", "被告：Goldman Sachs Group", "代理人 King Law Firm", "原告 PRC", "甲方 Party A", "甲方（Party A）：某公司"]) untouched(t, s);
});

// ── 昵称与职务称呼 ───────────────────────────────────────────────────

test("昵称与职务称呼：姓氏属于已知自然人时识别为独立的值（各有代号）；“王总经理”整体识别", () => {
  const t = tz();
  const r = t.tokenize("原告：王明。王总表示同意，老王说没问题，小王也在场。王总经理签字确认。");
  for (const v of ["王总", "老王", "小王", "王总经理"]) replacedAs(r, v, "person");
  const toks = new Set(findTokens(r.text));
  assert.equal(toks.size, 5, "王明、王总、老王、小王、王总经理各有代号");
  // 词典中的自然人同样提供姓氏；令牌表中的昵称跨文本稳定
  const d = tz({ parties: [{ name: "陈晓东", kind: "person" }] });
  const a = d.tokenize("请陈经理与赵主任核对。");
  replacedAs(a, "陈经理", "person");
  assert.ok(a.text.includes("赵主任"), "赵不是已知姓氏：不替换");
  const later = new MatterTokenizer({ matterKey: KEY, parties: [{ name: "陈晓东", kind: "person" }], table: d.table() }).tokenize("陈经理表示同意。");
  assert.equal(findTokens(later.text)[0], a.entries.find((e) => e.value === "陈经理")!.token);
  // 单字称呼：张律、刘董、李工
  const s = tz({ parties: [{ name: "张伟", kind: "person" }, { name: "刘洋", kind: "person" }, { name: "李强", kind: "person" }] }).tokenize("联系张律，和刘董、李工确认。");
  for (const v of ["张律", "刘董", "李工"]) replacedAs(s, v, "person");
});

test("昵称反例：姓氏未知时不识别；“王总监/王总是/李工程师/老板/小区/小时/法律/员工”不误判，也不截成“王总”", () => {
  untouched(tz(), "王总到场，老王没来，李工也到场了。");
  // 既有言语动词规则会把“王总表示”识别为自然人；它只允许“王总”这个写法本身，不带出“老王/王总经理”
  const only = tz().tokenize("王总表示同意，老王没来，王总经理到场。");
  assert.ok(!only.text.includes("王总表示") && only.text.includes("老王") && only.text.includes("王总经理"), only.text);
  // 令牌表中的昵称跨文本只按边界规则再识别：“公司王总表示”替换，“王总监”不截
  const first = tz();
  first.tokenize("法定代表人王总，");
  const next = new MatterTokenizer({ matterKey: KEY, table: first.table() }).tokenize("公司王总表示同意；王总监另有意见。");
  assert.ok(!next.text.includes("王总表示") && next.text.includes("王总监"), next.text);
  const t = tz({ parties: [{ name: "王明", kind: "person" }, { name: "李强", kind: "person" }, { name: "时光", kind: "person" }, { name: "法拉", kind: "person" }] });
  for (const s of [
    "王总监负责现场管理。",
    "他王总是迟到。",
    "李工程师出具了鉴定意见。",
    "老板说先付一半。",
    "该小区5栋居民反映。",
    "2小时后到达。",
    "根据法律，双方应当履行。",
    "员工工资按月发放。",
    "王某某、小李子",
  ]) untouched(t, s);
  // 已识别的全名后紧跟的称呼不重复切分
  const r = t.tokenize("王明经理表示同意。");
  assert.ok(!r.text.includes("王明"), r.text);
});

// ── 地址补充 ─────────────────────────────────────────────────────────

test("地址：无门牌的村、组写法与“小区名 + 楼栋”写法识别；起点不吞“被告系/原告王某住”", () => {
  const t = tz();
  const cases: [string, string][] = [
    ["住址：河北省保定市清苑区东闾乡王庄村三组。", "河北省保定市清苑区东闾乡王庄村三组"],
    ["户籍地湖南省宁乡县双江口镇荷花村。", "湖南省宁乡县双江口镇荷花村"],
    ["被告系江西省于都县银坑镇高围村村民。", "江西省于都县银坑镇高围村"],
    ["原告王某住翠湖花园3幢2单元。", "翠湖花园3幢2单元"],
    ["现住锦绣家园二期5号楼1201室。", "锦绣家园二期5号楼1201室"],
    ["住阳光小区5栋。", "阳光小区5栋"],
  ];
  for (const [text, piece] of cases) replacedAs(tz().tokenize(text), piece, "address");
});

test("地址反例：区域名、法院与机关名称、村委会/村民、本小区/该小区、城中村改造不识别", () => {
  const t = tz();
  for (const s of [
    "北京市朝阳区人民法院",
    "由北京市朝阳区市场监督管理局负责。",
    "该镇王庄村委会出具证明。",
    "本小区5栋居民",
    "全国各地农村",
    "位于湖南省长沙县黄花镇城中村改造范围内。",
    "花园式厂区3栋",
  ]) untouched(t, s);
});

// ── 通用性质：幂等、还原、类别解析、代号不跨类别冲突 ─────────────────────

const MIXED = `原告：阿卜杜拉·买买提，男，1985年3月2日出生，社会保障号码A12345678，微信号：abdl_1985，住新疆维吾尔自治区喀什地区疏附县塔什米里克乡阿亚格村三组。
委托代理人：John Smith。被告：王明，住翠湖花园3幢2单元。王总表示同意，老王说没问题。本案案号（2026）京0105民初1234号。`;

test("幂等与还原：已令牌化文本再令牌化不变；残留检查为空；还原逐字等于原文；新代号可解析类别", () => {
  for (const caseNumbers of [false, true]) {
    const t = tz({ caseNumbers });
    const once = t.tokenize(MIXED);
    const twice = t.tokenize(once.text);
    assert.equal(twice.text, once.text);
    assert.equal(twice.replaced, 0);
    assert.equal(residualIdentifiers(once.text, { caseNumbers }).length, 0);
    assert.equal(restoreTokens(once.text, t.table()).text, MIXED);
    for (const tok of findTokens(once.text)) assert.ok(tokenCategory(tok), tok);
    assert.equal(once.text.includes("（2026）京0105民初1234号"), !caseNumbers);
    // 跨实例（令牌表持久化后）稳定
    const fresh = new MatterTokenizer({ matterKey: KEY, caseNumbers, table: t.table() }).tokenize(MIXED);
    assert.equal(fresh.text, once.text);
  }
  assert.equal(tokenCategory("〔案号·ABCDEF〕"), "case_no");
  assert.equal(tokenCategory("〔出生日期·ABCDEF〕"), "birth_date");
  assert.equal(CATEGORY_LABEL.case_no, "案号");
  assert.equal(CATEGORY_LABEL.birth_date, "出生日期");
});

test("代号不跨类别冲突：同一字面值在不同类别下得到不同代号（类别参与 HMAC）", () => {
  const t = tz();
  const a = t.tokenFor("id_number", "12345678");
  const b = t.tokenFor("account", "12345678");
  const c = t.tokenFor("birth_date", "1985-03-02");
  const d = t.tokenFor("case_no", "1985-03-02");
  assert.notEqual(a.token, b.token);
  assert.notEqual(c.token.slice(-7), d.token.slice(-7));
  assert.match(c.token, /^〔出生日期·/);
  assert.match(d.token, /^〔案号·/);
});

// ── 独立编写的小样本（合成，只报告；不对外引用） ────────────────────────

test("独立小样本报告（与规则不同来源的手写合成句；只报告召回与误替换，不设阈值）", () => {
  // 句式刻意不用规则里的角色词表写法：口语、笔录、聊天记录、表格行
  const positives: { text: string; secrets: string[] }[] = [
    { text: "笔录：问：你叫什么？答：我叫马丽·艾山。", secrets: ["马丽·艾山"] },
    { text: "聊天记录显示，对方加了我QQ：88990011，又发来微信 号 kk_2020a。", secrets: ["88990011", "kk_2020a"] },
    { text: "表格：姓名 | 出生年月 | 工号\n刘某 | 1979.11 | ZS-0091", secrets: ["1979.11", "ZS-0091"] },
    { text: "据了解，涉事司机家住城关镇杨家湾村五组。", secrets: ["城关镇杨家湾村五组"] },
    { text: "受害人系1992年7月出生的外卖员。", secrets: ["1992年7月"] },
    { text: "当事人Emily Brown（英国籍）称未收到货。", secrets: ["Emily Brown"] },
    { text: "老周后来跟我说，钱已经还了。", secrets: ["老周"] },
    { text: "住院号：ZY202300123；医保号 3101XX0099。", secrets: ["ZY202300123"] },
  ];
  const negatives = [
    "截至2025年12月31日，公司共有员工300人，工号统一由人事部编制。",
    "本合同自双方签字盖章之日起生效，合同编号ZR-2025-018。",
    "小区物业于2024年5月1日起调整收费标准。",
    "王总监、李总裁等高管出席了会议。",
    "依照《中华人民共和国民事诉讼法》第一百四十五条之规定。",
    "老旧小区改造项目共涉及12个村。",
  ];
  let hit = 0;
  let total = 0;
  const misses: string[] = [];
  for (const p of positives) {
    const out = tz().tokenize(p.text).text;
    for (const s of p.secrets) {
      total += 1;
      if (out.includes(s)) misses.push(s);
      else hit += 1;
    }
  }
  let fp = 0;
  const fps: string[] = [];
  for (const n of negatives) {
    const r = tz().tokenize(n);
    if (r.replaced > 0) {
      fp += r.replaced;
      fps.push(r.text);
    }
  }
  console.log(`[独立小样本（合成，不能对外引用）] 召回 ${hit}/${total}${misses.length ? `；漏：${misses.join(" / ")}` : ""}；误替换 ${fp} 处${fps.length ? `：${fps.join(" / ")}` : ""}`);
  assert.ok(total > 0);
});
