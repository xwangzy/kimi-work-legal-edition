/** V16 第 41 批界面精修：任务时间线不露引擎英文与本机路径、同类步骤合并计次、修改文书只预选 Word 等（见 research/2026-11-10-V16产品体验精修/04）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSteps, isMethodReference, lawyerToolDescription, mergeRepeatSteps, toolLabel } from "../src/lib/timeline.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
let id = 0;
const ev = (type: string, payload: any) => ({ event_id: ++id, seq: id, type, payload, created_at: "2026-11-10T10:00:00+08:00" }) as any;

/** 真实界面里看到的那一条（截图原文）。 */
const REAL = "Searching for '^#|买卖|设备|技术服务|运维|保证|软件|知识产权|数据' in /private/tmp/kwl-x/kap-trusted/ewKUNTlZFKjOak78/skills/contract-review/references/contract-types.md";

test("V16 A1：检索方法参考资料的英文自述与本机路径不进律师层，标题改“查阅方法参考资料”并收进处理细节", () => {
  assert.equal(lawyerToolDescription("Grep", REAL), undefined);
  assert.ok(isMethodReference("Grep", REAL));
  const steps = buildSteps([ev("agent.tool_started", { tool: "Grep", tool_call_id: "g1", description: REAL }), ev("agent.tool_result", { tool_call_id: "g1" })]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.title, "查阅方法参考资料");
  assert.equal(steps[0]!.level, "detail");
  assert.equal(steps[0]!.detail, undefined);
  for (const s of steps) assert.doesNotMatch(`${s.title}${s.detail ?? ""}${s.meta ?? ""}`, /Searching|\/private|kap-trusted|skills/);
});

test("V16 A1：引擎内置工具的自述一律不显示；含路径或英文动词开头的说明不显示；中文说明照常显示", () => {
  for (const t of ["Read", "Glob", "Grep", "Bash", "Write", "Edit"]) assert.equal(lawyerToolDescription(t, "读取合同第三条"), undefined, t);
  assert.equal(lawyerToolDescription("mcp__legal__law_search", "Reading 民法典 第 577 条"), undefined);
  assert.equal(lawyerToolDescription("mcp__legal__law_search", "查 /Users/a/b/合同.docx 里的违约条款"), undefined);
  assert.equal(lawyerToolDescription("mcp__legal__law_search", "查 C:\\Users\\a\\合同.docx"), undefined);
  assert.equal(lawyerToolDescription("mcp__legal__law_search", "检索买卖合同违约金调整的规定"), "检索买卖合同违约金调整的规定");
  assert.equal(lawyerToolDescription("mcp__legal__law_search", "Word 文书里的违约条款"), "Word 文书里的违约条款", "英文名词开头（不是动词）不误伤");
  // 读事项材料（不在方法目录）仍是律师层“阅读材料”
  const steps = buildSteps([ev("agent.tool_started", { tool: "Read", tool_call_id: "r1", description: "Reading /private/tmp/x/materials/合同.txt" })]);
  assert.deepEqual([steps[0]!.title, steps[0]!.level, steps[0]!.detail], ["阅读材料", "lawyer", undefined]);
});

test("V16 A2：Read 与 materials.read_excerpt 同叫“阅读材料”；连续查条文合成一行并写次数", () => {
  assert.equal(toolLabel("Read"), toolLabel("mcp__legal__materials_read_excerpt"));
  const events: any[] = [];
  for (let i = 0; i < 8; i++) events.push(ev("agent.tool_started", { tool: "mcp__legal__law_get_article", tool_call_id: `a${i}` }), ev("agent.tool_result", { tool_call_id: `a${i}` }));
  events.push(ev("agent.tool_started", { tool: "Read", tool_call_id: "r" }), ev("agent.tool_result", { tool_call_id: "r" }));
  events.push(ev("agent.tool_started", { tool: "mcp__legal__materials_read_excerpt", tool_call_id: "m" }), ev("agent.tool_result", { tool_call_id: "m" }));
  events.push(ev("agent.tool_started", { tool: "mcp__legal__calc_interest", tool_call_id: "c1" }), ev("agent.tool_result", { tool_call_id: "c1" }));
  events.push(ev("agent.tool_started", { tool: "mcp__legal__calc_interest", tool_call_id: "c2" }), ev("agent.tool_result", { tool_call_id: "c2" }));
  events.push(ev("agent.tool_started", { tool: "mcp__legal__law_search", tool_call_id: "s1" }), ev("agent.tool_result", { tool_call_id: "s1" }));
  const titles = mergeRepeatSteps(buildSteps(events)).filter((s) => s.level === "lawyer").map((s) => s.title);
  assert.deepEqual(titles, ["查看条文原文（8 条）", "阅读材料", "计算利息与违约金（2 次）", "检索法规"]);
});

test("V16 A2：中间夹着处理细节（查阅方法参考资料）不打断合并", () => {
  const events = [
    ev("agent.tool_started", { tool: "mcp__legal__law_get_article", tool_call_id: "a" }),
    ev("agent.tool_started", { tool: "Grep", tool_call_id: "g", description: REAL }),
    ev("agent.tool_started", { tool: "mcp__legal__law_get_article", tool_call_id: "b" }),
  ];
  const lawyer = mergeRepeatSteps(buildSteps(events)).filter((s) => s.level === "lawyer");
  assert.deepEqual(lawyer.map((s) => s.title), ["查看条文原文（2 条）"]);
});

test("V16 A4：按你的意见修改文书没有 Word 时不预选、说明原因并禁用开始；其它卡预选不变", async () => {
  const { preselectDocs, wordDocGap, SCENARIOS } = await import("../src/lib/scenarios.ts");
  const card = (cid: string) => SCENARIOS.find((c) => c.id === cid)!;
  const txt = [{ document_version_id: "t", filename: "采购合同.txt" }];
  assert.deepEqual(preselectDocs(card("doc-revise"), txt), []);
  assert.equal(wordDocGap(card("doc-revise"), txt, []), "本事项还没有 Word 文书，请先添加要修改的那份（.docx）");
  assert.match(wordDocGap(card("doc-revise"), txt, ["t"])!, /还没有 Word 文书/, "手动勾了 .txt 也不能开始");
  const mixed = [...txt, { document_version_id: "w", filename: "采购合同.DOCX" }];
  assert.deepEqual(preselectDocs(card("doc-revise"), mixed), ["w"]);
  assert.equal(wordDocGap(card("doc-revise"), mixed, ["w"]), null);
  assert.match(wordDocGap(card("doc-revise"), mixed, ["t"])!, /请勾选/);
  assert.equal(wordDocGap(card("contract-review"), txt, []), null);
  assert.deepEqual(preselectDocs(card("casefile"), mixed), ["t", "w"]);
  const ui = src("components/ScenarioStart.tsx");
  assert.match(ui, /!wordGap && missing\.length === 0/, "缺 Word 时开始按钮保持禁用");
  assert.match(ui, /\{wordGap && <div className="ss-need">\{wordGap\}<\/div>\}/);
});

test("V16 A3：确认卡、提问卡不再粘在中栏（不盖住页眉与任务说明），新卡出现时滚到卡片顶部", () => {
  const css = src("styles.css");
  assert.doesNotMatch(css, /\.interactions \{[^}]*position: sticky/);
  const rv = src("pages/RunView.tsx");
  assert.match(rv, /className="interactions" ref=\{cardsRef\}/);
  assert.match(rv, /cardsRef\.current\?\.scrollIntoView\?\.\(\{ block: "start"/);
  assert.match(rv, /outlineRef\.current\?\.scrollIntoView/);
});

test("V16 A5：开始前确认的用量说明缩成一行、原话进“了解更多”；发送要点每行不超过 26 字；先看计划时“做什么”多半句", async () => {
  const { usageNoteShort, sendPointShort, freeTaskWhat } = await import("../src/lib/sheet-text.ts");
  const kernel = ["这类任务有单任务用量上限，到了会先停下来问你", "因软件或服务出错没做完的不计入用量；你中途取消的，只计已经做完的部分"];
  const u = usageNoteShort(kernel);
  assert.equal(u.line, "到上限会先停下来问你；出错没做完的不计");
  assert.deepEqual(u.more, kernel);
  assert.deepEqual(usageNoteShort(["别的说明"]), { line: "别的说明", more: [] });
  const bullets = [
    "发给 Kimi AI（经中软转发）：3 份材料里用到的内容",
    "发给 Kimi AI（经中软转发）：任务说明和用到的材料",
    "姓名、证件号、账号、电话先换成代号",
    "姓名、公司名、证件号、账号先换成代号",
    "公司名、案情、金额、日期、条款按原文；没认出的姓名也按原文",
    "案情、金额、日期、条款按原文；没认出的姓名也按原文",
    "联网检索先去掉当事人名称；要带名称查时逐条问你",
    "服务方是否保存，以其企业协议为准；每次发送都有记录",
    "发给律所自己的 Kimi 账号（不经中软）：3 份材料里用到的内容",
  ];
  for (const b of bullets) assert.ok([...sendPointShort(b).replace(/ /g, "")].length <= 26, `${sendPointShort(b)}`);
  assert.match(sendPointShort(bullets[4]!), /没认出的姓名也按原文/, "按原文发送的风险句不能缩掉");
  assert.equal(freeTaskWhat(true), "按你的描述处理（助手会选用合适的方法，开始前先给你看计划）");
  assert.equal(freeTaskWhat(false), "按你的描述处理");
});

test("V16 V-3：旧的 .btn 类已全部换成 .btn-ghost 并删除；提交动作不再是链接样式", () => {
  const css = src("styles.css");
  assert.doesNotMatch(css, /(^|\n)\.btn \{/);
  const files = ["pages/Connections.tsx", "components/TeamShare.tsx", "pages/FirmUsage.tsx", "App.tsx", "components/RunSheet.tsx"];
  for (const f of files) assert.doesNotMatch(src(f), /className="btn( |")|`btn /, f);
  const c = src("pages/Connections.tsx");
  assert.match(c, /className="btn-ghost btn-sm" disabled=\{busy\} onClick=\{\(\) => act\(\(\) => api\.controlPlaneSync\(\)/, "立即同步");
  assert.match(c, />\s*核对无误，确认\s*</);
  assert.match(c, /label="发布" danger=\{false\} className="btn-primary btn-sm"/);
  assert.match(c, />\s*生成草稿\s*</);
  assert.doesNotMatch(c, /30 位数字|目前没有网页控制台|核对无误，签名/);
});

test("V16 IA-1：设置五个分区；旧地址落到新分区；提示里的“设置 → …”用新名称", async () => {
  const app = src("App.tsx");
  assert.match(app, /export type SettingsTab = "general" \| "writing" \| "account" \| "backup" \| "visibility" \| "admin";/);
  assert.match(app, /if \(a === "device"\) return "backup";/);
  assert.match(app, /if \(a === "sources" \|\| a === "data"\) return "visibility";/);
  assert.match(app, /nav\("\/connections\/backup"\)/);
  const c = src("pages/Connections.tsx");
  for (const l of ["通用", "文书与写作", "账号与团队", "备份与安全", "数据去向"]) assert.match(c, new RegExp(`: "${l}",`), l);
  assert.doesNotMatch(c.slice(0, c.indexOf("function AdminTab(")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), /即将推出/, "设置不列“即将推出”");
  for (const f of ["lib/errors.ts", "components/MembersAdmin.tsx", "lib/offboarding.ts", "App.tsx"]) assert.doesNotMatch(src(f).replace(/\/\/.*$/gm, ""), /本机与安全(?!”）→)/, f);
  assert.match(src("lib/errors.ts"), /设置 → 备份与安全/);
  assert.doesNotMatch(src("components/RecoveryBackup.tsx") + src("pages/Activate.tsx"), /<span>开发形态/);
});

test("V16 F1～F6：出具法律意见书新卡；劳动者卡改名；催告函与股东会文件交付物；审合同可选同时出建议修订稿；只交附件的原因", async () => {
  const { SCENARIOS, NEXT_STEPS, buildGoal, skillArgsOf } = await import("../src/lib/scenarios.ts");
  const card = (cid: string) => SCENARIOS.find((c) => c.id === cid)!;
  const op = card("legal-opinion");
  assert.equal(op.skill, "client-advice");
  assert.equal(op.primary, "法律意见书（草稿）.docx");
  assert.equal(op.general, true);
  assert.deepEqual(NEXT_STEPS["legal-opinion"], ["audience-pack"]);
  assert.equal(buildGoal(op, { question: "担保是否有效" }, ""), "请就以下问题出具正式的法律意见书（Word），签署栏留空：担保是否有效。");
  assert.ok(!card("compliance-qa").intents.some((w) => w.join() === "法律意见"));
  assert.equal(card("labor-apply").title, "劳动者请求梳理与金额测算");
  assert.equal(card("demand-inhouse").fields.find((f) => f.key === "letter_type")!.options![0], "先帮我判断该走哪条路径");
  assert.equal(card("demand-lit").gets[1], "依据与发送前核对.xlsx");
  assert.equal(card("corporate-resolutions").gets[0], "决议（草稿）.docx");
  for (const id of ["contract-review", "contract-review-inhouse"]) {
    const c = card(id);
    const base = buildGoal(c, { type: "买卖", redline: "不用，先看审查意见" }, "");
    assert.doesNotMatch(base, /建议修订稿/, id);
    assert.ok(!("redline" in skillArgsOf(c, { type: "买卖", redline: "不用，先看审查意见" })));
    assert.match(buildGoal(c, { type: "买卖", redline: "要：按审查意见直接在原件上写修订" }, ""), /审查意见出完后，按必须修改与建议修改的意见在原件上写一份建议修订稿（修订痕迹）。$/);
  }
  assert.match(src("lib/timeline.ts"), /only_attachments: "助手只交了附件，没有交出主文书，可以在本任务里追问补出"/);
  assert.match(src("components/Cards.tsx"), /<textarea className="q-other"/, "提问卡“其他”改多行");
});
