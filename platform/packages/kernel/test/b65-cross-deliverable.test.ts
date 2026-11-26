/**
 * 第 65 批：跨交付件一致性核对（V39 研究 R2 第 5.2 节 X1、X5）。
 * - X5 依据角色冲突：m25-r4 劳动仲裁答辩——答辩书以《员工手册（2021版）》为解除依据，证据目录与核对清单写它“不作为依据”，须报出两处原句；
 *   “主张 + 备位”、同一文件内自己作区分、转述他方、条款级否定、法律名称、风险提示不报。
 * - X1 证据编号与名称：同一编号指向另一份证据的报出（必须改）；名称近似、带当事人前缀、编号区间不报；两份目录同一编号对不上的报出。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AmountDoc } from "../src/services/amount-check.ts";
import { checkCrossDeliverables, crossFindings, runCrossIssues } from "../src/services/cross-deliverable-check.ts";
import { MACHINE_BASIS } from "../src/executor/amount-reconcile.ts";

const docx = (filename: string, paras: string[], heading = "答辩意见"): AmountDoc => ({
  filename,
  kind: "docx",
  paragraphs: paras.map((text, i) => ({ where: `${heading} 第 ${i + 1} 段`, text })),
  rows: [],
});

const CAT_COLS = ["证据编号", "证据名称", "证据来源", "页数", "原件或复印件", "证明目的", "对应请求或答辩项", "备注"];
const catalog = (filename: string, rows: [string, string, string?][], sheet = "证据目录"): AmountDoc => ({
  filename,
  kind: "xlsx",
  rows: rows.map(([no, name, purpose], i) => ({ where: `${sheet} 第 ${i + 2} 行`, columns: CAT_COLS, cells: [no, name, "公司", "【待填】", "复印件", purpose ?? "", "第一项", null] })),
});

const CHECK_COLS = ["序号", "核对项", "要求", "当前状态", "依据或来源", "责任人", "结论"];
const checklist = (filename: string, rows: [string, string][]): AmountDoc => ({
  filename,
  kind: "xlsx",
  rows: rows.map(([state, verdict], i) => ({ where: `提交前核对 第 ${i + 2} 行`, columns: CHECK_COLS, cells: [i + 1, "规章制度版本", "逐版核对", state, "劳动合同法第四条", "法务部", verdict] })),
});

// m25-r4 三份最终文件里的相反句子（原句节选）
const R4_ANSWER = docx("劳动仲裁答辩书.docx", [
  "申请人入职时签收的《员工手册（2021版）》第5.3条第（5）项曾规定，连续旷工3日以上（含）即属于严重违反规章制度。该版手册经职工大会讨论、与工会协商后发布，申请人已于入职时签收。申请人连续三日旷工，符合该条规定的解除条件。（证据2：2021版员工手册、制定程序及签收材料）",
]);
const R4_CATALOG = catalog("证据目录-澜栖公司劳动仲裁答辩.xlsx", [
  ["证据1", "劳动合同（2024年续订）", "证明劳动关系、工资构成及源代码保密义务。"],
  ["证据2", "《员工手册（2021版）》相关条款、职工大会讨论与工会协商材料、员工签收记录", "证明2021版手册经职工大会讨论、与工会协商后发布，申请人于入职时签收，知悉连续旷工3日以上（含）的违纪后果；仅作为知悉情况的辅助证据，不作为行为时直接适用的解除制度依据。"],
  ["证据3", "考勤与工资明细（2024年9月至2026年9月，含年休假台账）", "证明加班小时、年休假及旷工扣款。"],
]);
const R4_CHECKLIST = checklist("提交前核对清单-澜栖公司劳动仲裁答辩.xlsx", [
  ["主依据选2021版连续旷工3日支；2023版程序有缺口，不作直接依据。", "2021版手册已自2023年6月1日起废止，不作为行为时直接适用的解除依据。答辩以未经批准连续三日旷工构成严重违反基本劳动纪律及《劳动合同》第五条为主。"],
]);

test("X5：m25-r4 答辩书以 2021 版手册为解除依据、证据目录与核对清单写它不作为依据——报出两处原句；答辩书与证据目录一起递交，作必须改（主会话第 65 批）", () => {
  const issues = checkCrossDeliverables([R4_ANSWER, R4_CATALOG, R4_CHECKLIST]);
  const role = issues.filter((i) => i.key.startsWith("role|"));
  assert.equal(role.length, 1, JSON.stringify(issues, null, 1));
  const i = role[0]!;
  assert.equal(i.must, true, "作依据的答辩书与写“不作为依据”的证据目录一起递交：裁判者两份都看得到");
  assert.equal(i.filename, "劳动仲裁答辩书.docx");
  assert.match(i.key, /手册@2021/);
  assert.match(i.text, /符合该条规定的解除条件/);
  assert.match(i.problem, /员工手册（2021版）/);
  assert.match(i.problem, /证据目录-澜栖公司劳动仲裁答辩\.xlsx》证据目录 第 3 行“证明目的”列“[^”]*不作为行为时直接适用的解除制度依据/);
  assert.match(i.problem, /提交前核对清单-澜栖公司劳动仲裁答辩\.xlsx》提交前核对 第 2 行“结论”列“2021版手册已自2023年6月1日起废止，不作为行为时直接适用的解除依据/);
  // 核对清单自己“主依据选 2021 版”与“不作为依据”并存：它不作为依据一方另报（同一文件内两种角色不报）
  assert.ok(!issues.some((x) => x.filename.startsWith("提交前核对清单") && x.key.startsWith("role|")));
  // 证据 2 的简称“2021版员工手册、制定程序及签收材料”与目录名称近似，不报编号问题
  assert.ok(!issues.some((x) => x.must && !x.key.startsWith("role|")), JSON.stringify(issues, null, 1));
});

test("X5：答辩书改成与附件同一口径后，同一 key 不再出现（修改后重跑判断是否落实）", () => {
  const fixed = docx("劳动仲裁答辩书.docx", [
    "申请人入职时签收的《员工手册（2021版）》第5.3条第（5）项曾规定，连续旷工3日以上（含）即属于严重违反规章制度，申请人对旷工的违纪后果是明知的。答辩人以未经批准连续三日旷工违反基本劳动纪律及《劳动合同》第五条为解除依据。（证据2：2021版员工手册、制定程序及签收材料）",
  ]);
  const before = checkCrossDeliverables([R4_ANSWER, R4_CATALOG, R4_CHECKLIST]).map((i) => i.key);
  const after = checkCrossDeliverables([fixed, R4_CATALOG, R4_CHECKLIST]).map((i) => i.key);
  assert.ok(before.some((k) => k.startsWith("role|")));
  assert.deepEqual(after.filter((k) => k.startsWith("role|")), []);
});

test("X5：正当的“主张 + 备位”（即使 / 退一步 / 如……不被采纳）不报", () => {
  const answer = docx("答辩书.docx", [
    "答辩人主要依据《员工手册（2023版）》第5.3条第（6）项作出解除决定。即使仲裁委认为2023版制定程序存在瑕疵，依据《员工手册（2021版）》第5.3条第（5）项，申请人连续三日旷工亦符合解除条件。",
    "退一步讲，如上述意见不被采纳，按照2021版手册第5.3条第（5）项，申请人的行为同样构成严重违纪。",
  ]);
  const list = checklist("核对清单.xlsx", [["2023版为主依据；2021版不作为直接解除依据，仅作备位。", "庭前统一口径"]]);
  const issues = checkCrossDeliverables([answer, list]);
  assert.deepEqual(issues, []);
});

test("X5：转述他方、引号里的原话、条款级否定、法律名称、风险提示、同一文件内自作区分——都不报", () => {
  const answer = docx("答辩书.docx", [
    "解除通知援引《员工手册（2023版）》第5.3条第（6）项作为解除依据。",
    "申请人主张应依据《员工手册（2021版）》第4.2条计算年休假。",
    "解除通知载明：“依据《员工手册（2023版）》第5.3条第（11）项，公司决定解除劳动合同。”",
    "依据《员工手册（2023版）》第5.3条第（6）项，申请人连续三日旷工构成严重违纪。",
    "依据《中华人民共和国劳动合同法》第三十九条第（二）项，答辩人可以解除劳动合同。",
    "《竞业限制协议》第三条约定的补偿标准作为本案计算依据；《竞业限制协议》第八条不作为本案依据。",
  ]);
  const list = checklist("核对清单.xlsx", [
    ["《员工手册（2023版）》第4.6条不适用于法定年休假工资。", "2021版不作为直接解除依据。"],
    ["《中华人民共和国劳动合同法》第四十条不适用。", "2023版相关条款存在不能作为确定双方权利义务依据的风险。"],
    ["《竞业限制协议》第八条不作为本案依据。", "待律师确认"],
  ]);
  const issues = checkCrossDeliverables([answer, list]);
  // 2021 版：只在申请人主张里出现（转述）；2023 版：第5.3条作依据，核对清单只否定第4.6条（条号不同）；
  // 劳动合同法：法律不比；竞业限制协议：答辩书依据第三条，两份文件否定的都是第八条
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 1));
});

test("X5：同一文件内对同一范围两种角色都有（文件自己在作区分，或自相矛盾留给模型复核）不作为依据一方；只否定另一条或部分条款的不妨碍", () => {
  const answer = docx("答辩书.docx", [
    "《员工手册（2021版）》不作为本案直接解除依据，仅证明申请人知悉旷工后果。申请人连续三日旷工，符合《员工手册（2021版）》第5.3条第（5）项规定的解除条件。",
    "《竞业限制协议》第三条约定的补偿标准作为本案计算依据；《竞业限制协议》第八条不作为本案依据。",
  ]);
  const list = checklist("核对清单.xlsx", [["2021版不作为直接解除依据。", "《竞业限制协议》不作为本案依据。"]]);
  const issues = checkCrossDeliverables([answer, list]);
  // 2021 版：答辩书自己对整份手册写了“不作为依据”，不报；竞业限制协议：答辩书只否定第八条、依据第三条，核对清单否定整份——报
  assert.deepEqual(issues.map((i) => i.key), ["role|竞业限制协议@|答辩书.docx"]);

  // 只否定“其余条款”“信息安全条款”的（范围不确定），不当作对整份文件的否定：答辩书依据第5.3条、核对清单否定整份——报
  const partial = docx("答辩书.docx", ["《员工手册（2021版）》第5.3条第（5）项作为本案解除依据；2021版其余条款已废止，不作为本案依据。"]);
  assert.deepEqual(checkCrossDeliverables([partial, list]).map((i) => i.key), ["role|手册@2021|答辩书.docx"]);
  const partialNeg = checklist("核对清单.xlsx", [["不以2021版信息安全条款为依据，以劳动合同为依据。", "—"]]);
  assert.deepEqual(checkCrossDeliverables([partial, partialNeg]), []);
});

test("X5：答辩书依据 2023 版第5.3条，核对清单写 2023 版整体不作为直接依据——报出（m25-r2 形态）", () => {
  const answer = docx("答辩书.docx", ["就旷工行为，答辩人依据的是《员工手册（2023版）》第5.3条第（6）项。"]);
  const list = checklist("核对清单.xlsx", [["以2021版旷工条款为主依据；2023版不作为直接依据。", "—"]]);
  const issues = checkCrossDeliverables([answer, list]);
  assert.equal(issues.length, 1, JSON.stringify(issues, null, 1));
  assert.equal(issues[0]!.key, "role|手册@2023|答辩书.docx");
  assert.match(issues[0]!.problem, /2023版不作为直接依据/);
});

const CATALOG5 = catalog("证据目录.xlsx", [
  ["证据1", "劳动合同（2024年续订）"],
  ["证据2", "《员工手册（2021版）》相关条款及员工签收记录"],
  ["证据3", "考勤与工资明细（含年休假台账）"],
  ["证据4", "OA年休假申请及审批记录、2026年8月14日人力资源部否决邮件"],
  ["证据5", "竞业限制协议（2021年3月1日）"],
]);

test("X1：正文“证据N”的名称在目录里是另一个编号——必须改；目录里没有的编号对上了别的证据——必须改", () => {
  const answer = docx("答辩书.docx", [
    "答辩人已按约支付竞业限制补偿。（证据4：竞业限制协议）",
    "申请人负有竞业限制义务，见证据9《竞业限制协议》。",
  ]);
  const issues = checkCrossDeliverables([answer, CATALOG5]);
  assert.equal(issues.length, 2, JSON.stringify(issues, null, 1));
  assert.ok(issues.every((i) => i.must && i.filename === "答辩书.docx"));
  const [a, b] = issues;
  assert.match(a!.problem, /证据4：竞业限制协议/);
  assert.match(a!.problem, /证据目录里证据4是“OA年休假申请/);
  assert.match(a!.problem, /证据5/);
  assert.match(a!.fix, /证据5/);
  assert.match(b!.problem, /证据目录里没有证据9/);
});

test("X1：名称近似（简称、目录名称包含正文名称、只写其中几项）不报；当事人前缀、编号区间不比", () => {
  const answer = docx("答辩书.docx", [
    "劳动合同第五条约定了保密义务。（证据1：劳动合同；证据3：考勤与工资明细）",
    "（证据2：2021版员工手册、制定程序及签收材料）",
    "（证据4：OA申请审批记录及否决邮件）",
    "证据1《劳动合同》第五条明确约定。证据5：竞业限制协议第三条。",
    "申请人证据3《竞业限制协议》系复印件。原告证据2《劳动合同》不能证明其主张。",
    "证据1至3：劳动合同、员工手册及考勤明细。证据2、证据4：竞业限制协议及审批记录。",
    "证据4：第3页。",
  ]);
  assert.deepEqual(checkCrossDeliverables([answer, CATALOG5]), []);
});

test("X1：两份证据目录是同一套编号时，同一编号名称对不上的报出；对方证据的质证表（不同一套编号）不比", () => {
  // 答辩书附页里的证据清单（docx 表格）与证据目录表：1～3 对得上，4 对不上
  const annex: AmountDoc = {
    filename: "答辩书.docx",
    kind: "docx",
    paragraphs: [],
    rows: [
      ["证据1", "劳动合同"],
      ["证据2", "员工手册（2021版）及签收记录"],
      ["证据3", "考勤与工资明细"],
      ["证据4", "竞业限制协议"],
    ].map((cells, i) => ({ where: `证据清单 表格第 ${i + 1} 行`, columns: ["证据编号", "证据名称"], cells })),
  };
  const issues = checkCrossDeliverables([annex, CATALOG5]);
  assert.equal(issues.length, 1, JSON.stringify(issues, null, 1));
  assert.match(issues[0]!.key, /^evcat\|/);
  assert.ok(issues[0]!.must);
  assert.match(issues[0]!.problem, /证据4/);

  const crossExam: AmountDoc = {
    filename: "质证意见表.xlsx",
    kind: "xlsx",
    rows: [
      ["证据1", "设备买卖合同及技术协议"],
      ["证据2", "设备验收单"],
      ["证据3", "设备性能检测报告"],
      ["证据4", "微信聊天记录摘录"],
    ].map((cells, i) => ({ where: `质证意见 第 ${i + 2} 行`, columns: ["证据编号", "证据名称", "对方证明目的", "真实性意见"], cells: [...cells, "", ""] })),
  };
  assert.deepEqual(checkCrossDeliverables([crossExam, CATALOG5]), []);
});

test("X1：有标题行的表格（表头落在第一行格里）也认得出证据目录", () => {
  const titled: AmountDoc = {
    filename: "证据目录.xlsx",
    kind: "xlsx",
    rows: [
      { where: "证据目录 第 2 行", columns: ["上海澜栖公司证据目录", null], cells: ["证据编号", "证据名称"] },
      { where: "证据目录 第 3 行", columns: ["上海澜栖公司证据目录", null], cells: ["证据1", "劳动合同"] },
      { where: "证据目录 第 4 行", columns: ["上海澜栖公司证据目录", null], cells: ["证据2", "竞业限制协议"] },
    ],
  };
  const issues = checkCrossDeliverables([titled, docx("答辩书.docx", ["（证据1：竞业限制协议）"])]);
  assert.equal(issues.length, 1, JSON.stringify(issues, null, 1));
  assert.match(issues[0]!.problem, /证据2/);
});

test("接线：crossFindings 必须改 / 建议改分级、依据栏与金额勾稽同一写法；runCrossIssues 出错返回空", () => {
  const issues = checkCrossDeliverables([R4_ANSWER, R4_CATALOG, R4_CHECKLIST, docx("其他.docx", ["（证据3：竞业限制协议）"])]);
  const f = crossFindings(issues, 4);
  assert.equal(f[0]!.no, 4);
  assert.ok(f.every((x) => x.basis === MACHINE_BASIS && x.machine_key.length > 0));
  assert.deepEqual(
    f.map((x) => [x.must, x.level]),
    issues.map((i) => [i.must, i.must ? "must" : "should"]),
  );
  const broken = { db: { all: () => { throw new Error("db closed"); } }, blobs: {} } as unknown as Parameters<typeof runCrossIssues>[0];
  assert.deepEqual(runCrossIssues(broken, "run_x", "mat_x"), []);
});

test("X5：作依据的是递交文书、只有内部核对清单写“不作为依据”的，同样必须改（第 65 批真实验收 v39-m25：须核时修改轮没改核对清单）", () => {
  const onlyNeg = checklist("提交前核对清单-澜栖公司劳动仲裁答辩.xlsx", [["已核对版本。", "2021版手册已自2023年6月1日起废止，不作为行为时直接适用的解除依据。"]]);
  const issues = checkCrossDeliverables([R4_ANSWER, onlyNeg]);
  const role = issues.filter((i) => i.key.startsWith("role|"));
  assert.equal(role.length, 1, JSON.stringify(issues, null, 1));
  assert.equal(role[0]!.must, true);
});

test("X5：作依据的一方是内部件（核对清单、说明）时仍为须核", () => {
  const memo = docx("案情分析备忘录（内部稿）.docx", ["2. 本案旷工解除的主依据为《员工手册（2021版）》第5.3条第（5）项。"]);
  const onlyNeg = checklist("提交前核对清单-澜栖公司劳动仲裁答辩.xlsx", [["已核对版本。", "2021版手册已自2023年6月1日起废止，不作为行为时直接适用的解除依据。"]]);
  const role = checkCrossDeliverables([memo, onlyNeg]).filter((i) => i.key.startsWith("role|"));
  assert.ok(role.every((i) => i.must === false), JSON.stringify(role));
});

test("X5：申请书里叙述被申请人依据某版手册解除（v39-m18 真实误报）不算我方作依据；答辩书里我方自己依据的照常认", () => {
  const app = docx("劳动仲裁申请书.docx", ["2026年9月4日，被申请人以申请人于8月17日至19日旷工3日、8月21日私自上传源代码至个人网盘为由，依据《员工手册（2023版）》第5.3条第（6）项、第（11）项解除劳动合同。"], "事实与理由");
  const list = checklist("提交前核对清单-劳动者违法解除争议.xlsx", [["已核对。", "《员工手册（2023版）》未见职工讨论及工会协商记录，不作为我方认可的解除依据。"]]);
  assert.equal(checkCrossDeliverables([app, list]).filter((i) => i.key.startsWith("role|")).length, 0);
  const ans = docx("劳动仲裁答辩书.docx", ["申请人于8月17日起连续三日未到岗，答辩人依据《员工手册（2021版）》第5.3条第（5）项解除劳动合同。"]);
  const neg = checklist("证据目录-澜栖公司劳动仲裁答辩.xlsx", [["已核对。", "2021版手册已废止，不作为行为时直接适用的解除依据。"]]);
  assert.equal(checkCrossDeliverables([ans, neg]).filter((i) => i.key.startsWith("role|")).length, 1, "答辩人自己依据的，叙述对方的前半句不影响");
});
