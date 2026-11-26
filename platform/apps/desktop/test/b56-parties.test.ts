// D-224 当事人信息：事项里存一次的一份材料《当事人信息（律师填写）.txt》，要写身份首部的卡自动带入。
// 序列化 / 解析往返、摘要与“已填几项”、needsParties 清单与卡片一致、与案情说明同一勾选口径、当前版本的认定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agentLabelFor,
  agentLabelIn,
  agentsLine,
  blankAgent,
  blankParty,
  currentPartiesDoc,
  filledCount,
  headerLines,
  initialParties,
  isBlankParty,
  normalizePartyValue,
  parseParties,
  PARTIES_FILENAME,
  PARTIES_HEAD,
  PARTIES_HEADER_MARK,
  PARTIES_PREFIX,
  partiesDigest,
  partiesShort,
  partiesSummary,
  partyCompleteness,
  powersText,
  roleSuggestions,
  serializeParties,
  withPartiesDoc,
  type PartyAgent,
  type PartyEntry,
} from "../src/lib/parties.ts";
import { buildGoal, NEEDS_PARTIES_CARDS, SCENARIOS } from "../src/lib/scenarios.ts";

const ours: PartyEntry = { side: "ours", kind: "org", role: "原告", name: "华诚贸易有限公司", fields: { uscc: "91310115MA1H7K2X3Q", address: "上海市浦东新区张江路1288号3幢501室", legal_rep: "王建国", legal_rep_title: "执行董事", phone: "021-58881234" } };
const theirs: PartyEntry = { side: "theirs", kind: "person", role: "被告", name: "李秀英", fields: { gender: "女", id_number: "110105198503021241", phone: "13912345678" } };

// 第 56 批保存出的旧格式（（单位）、“身份证号”、没有首部写法）：照常解析（第 64 批兼容）
const OLD_TEXT = [
  PARTIES_HEAD,
  "",
  "一、我方（原告）：华诚贸易有限公司（单位）",
  "统一社会信用代码：91310115MA1H7K2X3Q",
  "住所：上海市浦东新区张江路1288号3幢501室",
  "法定代表人：王建国，职务：执行董事",
  "联系电话：021-58881234",
  "",
  "二、对方（被告）：李秀英（自然人）",
  "性别：女",
  "身份证号：110105198503021241",
  "联系电话：13912345678",
  "",
].join("\n");

test("序列化：固定格式、没填的项不写出、整方都空的不写出；末尾附自动生成的文书首部写法", () => {
  const text = serializeParties([ours, theirs, blankParty("third")]);
  assert.equal(
    text,
    [
      PARTIES_HEAD,
      "",
      "一、我方（原告）：华诚贸易有限公司（法人）",
      "统一社会信用代码：91310115MA1H7K2X3Q",
      "住所：上海市浦东新区张江路1288号3幢501室",
      "法定代表人：王建国，职务：执行董事",
      "联系电话：021-58881234",
      "",
      "二、对方（被告）：李秀英（自然人）",
      "性别：女",
      "公民身份号码：110105198503021241",
      "联系电话：13912345678",
      "",
      PARTIES_HEADER_MARK,
      "原告：华诚贸易有限公司，统一社会信用代码91310115MA1H7K2X3Q，住所上海市浦东新区张江路1288号3幢501室，联系电话021-58881234。",
      "法定代表人：王建国，执行董事。",
      "被告：李秀英，女，民族【待填】，出生日期【待填】，公民身份号码110105198503021241，住址【待填】，联系电话13912345678。",
      "",
    ].join("\n"),
  );
  assert.equal(text.includes("空"), false);
  assert.equal(PARTIES_FILENAME.startsWith(PARTIES_PREFIX), true);
});

test("往返一致：解析 → 序列化逐字相同；只有职务、只有法定代表人、没有称谓、第三人与其他当事人", () => {
  const cases: PartyEntry[][] = [
    [ours, theirs],
    [{ ...ours, fields: { legal_rep_title: "董事长" } }, { ...theirs, role: "" }],
    [{ ...ours, fields: { legal_rep: "欧阳明月" } }, { side: "third", kind: "org", role: "第三人", name: "某某（上海）有限公司", fields: { address: "上海市黄浦区中山东一路1号" } }, { side: "other", kind: "person", role: "", name: "赵雪梅", fields: { birth: "1985年3月2日" } }],
    [{ side: "theirs", kind: "org", role: "", name: "", fields: { phone: "0571-88886666" } }],
  ];
  for (const list of cases) {
    const text = serializeParties(list);
    const back = parseParties(text);
    assert.ok(back, text);
    assert.deepEqual(back, list.map((p) => ({ ...p, fields: Object.fromEntries(Object.entries(p.fields).filter(([, v]) => v)) })));
    assert.equal(serializeParties(back!), text);
  }
  // 空表：只有抬头，解析为空列表
  assert.deepEqual(parseParties(serializeParties([])), []);
});

test("号码与地址去掉中间空格、代码转大写（令牌化认得出的写法）", () => {
  assert.equal(normalizePartyValue("uscc", " 9131 0115 ma1h 7k2x 3q "), "91310115MA1H7K2X3Q");
  assert.equal(normalizePartyValue("id_number", "110105 19850302 124x"), "11010519850302124X");
  assert.equal(normalizePartyValue("address", "上海市浦东新区张江路 1288 号 3 幢 501 室"), "上海市浦东新区张江路1288号3幢501室");
  assert.equal(normalizePartyValue("phone", "021 5888 1234"), "02158881234");
  assert.equal(normalizePartyValue("legal_rep_title", " 执行 董事 "), "执行 董事");
  const back = parseParties(serializeParties([{ ...ours, fields: { address: "张江路 1288 号" } }]))!;
  assert.equal(back[0]!.fields.address, "张江路1288号");
});

test("解析不了的（律师手改过）返回 null：抬头改了、多了认不出的行、同一项写两次", () => {
  const text = serializeParties([ours, theirs]);
  assert.equal(parseParties(text.replace(PARTIES_HEAD, "当事人信息")), null);
  assert.equal(parseParties(`${text}备注：开庭前再核对\n`), null);
  assert.equal(parseParties(text.replace("性别：女", "性别：女\n性别：男")), null);
  assert.equal(parseParties(text.replace("（自然人）", "（个人）")), null);
  assert.equal(parseParties(`${PARTIES_HEAD}\n随便写的一段话`), null);
});

test("摘要与已填几项：名称不计；开始面板一句按方合计", () => {
  assert.equal(filledCount(ours), 5);
  assert.equal(filledCount(theirs), 3);
  assert.deepEqual(partiesSummary([ours, theirs, blankParty("third")]), [
    { side: "我方", name: "华诚贸易有限公司", filled: 5 },
    { side: "对方", name: "李秀英", filled: 3 },
  ]);
  const another: PartyEntry = { side: "theirs", kind: "org", role: "被告", name: "恒远机械有限公司", fields: { address: "杭州市余杭区文一西路969号" } };
  assert.equal(partiesShort([ours, theirs, another]), "我方 5 项、对方 4 项");
  assert.equal(partiesShort([]), "");
});

test("初始表单：名称用事项的客户、相对方预填；立场是原告 / 被告时预填称谓；顿号分隔的相对方逐个列出", () => {
  const a = initialParties({ client_name: "华诚贸易有限公司", counterparty: "恒远机械有限公司、张伟", stance: "原告" });
  assert.deepEqual(a.map((p) => [p.side, p.kind, p.role, p.name]), [
    ["ours", "org", "原告", "华诚贸易有限公司"],
    ["theirs", "org", "被告", "恒远机械有限公司"],
    ["theirs", "person", "被告", "张伟"],
  ]);
  assert.deepEqual(initialParties({ client_name: "甲公司", counterparty: "", stance: "defendant" }).map((p) => [p.side, p.role, p.name]), [["ours", "被告", "甲公司"], ["theirs", "原告", ""]]);
  assert.deepEqual(initialParties({ client_name: "甲公司", counterparty: "乙公司", stance: "buyer" }).map((p) => p.role), ["", ""]);
});

test("当前有效的那一份：最新、未被取代、未隔离；名称不是固定前缀的不算", () => {
  const docs = [
    { document_version_id: "d1", filename: PARTIES_FILENAME, created_at: "2026-11-22T01:00:00Z" },
    { document_version_id: "d2", filename: PARTIES_FILENAME, supersedes: "d1", created_at: "2026-11-22T02:00:00Z" },
    { document_version_id: "d3", filename: "关于当事人信息（律师填写）的说明.txt", created_at: "2026-11-22T03:00:00Z" },
    { document_version_id: "d4", filename: "合同.docx", created_at: "2026-11-22T04:00:00Z" },
  ];
  assert.equal(currentPartiesDoc(docs)?.document_version_id, "d2");
  assert.equal(currentPartiesDoc([...docs, { document_version_id: "d5", filename: PARTIES_FILENAME, supersedes: "d2", quarantined_at: "x", created_at: "2026-11-22T05:00:00Z" }]), null, "最新一版被隔离：不认已被取代的旧版");
  assert.equal(currentPartiesDoc(docs.slice(2)), null);
});

test("勾选口径与案情说明一致：勾了别的材料时一并勾上；一份都没勾时不单独勾；不要首部的卡不带", () => {
  assert.deepEqual(withPartiesDoc(["a"], "p", true), ["a", "p"]);
  assert.deepEqual(withPartiesDoc([], "p", true), []);
  assert.deepEqual(withPartiesDoc(["a", "p"], "p", true), ["a", "p"]);
  assert.deepEqual(withPartiesDoc(["a"], null, true), ["a"]);
  assert.deepEqual(withPartiesDoc(["a"], "p", false), ["a"]);
});

test("needsParties：清单与卡片一致，都是存在的卡；起诉状、仲裁申请书不再有“当事人信息”文字栏，任务说明里也没有", () => {
  const marked = SCENARIOS.filter((c) => c.needsParties).map((c) => c.id).sort();
  assert.deepEqual(marked, [...NEEDS_PARTIES_CARDS].sort());
  assert.equal(marked.length, 14);
  for (const c of SCENARIOS) {
    assert.equal(c.fields.some((f) => f.key === "party_info"), false, c.id);
    assert.equal(c.goal.includes("{party_info}") || c.goal.includes("当事人信息："), false, c.id);
  }
  const arb = SCENARIOS.find((c) => c.id === "arbitration-app")!;
  assert.equal(buildGoal(arb, { institution: "上海国际仲裁中心", claims: ["支付货款"] }, "").startsWith("请起草商事仲裁申请书，先核对仲裁协议。仲裁机构：上海国际仲裁中心；仲裁请求（按我列的顺序与取舍写）：支付货款。我确认过"), true);
});

test("界面接线：开始面板显示已填 / 未填并按同一口径带入；概览有入口；内核按同一前缀认材料", () => {
  const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  const start = src("../src/components/ScenarioStart.tsx");
  assert.ok(start.includes("withPartiesDoc(v.documentIds") && start.includes("还没填：起草首部会写【待填】。"));
  // 第 66 批：开始面板两栏，段标题前加序号（ss-n），段落仍是独立的“当事人”段；第 67 批：单栏、段标题不再带序号（段序随业务形态）
  // 第 64 批：开始面板里“当事人”单独成段（段标题与其他段一致），对话框按卡给称谓建议
  assert.ok(start.includes('<section className="ss-sec ss-step ss-parties" aria-label="当事人">') && start.includes('<div className="ss-h">当事人</div>') && start.includes("cardId={card.id}"));
  assert.ok(src("../src/components/MatterOverview.tsx").includes("还没有填当事人信息——起诉状、律师函等文书的首部会留【待填】"));
  const pi = src("../src/components/PartiesInfo.tsx");
  assert.ok(pi.includes("importMaterialText(matter.matter_id, PARTIES_FILENAME, text, prev)"), "新版本取代上一版");
  assert.ok(pi.includes("for (const a of namedAgents(p)) if (!people.has(a.name.trim())) people.set(a.name.trim(), label);"), "代理人姓名也登记进当事人词典");
  assert.ok(pi.includes('aria-label="称谓"') && pi.includes("pi-add") && pi.includes("pi-group"), "评测驱动（eval/driver.js）认的称谓框、再加一方与每方一组");
  assert.ok(src("../../../packages/kernel/src/executor/executor.ts").includes(`PARTIES_MATERIAL_PREFIX = "${PARTIES_PREFIX}"`));
});


// ── 第 64 批：三类当事人、委托诉讼代理人、文书首部写法、完成度、按卡的称谓建议 ──

const plaintiff: PartyEntry = {
  side: "ours",
  kind: "person",
  role: "原告",
  name: "王超",
  fields: { gender: "男", ethnicity: "汉族", birth: "1966年2月5日", id_number: "110105196602051234", address: "北京市朝阳区建国路88号院2号楼1203室", phone: "13912345678" },
  agents: [{ name: "张三", identity: "lawyer", fields: { org: "北京某某律师事务所", license: "11101201510123456", phone: "13800001111" }, scope: "special", powers: ["admit", "waive", "modify", "settle", "counterclaim", "appeal"] }],
};
const defendant: PartyEntry = { side: "theirs", kind: "org", role: "被告", name: "上海某某有限公司", fields: { uscc: "91310115MA1H7K2X3Q", address: "上海市浦东新区张江路1288号3幢501室", legal_rep: "李四", legal_rep_title: "执行董事", phone: "021-58881234" } };

test("旧格式（（单位）、身份证号、没有首部写法）逐字照常解析，再保存写成新格式", () => {
  const back = parseParties(OLD_TEXT);
  assert.deepEqual(back, [ours, theirs]);
  const again = serializeParties(back!);
  assert.ok(again.includes("（法人）") && again.includes("公民身份号码：110105198503021241") && again.includes(PARTIES_HEADER_MARK));
  assert.deepEqual(parseParties(again), [ours, theirs]);
  // 内核用例 b56-parties-tokenize 的旧样例（括号楼栋、出生日期、住址）
  assert.ok(parseParties(OLD_TEXT.replace("联系电话：13912345678", "出生日期：1985年3月2日\n住址：北京市朝阳区建国路88号院(2号楼)1203室\n联系电话：13912345678")));
  // 法人写成“住所地”的也认
  assert.equal(parseParties(OLD_TEXT.replace("住所：", "住所地："))![0]!.fields.address, "上海市浦东新区张江路1288号3幢501室");
});

test("委托诉讼代理人：往返一致；只有写了姓名的写出；至多两名；授权范围与特别授权事项", () => {
  const text = serializeParties([plaintiff, defendant]);
  assert.deepEqual(text.split("\n").slice(9, 15), [
    "委托诉讼代理人一：张三（律师）",
    "执业机构：北京某某律师事务所",
    "执业证号：11101201510123456",
    "联系电话：13800001111",
    "授权范围：特别授权（代为承认、放弃、变更诉讼请求，进行和解，提起反诉、上诉）",
    "",
  ]);
  assert.deepEqual(parseParties(text), [plaintiff, defendant]);
  assert.equal(serializeParties(parseParties(text)!), text);

  const agents: PartyAgent[] = [
    { name: "赵敏", identity: "relative", fields: { relation: "配偶" }, scope: "general", powers: [] },
    { name: "钱七", identity: "recommended", fields: { org: "某某社区居民委员会", phone: "13700001111" }, scope: "special", powers: ["settle", "appeal"] },
  ];
  const withTwo: PartyEntry = { ...plaintiff, agents };
  const t2 = serializeParties([withTwo]);
  assert.ok(t2.includes("委托诉讼代理人二：钱七（社区、单位或社会团体推荐的公民）\n推荐单位：某某社区居民委员会\n联系电话：13700001111\n授权范围：特别授权（进行和解，提起上诉）"), t2);
  assert.deepEqual(parseParties(t2), [withTwo]);
  // 没写姓名的代理人不写出；空白一方只有代理人也写出这一方
  assert.equal(serializeParties([{ ...plaintiff, agents: [blankAgent(), ...agents] }]), t2);
  assert.equal(isBlankParty({ ...blankParty("third"), agents: [{ ...blankAgent(), name: "孙八" }] }), false);
  // 第三名：认不出（民诉法第六十一条至多两人）；序号跳号、两种称呼混用：认不出
  assert.equal(parseParties(t2.replace("授权范围：特别授权（进行和解，提起上诉）", "授权范围：特别授权（进行和解，提起上诉）\n委托诉讼代理人三：周九（律师）")), null);
  assert.equal(parseParties(t2.replace("委托诉讼代理人二：", "委托代理人二：")), null);
  assert.equal(parseParties(t2.replace("委托诉讼代理人一：", "委托诉讼代理人二：")), null);
  // 身份不认得的事项、授权范围写法认不出：null
  assert.equal(parseParties(t2.replace("与当事人关系：配偶", "执业机构：某所")), null);
  assert.equal(parseParties(t2.replace("特别授权（进行和解，提起上诉）", "特别授权（全权代理）")), null);
  // 只写“特别授权”不勾事项、不写授权范围：都可往返
  const bare: PartyEntry = { ...plaintiff, agents: [{ name: "张三", identity: "lawyer", fields: {}, scope: "special", powers: [] }, { name: "李五", identity: "staff", fields: { title: "法务经理" }, scope: "", powers: [] }] };
  assert.deepEqual(parseParties(serializeParties([bare])), [bare]);
  // 仲裁与非诉卡写“委托代理人”，材料里照它解析
  const arb = serializeParties([plaintiff], { agentLabel: "委托代理人" });
  assert.ok(arb.includes("委托代理人一：张三（律师）") && arb.includes("委托代理人：张三，北京某某律师事务所律师"));
  assert.deepEqual(parseParties(arb), [plaintiff]);
  assert.equal(agentLabelIn(arb), "委托代理人");
  assert.equal(agentLabelIn(text), "委托诉讼代理人");
  assert.equal(agentLabelIn(OLD_TEXT), null);
  assert.equal(powersText(["appeal", "admit", "counterclaim"]), "代为承认诉讼请求，提起反诉、上诉");
});

test("文书首部写法：照文书惯例逐方生成，代理人紧随其后；缺的写【待填】；解析时剥掉、核对与上面各项一致", () => {
  const text = serializeParties([plaintiff, defendant]);
  const block = text.split(PARTIES_HEADER_MARK + "\n")[1]!.trimEnd().split("\n");
  assert.deepEqual(block, [
    "原告：王超，男，汉族，1966年2月5日出生，公民身份号码110105196602051234，住北京市朝阳区建国路88号院2号楼1203室，联系电话13912345678。",
    "委托诉讼代理人：张三，北京某某律师事务所律师，执业证号11101201510123456，联系电话13800001111。",
    "被告：上海某某有限公司，统一社会信用代码91310115MA1H7K2X3Q，住所上海市浦东新区张江路1288号3幢501室，联系电话021-58881234。",
    "法定代表人：李四，执行董事。",
  ]);
  assert.deepEqual(headerLines([plaintiff, defendant]), block);
  // 其他组织：主要营业场所、主要负责人；称谓带一层括号；没有称谓、名称时写【待填】；更多里的事项填了才写
  const firm: PartyEntry = { side: "third", kind: "other_org", role: "上诉人（原审第三人）", name: "某某商贸合伙企业（有限合伙）", fields: { address: "杭州市余杭区文一西路969号", legal_rep: "周六", legal_rep_title: "执行事务合伙人" } };
  const person: PartyEntry = { side: "other", kind: "person", role: "", name: "", fields: { ethnicity: "回", employer: "某某医院", occupation: "医生", residence: "上海市徐汇区漕溪北路1号" }, agents: [{ name: "王小", identity: "relative", fields: { relation: "之子" }, scope: "", powers: [] }, { name: "陈工", identity: "staff", fields: {}, scope: "", powers: [] }] };
  assert.deepEqual(headerLines([firm, person]), [
    "上诉人（原审第三人）：某某商贸合伙企业（有限合伙），统一社会信用代码【待填】，主要营业场所杭州市余杭区文一西路969号，联系电话【待填】。",
    "主要负责人：周六，执行事务合伙人。",
    "【待填】：【待填】，性别【待填】，回族，出生日期【待填】，公民身份号码【待填】，某某医院医生，住址【待填】，经常居住地上海市徐汇区漕溪北路1号，联系电话【待填】。",
    "委托诉讼代理人：王小，系当事人之子。",
    "委托诉讼代理人：陈工，当事人工作人员。",
  ]);
  assert.ok(headerLines([{ ...person, fields: { employer: "某某医院" } }])[0]!.includes("，工作单位某某医院，"));
  assert.ok(headerLines([{ ...person, fields: { occupation: "退休" } }])[0]!.includes("，退休，"));
  const t3 = serializeParties([firm, person]);
  assert.ok(t3.includes("一、第三人（上诉人（原审第三人））：某某商贸合伙企业（有限合伙）（其他组织）\n主要营业场所：杭州市余杭区文一西路969号\n主要负责人：周六，职务：执行事务合伙人"), t3);
  assert.deepEqual(parseParties(t3), [firm, person]);
  // 其他组织写成“住所”的也认
  assert.equal(parseParties(t3.slice(0, t3.indexOf(PARTIES_HEADER_MARK)).replace("主要营业场所：", "住所："))?.[0]?.fields.address, "杭州市余杭区文一西路969号");
  // 首部写法被改过、上面各项改了没跟着改、后面加了备注：认不出（交给律师在原文上改，不静默丢改动）
  assert.equal(parseParties(text.replace("住北京市朝阳区", "住北京市海淀区")), null);
  assert.equal(parseParties(text.replace("住址：北京市朝阳区", "住址：北京市海淀区")), null);
  assert.equal(parseParties(`${text}备注：开庭前再核对\n`), null);
  // 整段删去首部写法：照旧格式解析，再保存重新生成
  const cut = text.slice(0, text.indexOf(PARTIES_HEADER_MARK));
  assert.deepEqual(parseParties(cut), [plaintiff, defendant]);
  assert.equal(serializeParties(parseParties(cut)!), text);
  // 号码写法统一：执业证号去空格转大写
  assert.equal(normalizePartyValue("license", " 1110 1201 5101 2345x "), "1110120151012345X");
});

test("完成度与清单：首部常用事项已填几项、缺哪几项；代理人一行；旧摘要不变", () => {
  assert.deepEqual(partyCompleteness(plaintiff), { filled: 6, expected: 6, missing: [] });
  assert.deepEqual(partyCompleteness(theirs), { filled: 3, expected: 6, missing: ["民族", "出生日期", "住址"] });
  assert.deepEqual(partyCompleteness({ ...defendant, fields: { uscc: "91310115MA1H7K2X3Q" } }), { filled: 1, expected: 5, missing: ["住所", "法定代表人", "职务", "联系电话"] });
  assert.deepEqual(partyCompleteness({ ...blankParty("third", "other_org"), name: "某合伙企业" }).missing, ["统一社会信用代码", "主要营业场所", "主要负责人", "职务", "联系电话"]);
  // 更多里的（经常居住地、职业、工作单位）不算缺
  assert.equal(partyCompleteness({ ...plaintiff, fields: { ...plaintiff.fields, occupation: "" } }).missing.length, 0);
  const digest = partiesDigest([plaintiff, { ...theirs, role: "" }, blankParty("third")]);
  assert.deepEqual(digest, [
    { role: "原告", side: "我方", name: "王超", kind: "自然人", filled: 6, expected: 6, missing: [], agents: [{ name: "张三", note: "北京某某律师事务所" }] },
    { role: "对方", side: "对方", name: "李秀英", kind: "自然人", filled: 3, expected: 6, missing: ["民族", "出生日期", "住址"], agents: [] },
  ]);
  assert.equal(agentsLine(digest[0]!.agents), "委托诉讼代理人：张三（北京某某律师事务所）");
  assert.equal(agentsLine([{ name: "张三", note: "律师" }, { name: "李四", note: "配偶" }], "委托代理人"), "委托代理人：张三（律师）、李四（配偶）");
  assert.equal(agentsLine([]), "");
  assert.equal(filledCount(plaintiff), 6);
});

test("称谓建议按卡与哪一方：一审、上诉、仲裁、劳动仲裁、保全、执行、非诉；第一次填时按卡确定的地位预填", () => {
  assert.deepEqual(roleSuggestions("pleading", "ours"), ["原告", "被告", "第三人"]);
  assert.deepEqual(roleSuggestions("pleading", "theirs"), ["被告", "原告", "第三人"]);
  assert.deepEqual(roleSuggestions("defense", "ours").slice(0, 1), ["被告"]);
  assert.deepEqual(roleSuggestions("appeal", "ours").slice(0, 3), ["上诉人（原审原告）", "上诉人（原审被告）", "上诉人（原审第三人）"]);
  assert.ok(roleSuggestions("appeal", "third").includes("原审第三人") && roleSuggestions("appeal", "theirs")[0] === "被上诉人（原审原告）");
  assert.deepEqual(roleSuggestions("arbitration-app", "theirs").slice(0, 1), ["被申请人"]);
  assert.deepEqual(roleSuggestions("labor-arb-defense", "ours").slice(0, 2), ["被申请人", "申请人"]);
  assert.deepEqual(roleSuggestions("preservation", "ours").slice(0, 2), ["申请人", "被申请人"]);
  assert.deepEqual(roleSuggestions("enforcement", "ours").slice(0, 2), ["申请执行人", "被执行人"]);
  assert.deepEqual(roleSuggestions("contract-draft", "ours").slice(0, 2), ["甲方", "乙方"]);
  assert.ok(roleSuggestions("demand-lit", "ours").includes("委托人"));
  assert.ok(roleSuggestions(null, "ours").includes("原告") && roleSuggestions(null, "ours").includes("申请人"), "事项概览给通用的一组");
  // 每张要首部的卡都有建议；没有重复
  for (const id of NEEDS_PARTIES_CARDS) for (const side of ["ours", "theirs", "third", "other"] as const) {
    const r = roleSuggestions(id, side);
    assert.ok(r.length > 0 && new Set(r).size === r.length, `${id} ${side}`);
  }
  // 预填：地位确定的卡按卡；上诉、合同等不确定的按立场（立场也没有就空着）
  assert.deepEqual(initialParties({ client_name: "甲公司", counterparty: "乙公司", stance: null }, "arbitration-app").map((p) => p.role), ["申请人", "被申请人"]);
  assert.deepEqual(initialParties({ client_name: "甲公司", counterparty: "乙公司", stance: "原告" }, "defense").map((p) => p.role), ["被告", "原告"]);
  assert.deepEqual(initialParties({ client_name: "甲公司", counterparty: "乙公司", stance: null }, "appeal").map((p) => p.role), ["", ""]);
  assert.deepEqual(initialParties({ client_name: "甲公司", counterparty: "乙公司", stance: "原告" }, "contract-draft").map((p) => p.role), ["原告", "被告"]);
  // 类型猜测：合伙企业、分公司是其他组织
  assert.deepEqual(initialParties({ client_name: "某某（上海）分公司", counterparty: "某某合伙企业（有限合伙）、张伟", stance: null }).map((p) => p.kind), ["other_org", "other_org", "person"]);
  // 代理人的称呼按卡
  assert.equal(agentLabelFor("pleading"), "委托诉讼代理人");
  assert.equal(agentLabelFor("arbitration-app"), "委托代理人");
  assert.equal(agentLabelFor("labor-arb-application"), "委托代理人");
  assert.equal(agentLabelFor("contract-draft"), "委托代理人");
  assert.equal(agentLabelFor(null, serializeParties([plaintiff], { agentLabel: "委托代理人" })), "委托代理人");
  assert.equal(agentLabelFor(null, null), "委托诉讼代理人");
});

test("内核令牌化用例的新格式样例与这里的序列化逐字相同（格式改了两边一起改）", () => {
  const src = readFileSync(fileURLToPath(new URL("../../../packages/kernel/test/b56-parties-tokenize.test.ts", import.meta.url)), "utf8");
  const m = /const TEXT_B64 = \[([\s\S]*?)\]\.join\("\\n"\);/.exec(src);
  assert.ok(m, "内核用例里的 TEXT_B64");
  const want = (JSON.parse(`[${m![1]!.trim().replace(/,\s*$/, "")}]`) as string[]).join("\n");
  const list: PartyEntry[] = [
    { ...plaintiff, fields: { ...plaintiff.fields, address: "北京市朝阳区建国路88号院(2号楼)1203室" }, agents: [{ name: "张明远", identity: "lawyer", fields: { org: "北京某某律师事务所", phone: "13800001111" }, scope: "special", powers: ["admit", "waive", "modify", "settle", "counterclaim", "appeal"] }] },
    { ...defendant, fields: { ...defendant.fields, legal_rep: "李建国" } },
  ];
  assert.equal(serializeParties(list), want);
  assert.deepEqual(parseParties(want), list);
});
