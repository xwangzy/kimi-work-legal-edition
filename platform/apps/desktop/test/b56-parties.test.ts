// D-224 当事人信息：事项里存一次的一份材料《当事人信息（律师填写）.txt》，要写身份首部的卡自动带入。
// 序列化 / 解析往返、摘要与“已填几项”、needsParties 清单与卡片一致、与案情说明同一勾选口径、当前版本的认定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  blankParty,
  currentPartiesDoc,
  filledCount,
  initialParties,
  normalizePartyValue,
  parseParties,
  PARTIES_FILENAME,
  PARTIES_HEAD,
  PARTIES_PREFIX,
  partiesShort,
  partiesSummary,
  serializeParties,
  withPartiesDoc,
  type PartyEntry,
} from "../src/lib/parties.ts";
import { buildGoal, NEEDS_PARTIES_CARDS, SCENARIOS } from "../src/lib/scenarios.ts";

const ours: PartyEntry = { side: "ours", kind: "org", role: "原告", name: "华诚贸易有限公司", fields: { uscc: "91310115MA1H7K2X3Q", address: "上海市浦东新区张江路1288号3幢501室", legal_rep: "王建国", legal_rep_title: "执行董事", phone: "021-58881234" } };
const theirs: PartyEntry = { side: "theirs", kind: "person", role: "被告", name: "李秀英", fields: { gender: "女", id_number: "110105198503021241", phone: "13912345678" } };

test("序列化：固定格式、没填的项不写出、整方都空的不写出", () => {
  const text = serializeParties([ours, theirs, blankParty("third")]);
  assert.equal(
    text,
    [
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
  assert.ok(start.includes("withPartiesDoc(v.documentIds") && start.includes("未填，文书首部会留【待填】"));
  assert.ok(src("../src/components/MatterOverview.tsx").includes("还没有填当事人信息——起诉状、律师函等文书的首部会留【待填】"));
  assert.ok(src("../src/components/PartiesInfo.tsx").includes("importMaterialText(matter.matter_id, PARTIES_FILENAME, text, prev)"), "新版本取代上一版");
  assert.ok(src("../../../packages/kernel/src/executor/executor.ts").includes(`PARTIES_MATERIAL_PREFIX = "${PARTIES_PREFIX}"`));
});
