/**
 * v9.4 第 26 批（精修）界面：任务名用场景卡名、方法名不带内部档位、成果名不带扩展名也不把一句话当标题、
 * 合同类型按文件名预选、时间线不重复“使用方法模板”且不写退出码、开始面板与确认卡的按钮贴底、确认卡要点按性质用不同记号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("任务名：场景卡发起的用卡名；自由描述的用描述前 30 字、去掉句末标点；都没有用场景名", async () => {
  const { runName } = await import("../src/lib/labels.ts");
  // 走查：执行页标题曾是拼好的任务说明“请审查这份买卖合同，我方立场以事项为准；”
  assert.equal(runName({ title: "审合同", goal: "请审查这份买卖合同，我方立场以事项为准；重点看付款。" }), "审合同");
  assert.equal(runName({ input_snapshot: { title: "整理案卷", goal: "x" } }), "整理案卷", "执行页从快照里取");
  assert.equal(runName({ goal: "请审查这份买卖合同，我方立场以事项为准；" }), "请审查这份买卖合同，我方立场以事项为准", "老任务没有卡名：去掉句末分号");
  assert.equal(runName({ goal: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三" }), "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十…");
  assert.equal(runName({ goal: "  ", scenario: "s2.case_file" }), "整理案卷");
  assert.equal(runName(null), "任务");
  assert.equal(runName({ goal: "一二三四五六七八九十一二三四五六七八九十一二", title: null }, 20), "一二三四五六七八九十一二三四五六七八九十…", "看板用 20 字");
});

test("任务名接到各处：执行页、首页继续工作、看板、事项 AI 记录、搜索、发起时把卡名交给内核", () => {
  assert.match(read("../src/pages/RunView.tsx"), /function runTitle\(run: any\): string \{\s*return runName\(run\);/);
  assert.match(read("../src/pages/Home.tsx"), /<span className="today-text">\{runName\(r\)\}<\/span>/);
  assert.match(read("../src/pages/Boards.tsx"), /\{runName\(r, 20\)\}/);
  assert.match(read("../src/pages/Matter.tsx"), /r\.title \? r\.title :/);
  assert.match(read("../src/lib/search.ts"), /title: x\.title \? x\.title :/);
  assert.match(read("../src/components/RunSheet.tsx"), /\.\.\.\(p\.label \? \{ title: p\.label \} : \{\}\)/);
});

test("方法名：去掉“· 试用（通用辅助）”“（受限文书）”“（风险卡）”，保留律师有用的括注", async () => {
  const { methodName } = await import("../src/lib/labels.ts");
  assert.equal(methodName("合同审查（风险卡）· 试用（通用辅助）"), "合同审查");
  assert.equal(methodName("民事起诉状（受限文书）"), "民事起诉状");
  assert.equal(methodName("民事上诉状（受限文书）· 试用"), "民事上诉状");
  assert.equal(methodName("案情分析与诉讼策略（内部稿）"), "案情分析与诉讼策略（内部稿）");
  assert.equal(methodName("表格审阅（逐格带出处）· 试用"), "表格审阅（逐格带出处）");
  const { methodLine } = await import("../src/lib/run-method.ts");
  assert.equal(methodLine({ input_snapshot: { skill: "contract-review", skill_version: "1.4.0" } }, { "contract-review": "合同审查（风险卡）· 试用（通用辅助）" }, {}), "方法：合同审查 · v1.4.0（任务开始时的版本）");
});

test("时间线：调用方法模板收进处理细节，下一行写“按《合同审查》的方法处理”；本机计算不写退出码与毫秒", async () => {
  const { buildSteps } = await import("../src/lib/timeline.ts");
  const at = "2026-10-24T09:00:00+08:00";
  const steps = buildSteps(
    [
      { event_id: 1, seq: 1, type: "agent.tool_started", payload: { tool: "Skill", tool_call_id: "c1" }, created_at: at },
      { event_id: 2, seq: 2, type: "agent.skill", payload: { skill: "contract-review" }, created_at: at },
      { event_id: 3, seq: 3, type: "agent.exec.finished", payload: { exit_code: 0, duration_ms: 2300, commit: { written: 2, deleted: 0 } }, created_at: at },
      { event_id: 4, seq: 4, type: "agent.exec.finished", payload: { exit_code: 1 }, created_at: at },
    ] as never,
    { "contract-review": "合同审查（风险卡）· 试用（通用辅助）" },
  );
  assert.equal(steps.find((s) => s.title === "使用方法模板")?.level, "detail");
  assert.equal(steps.filter((s) => s.level === "lawyer").map((s) => s.title).join("|"), "按《合同审查》的方法处理");
  assert.equal(steps[2]!.title, "本机计算完成（用时 2 秒）");
  assert.equal(steps[2]!.detail, "写入 2 个文件，删除 0 个");
  assert.equal(steps[3]!.title, "本机计算出错");
  assert.ok(steps.every((s) => !/退出码|ms|工作区提交|方法模板《/.test(`${s.title}${s.detail ?? ""}`)));
});

test("成果名：没有内容标题时去掉扩展名；助手草稿的第一行是一句话时用固定名称", async () => {
  const { artifactName } = await import("../src/lib/labels.ts");
  assert.equal(artifactName({ kind: "agent_report", filename: "案情时间线（草稿）.docx", title: null }), "案情时间线（草稿）");
  assert.equal(artifactName({ kind: "a1_workspace_file", filename: "计算表.xlsx" }), "计算表");
  assert.equal(artifactName({ kind: "a1_agent_draft", filename: "回复.md", title: "时间线草稿已生成。" }), "助手草稿");
  assert.equal(artifactName({ kind: "a1_agent_draft", filename: "回复.md", title: "法律研究备忘录" }), "法律研究备忘录（草稿）", "真正的标题照用");
  assert.equal(artifactName({ kind: "a1_agent_draft_partial", filename: "回复.md", title: "已提交三张审查意见卡，请在审查工作台逐条处理。" }), "助手草稿（部分完成）");
});

test("合同类型按文件名预选：先具体后宽泛，文件名优先于事项名，猜不出不选", async () => {
  const { guessContractType } = await import("../src/lib/scenarios.ts");
  assert.equal(guessContractType(["设备采购合同.docx"]), "买卖");
  assert.equal(guessContractType(["甲公司股权转让协议.docx"]), "股权转让");
  assert.equal(guessContractType(["A 轮增资协议.docx"]), "投资协议（增资 / 股权收购）");
  assert.equal(guessContractType(["软件开发合同.docx"]), "技术开发", "技术开发先于服务");
  assert.equal(guessContractType(["技术服务协议.docx"]), "服务 / 技术服务");
  assert.equal(guessContractType(["员工保密协议.docx"]), "保密与竞业限制");
  assert.equal(guessContractType(["厂房租赁合同.docx"]), "租赁");
  assert.equal(guessContractType(["合同.docx"], "庚公司采购合同审查"), "买卖", "文件名猜不出时看事项名");
  assert.equal(guessContractType(["租赁合同.docx"], "庚公司采购合同审查"), "租赁", "文件名优先");
  assert.equal(guessContractType(["协议.docx"], "甲公司事项"), null);
  // 预选只填律师没选过的、文字写明“按文件名预选，可改”；律师改了就不再显示
  const ss = read("../src/components/ScenarioStart.tsx");
  assert.match(ss, /按文件名预选，可改/);
  assert.match(ss, /if \(!typeField \|\| !docsReady \|\| values\[typeField\.key\]\) return;/);
  assert.match(ss, /const setField = \(k: string, v: string \| string\[\]\) => \{\s*setGuessed\(null\);/);
});

test("开始面板与确认卡：底部按钮贴底（1280×720 不用滚到底才看到“开始”）；还不能开始时按钮左边写缺什么", () => {
  assert.match(read("../src/components/ScenarioStart.tsx"), /<div className="modal-actions modal-actions-sticky">\s*\{!ready && !busy/);
  assert.match(read("../src/components/RunSheet.tsx"), /<div className="modal-actions modal-actions-sticky">/);
  assert.match(read("../src/styles.css"), /\.modal-actions-sticky \{ position: sticky; bottom: 0;/);
});

test("确认卡要点：按性质用不同记号（换成代号打勾、按原文发送橙点、经谁转发箭头），不再一律绿勾", () => {
  // 第 27 批（评审 U3-01）：要点抽成共用组件 SendPoints，确认卡与开始面板都用它
  assert.match(read("../src/components/SendPoints.tsx"), /data-kind=\{dataWhere\?\.bullet_kinds\?\.\[i\] \?\? undefined\}/);
  assert.match(read("../src/components/RunSheet.tsx"), /<SendPoints dataWhere=\{estimate\.data_where\}>/);
  const css = read("../src/styles.css");
  for (const k of ["route", "plain", "keep", "blocked"]) assert.match(css, new RegExp(`\\.sheet-points li\\[data-kind="${k}"\\]::before`), k);
});

test("管理 · 技术支持 · 诊断（U2-13/14/15/16）：首层律师话与本机功能一览；研发台账只在开发形态显示；执行域等说法收进“技术信息（给 IT）”；角色中文；技术版表格不溢出", () => {
  const c = read("../src/pages/Connections.tsx");
  const diag = c.slice(c.indexOf("function DiagnosticsTab"), c.indexOf("function TechnicalVisibility"));
  assert.match(diag, /本机功能一览/);
  assert.match(diag, /\{import\.meta\.env\.DEV && caps && caps\.rows\.length > 0 && \(/, "能力账本只在开发形态");
  assert.equal((diag.match(/caps\.rows\.map/g) ?? []).length, 1, "能力账本只渲染一处（在开发形态分支里）");
  const firstLayer = diag.slice(0, diag.indexOf("技术信息（给 IT）"));
  assert.doesNotMatch(firstLayer.replace(/\/\/.*$/gm, ""), /执行域|渲染进程|MXC|唯一出口|已拉起|P2|P3/, "首层不写研发说法");
  assert.match(diag, /DEVICE_ROLE_LABELS\[String\(d\.role\)\] \?\? "成员"/);
  assert.match(c, /const DEVICE_ROLE_LABELS: Record<string, string> = \{ firm_admin: "管理员", admin: "管理员"/);
  assert.match(read("../src/styles.css"), /table\.data\.visibility-table \{ table-layout: fixed; \}/);
});

test("核对码三义归一（U2-06/07）：本所识别码 / 本机核对码（34 位，4 位一组带组序号）/ 入组核对码（12 位）；“安全码”“律所核对码”不再出现", () => {
  const files = ["../src/pages/Connections.tsx", "../src/components/MembersAdmin.tsx", "../src/pages/Activate.tsx"].map(read);
  for (const f of files) {
    const visible = f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(visible, /安全码|律所核对码|本所核对码/);
    for (const m of visible.matchAll(/(.{0,3})核对码/g)) assert.ok(/本机$|入组$/.test(m[1]!) || /^(本机|入组)/.test(m[0]), `“核对码”要连着“本机 / 入组”：${m[0]}`);
  }
  assert.match(files[0]!, /<summary>本所识别码<\/summary>/);
  assert.match(files[0]!, /function SafetyCode\(/);
  assert.match(read("../src/styles.css"), /\.safety-group b \{ font-size: var\(--fs-reading\);/);
});

test("单机使用（U2-08）：没加入律所时不显示离所交接、本机核对码；环境自检不自动展开、可复制给 IT（U2-11）", () => {
  const c = read("../src/pages/Connections.tsx");
  assert.match(c, /const inFirm = !!firm\?\.firm\?\.name \|\| cp\?\.mode === "control_plane";/);
  assert.match(c, /\{inFirm \? \(\s*<>\s*<TeamShare admin=\{admin\} \/>\s*<DepartedMembers \/>/);
  assert.match(c, /未加入律所。要和同事共享事项，请向律所管理员要邀请码。/);
  assert.doesNotMatch(c, /open=\{envWarn > 0\}/);
  assert.match(c, /复制给 IT 的说明/);
});

test("文书版式（U2-01/02/03）：标签 | 控件网格、一种分段控件、页码是开关、律所模板是“版式来源”的一项、只有一个主按钮、改了没保存标“未保存”", () => {
  const d = read("../src/components/DocStyle.tsx");
  assert.match(d, /className="settings-grid"/);
  assert.doesNotMatch(d, /type="checkbox"/);
  assert.match(d, /role="switch" aria-checked=\{draft\.page_numbers\}/);
  assert.equal((d.match(/btn-primary/g) ?? []).length, 1);
  assert.match(d, /aria-label="版式来源"/);
  assert.doesNotMatch(d, /q-option/, "不再用另一种分段样式");
  assert.match(d, /\{dirty && <span className="pill pill-orange unsaved">未保存<\/span>\}/);
  const css = read("../src/styles.css");
  // 标签顶对齐并按控件高度补上距：控件下面有说明时标签仍对着控件（实测各行中线差 ≤ 1px）
  assert.match(css, /\.settings-grid \{ display: grid; grid-template-columns: 88px minmax\(0, 1fr\);[^}]*align-items: start;/);
  assert.match(css, /\.settings-grid > \.sg-k \{[^}]*line-height: 22px; padding-top: 5px; \}/);
  const wp = read("../src/components/WritingPrefs.tsx");
  assert.match(wp, /className="settings-grid"/, "写作偏好同一张网格");
  assert.match(wp, /disabled=\{busy \|\| !dirty\}/, "没改动时保存不可点");
  assert.match(css, /\.device-k \{ color: var\(--text-primary\); font-weight: 500; \}/);
});

test("两步确认（U2-21）：放弃按钮缺省“取消”；说明超过 20 字改成对话框；危险操作的确认按钮红色实心", async () => {
  const cb = read("../src/components/ConfirmButton.tsx");
  assert.match(cb, /\{p\.keepLabel \?\? "取消"\}/);
  assert.doesNotMatch(cb.replace(/\/\*[\s\S]*?\*\//g, ""), /"不了"/);
  assert.match(cb, /if \(\[\.\.\.p\.question\]\.length > INLINE_QUESTION_MAX\) \{[\s\S]*<Modal title=/);
  assert.match(cb, /export const INLINE_QUESTION_MAX = 20;/);
  assert.match(read("../src/styles.css"), /\.btn-danger-solid \{ background: var\(--status-danger-solid\);/);
});

test("开始前确认回显（U2-23）：任务说明原文两行以内；材料列出至多 3 个文件名，多了写“等 n 份”", async () => {
  const { materialsLine } = await import("../src/lib/labels.ts");
  assert.equal(materialsLine(0), "没有指定：按需读取本事项的材料");
  assert.equal(materialsLine(2, ["签收单.txt", "合同.docx"]), "签收单.txt、合同.docx");
  assert.equal(materialsLine(5, ["a.docx", "b.docx", "c.docx", "d.docx", "e.docx"]), "a.docx、b.docx、c.docx 等 5 份");
  assert.equal(materialsLine(2), "2 份", "老调用点没给文件名时只写份数");
  const rs = read("../src/components/RunSheet.tsx");
  assert.match(rs, /<div className="sheet-goal" title=\{value\.goal\.trim\(\)\}>/);
  assert.match(read("../src/pages/Home.tsx"), /prepareStart\(matter, v, \{ docNames: docs\.filter/);
});

test("律所策略与资料来源（U2-17/39）：合伙人看得懂的说法；联网检索首层一句、完整规则放“了解更多”", () => {
  const c = read("../src/pages/Connections.tsx");
  const policy = c.slice(c.indexOf("function relaxationText"));
  const code = policy.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /最严模板|标准端点|L3a）|抓取允许|运行通道|泛化后放行|设备签名`/);
  assert.match(code, /const MODE_TEXT: Record<string, string> = \{ chat: "只问答", manual: "每步问我", default: "标准", auto: "放手做" \};/);
  assert.match(c, /note: "默认去掉当事人名称再查；要带名称查时逐条问你", more: "含当事人名称的查询须经办律师逐条确认/);
  assert.doesNotMatch(c, /"IM 收件"|所内节点原型/);
});

test("场景卡（评审 S2 §3）：律师函字段键与方法参数 letter_type 一致；收到劳动仲裁申请书时提示改用“劳动仲裁应对”；劳动、管辖、上诉、执行补齐关键字段", async () => {
  const { SCENARIOS, fieldRedirect, skillArgsOf, getsPlain } = await import("../src/lib/scenarios.ts");
  const card = (id: string) => SCENARIOS.find((c) => c.id === id)!;
  const lit = card("demand-lit");
  assert.ok(lit.fields.some((f) => f.key === "letter_type") && !lit.fields.some((f) => f.key === "purpose"));
  assert.equal(skillArgsOf(lit, { letter_type: "向保证人主张权利通知" }).letter_type, "向保证人主张权利通知", "参数名就是方法声明的 letter_type");
  assert.deepEqual(lit.fields.find((f) => f.key === "letter_type")!.options, ["催款律师函", "履行催告函", "解除前催告函", "解除通知", "向保证人主张权利通知", "停止侵权函"]);
  const sr = card("suit-received");
  assert.equal(fieldRedirect(sr, { doc_kind: "劳动仲裁申请书" })?.card.id, "labor-response");
  assert.equal(fieldRedirect(sr, { doc_kind: "民事起诉状" }), null);
  assert.equal(sr.args?.side, "已被诉");
  assert.ok(card("labor-response").fields.some((f) => f.key === "received_on"));
  assert.ok(card("labor-termination").fields[0]!.options!.includes("试用期间被证明不符合录用条件"));
  assert.ok(card("procedure").fields.some((f) => f.key === "side"));
  assert.ok(card("appeal").fields.some((f) => f.key === "domicile"));
  assert.ok(card("enforcement").fields.some((f) => f.key === "due_on"));
  assert.deepEqual(getsPlain(card("casefile")), ["证据目录", "事实时间轴", "争点证据矩阵（框架）", "补证清单"], "你得到什么不写扩展名");
  assert.match(read("../src/pages/Home.tsx"), /key=\{starting\.card\.id\}/, "换卡时重新挂载，上一张卡的字段不带过去");
});

test("弹窗里再弹两步确认时，Esc 只关最上面一个（结案与删除、当事人名单、期限提醒都在弹窗里用长说明确认）", () => {
  const m = read("../src/components/Modal.tsx");
  assert.match(m, /if \(e\.key === "Escape" && isTopModal\(openStack, me\)\) onClose\(\);/);
  assert.match(m, /openStack\.push\(me\);/);
  // 挂到 document.body：祖先样式（如 .alias-chip button）不再改掉弹窗里的按钮（走查：“确定停用”曾是蓝色文字）
  assert.match(m, /return createPortal\(\s*<div className="modal-mask"[\s\S]*document\.body,\s*\);/);
  assert.match(m, /export function isTopModal\(stack: readonly object\[\], me: object\): boolean \{\s*return stack\[stack\.length - 1\] === me;/);
});
