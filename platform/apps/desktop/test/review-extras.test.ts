/**
 * v9.4 第 20 批：表格审阅残余（按列排序、复核模式、据此起草、自建列）与工作台残余（批量接受边界、误报驳回、意见表 Word、对外版提示）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { draftLabel, nextOpenCell, sortDocs } from "../src/lib/table-review.ts";
import { batchEligible } from "../src/lib/workbench.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("按列排序：升、降、空值排后、同值保持原顺序；按材料名", () => {
  const docs = [
    { document_version_id: "a", filename: "乙.docx" },
    { document_version_id: "b", filename: "甲.docx" },
    { document_version_id: "c", filename: "丙.docx" },
  ];
  const val: Record<string, string> = { a: "2026-03", b: "", c: "2025-12" };
  const v = (d: { document_version_id: string }) => val[d.document_version_id]!;
  assert.deepEqual(sortDocs(docs, "x", 1, v).map((d) => d.document_version_id), ["c", "a", "b"]);
  assert.deepEqual(sortDocs(docs, "x", -1, v).map((d) => d.document_version_id), ["a", "c", "b"], "降序时空值仍在后");
  assert.deepEqual(sortDocs(docs, null, 1, v).map((d) => d.document_version_id), ["a", "b", "c"]);
  assert.equal(sortDocs(docs, "__doc", 1, v).length, 3);
});

test("复核模式：J/K 在未核格子间按行走，首尾相接；全核完返回 null", () => {
  const rows = [{ document_version_id: "a" }, { document_version_id: "b" }];
  const cols = [{ key: "x" }, { key: "y" }];
  const open = new Set(["a|y", "b|x"]);
  const isOpen = (d: string, c: string) => open.has(`${d}|${c}`);
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, null, 1), { doc: "a", col: "y" });
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, { doc: "a", col: "y" }, 1), { doc: "b", col: "x" });
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, { doc: "b", col: "x" }, 1), { doc: "a", col: "y" }, "首尾相接");
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, { doc: "a", col: "y" }, -1), { doc: "b", col: "x" });
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, null, -1), { doc: "b", col: "x" });
  assert.equal(nextOpenCell(rows, cols, () => false, null, 1), null);
});

test("据此起草的按钮按模板写；表格审阅有排序、复核模式、看原文前后、推为事实、加一列、去掉自建列（两步确认，不用原生确认框）", () => {
  assert.equal(draftLabel("evidence_list"), "据此起草证据目录");
  assert.equal(draftLabel("dd_contract_summary"), "据此起草尽调发现");
  assert.equal(draftLabel("contract_ledger"), "据此设到期提醒");
  const t = src("components/TableReview.tsx");
  for (const s of ["th-sort", "复核模式", "看原文前后", "推为事实", "加一列", "<ConfirmButton", "逐条确认"]) assert.ok(t.includes(s), s);
  assert.ok(!/window\.confirm|\bconfirm\(/.test(t), "不用浏览器原生确认框");
});

test("批量接受的边界与内核同一判定：只收提示级与前后不一致；重大、必须修改、缺失、需客户决定、没建议的不收", () => {
  const base = { status: "proposed", suggestion: "改为……", kind: "risk", needs_client_decision: false, nature: "should", severity: "low" };
  assert.equal(batchEligible(base), true);
  assert.equal(batchEligible({ ...base, severity: "mid" }), false);
  assert.equal(batchEligible({ ...base, severity: "mid", kind: "consistency" }), true);
  assert.equal(batchEligible({ ...base, severity: "high", kind: "consistency" }), false);
  assert.equal(batchEligible({ ...base, nature: "must" }), false);
  assert.equal(batchEligible({ ...base, kind: "missing" }), false);
  assert.equal(batchEligible({ ...base, needs_client_decision: true }), false);
  assert.equal(batchEligible({ ...base, suggestion: " " }), false);
  assert.equal(batchEligible({ ...base, status: "accepted" }), false);
  // 与内核判定逐行一致
  const kernel = readFileSync(new URL("../../../packages/kernel/src/services/review-cards.ts", import.meta.url), "utf8");
  const body = (s: string) => /export function batchEligible[\s\S]*?\): boolean \{([\s\S]*?)\n\}/.exec(s)![1]!.replace(/\s+/g, " ").replace(/!!c\.needs_client_decision/g, "c.needs_client_decision").trim();
  assert.equal(body(src("lib/workbench.ts")), body(kernel));
});

test("工作台：批量勾选与撤回本批、缺失卡“误报：其实有”、意见表 Word、对外版的可见提示", () => {
  const w = src("components/ReviewWorkbench.tsx");
  for (const s of ["接受所选", "撤回本批", "误报：其实有", "驳回并记住", "意见表 Word", "对外版只有修订，不带批注、理由、规则号和底线"]) assert.ok(w.includes(s), s);
});

test("对方改动模式：有基线时可切“只看对方改动”，每处并排我方原稿与对方改稿，卡上三个动作（接受对方 / 恢复我方 / 改用退让文本）", () => {
  const w = src("components/ReviewWorkbench.tsx");
  for (const s of ["只看对方改动", "我方原稿", "对方改稿", "静默改动", "接受对方", "恢复我方", "改用退让文本", "api.counterChanges"]) assert.ok(w.includes(s), s);
  assert.ok(/counter\?\.available && \(/.test(w), "没有基线时不出切换");
});

test("入口：整理案卷精读版接 casefile-organize（视角作方法参数）；即将推出只灰显不能发起；工作台处理完直达修订说明；金额测算可选 LPR 倍数与劳动补偿", async () => {
  const { SCENARIOS, COMING_SOON, buildGoal } = await import("../src/lib/scenarios.ts");
  const deep = SCENARIOS.find((c) => c.id === "casefile-deep")!;
  assert.equal(deep.skill, "casefile-organize");
  assert.equal(buildGoal(deep, {}, ""), "请逐份精读本事项的案卷材料，编目、按时间整理事实（每条附原文）并列出缺口。", "视角没填整句省略");
  assert.match(buildGoal(deep, { perspective: "按付款线索" }, ""), /时间线按“按付款线索”排列/);
  // v9.4 第 21 批：原来灰显的八项都有了方法与场景卡，清空；以后再有灰显项时，仍不得与已有卡同名
  assert.equal(COMING_SOON.length, 0);
  assert.ok(COMING_SOON.every((x) => !SCENARIOS.some((c) => c.title === x.title)));
  for (const t of ["起草上诉状", "起草仲裁申请书", "庭审提纲", "财产保全申请", "强制执行申请", "股东会与董事会文件", "交割清单", "规章制度审查"]) assert.ok(SCENARIOS.some((c) => c.title === t && c.skill), t);
  assert.ok(src("pages/Home.tsx").includes("COMING_SOON.some((x) => x.line === line) &&"), "为空时首页不显示“即将推出”一行");
  assert.ok(src("pages/Methods.tsx").includes('aria-disabled="true"'));
  assert.ok(src("pages/Home.tsx").includes("即将推出："));
  assert.ok(src("components/ReviewWorkbench.tsx").includes("/start/redline-notes/${matterId}"));
  const amount = SCENARIOS.find((c) => c.id === "amount")!;
  assert.ok(amount.fields.some((f) => (f.options ?? []).includes("LPR 倍数（如上浮 50%）")));
});

test("管理员层说法（U1 §2.7）：控制面、吊销、连接器、白名单、出站闸门、中继、中软客服换成管理员说法；问答首句先说能做什么；开通页不写“中软”", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "")).join("\n");
  for (const f of ["components/MembersAdmin.tsx", "pages/FirmUsage.tsx", "lib/firm-usage.ts", "pages/Activate.tsx"]) {
    const hits = strip(src(f)).match(/控制面|吊销|连接器|白名单|出站闸门|中继|中软客服/g) ?? [];
    assert.deepEqual(hits, [], f);
  }
  const conn = strip(src("pages/Connections.tsx"));
  assert.deepEqual(conn.match(/控制面|吊销|连接器|白名单|出站闸门|中软客服/g) ?? [], [], "Connections（数据去向说明里的“中软”保留）");
  assert.ok(!/中软/.test(strip(src("pages/Activate.tsx"))), "开通页");
  const chat = src("pages/Chat.tsx");
  assert.ok(chat.includes("一般法律问题直接问"));
  assert.ok(!chat.includes("中软安全通道"));
});

test("输入框模式（U1 §1.2）：胶囊只写一个短语；“先给我看计划 / 直接做”与“每步问我 / 放手做 / 只问答”并列成一张单选表", async () => {
  const { modeChipLabel, modeOptions } = await import("../src/lib/mode-options.ts");
  assert.equal(modeChipLabel({ mode: "default", planFirst: true }), "先给我看计划");
  assert.equal(modeChipLabel({ mode: "default", planFirst: false }), "直接做");
  assert.equal(modeChipLabel({ mode: "auto", planFirst: true }), "放手做");
  assert.deepEqual(modeOptions(["manual", "default"]).map((o) => o.key), ["plan", "direct", "manual"]);
  assert.ok(!src("components/ModeSelector.tsx").includes("· 先给我看计划") && src("components/ModeSelector.tsx").includes("modeChipLabel(value)"));
  assert.ok(src("components/Composer.tsx").includes('blockedReason === "先写任务目标" ? "" : blockedReason'), "只缺目标时不重复写");
});

test("执行页两栏（U1 §3.2）：没有左栏，材料收成标题下的“材料 n 份 ▾”；字号按用途令牌（--fs-sm 不超过 40 处，正文类用 --fs-body）", () => {
  const rv = src("pages/RunView.tsx");
  assert.ok(!rv.includes('className="exec-left"'));
  assert.ok(rv.includes('className="mats-chip-wrap"'));
  const css = src("styles.css");
  assert.ok((css.match(/font-size: var\(--fs-sm\)/g) ?? []).length <= 40);
  for (const sel of [".muted {", ".field {", ".banner {"]) assert.match(css, new RegExp(`\\n\\${sel}[^}]*font-size: var\\(--fs-body\\)`), sel);
  const tokens = readFileSync(new URL("../../../packages/design-tokens/src/tokens.css", import.meta.url), "utf8");
  for (const t of ["--fs-meta", "--fs-caption", "--fs-body", "--fs-reading", "--fs-h1"]) assert.ok(tokens.includes(`${t}:`), t);
});

test("恢复我方只替换锚点那一截：条款号等前后文不重复写入；前后也被改了就不给按钮", async () => {
  const { restoreOursText } = await import("../src/lib/workbench.ts");
  assert.equal(restoreOursText("8.1 买方应于验收合格后九十日内支付货款。", "8.1 买方应于验收合格后三十日内支付货款。", "买方应于验收合格后九十日内支付货款。"), "买方应于验收合格后三十日内支付货款。");
  assert.equal(restoreOursText("8.2 逾期付款的，按日万分之五支付违约金。", "8.2 逾期付款的，按日万分之三支付违约金。", "按日万分之五支付违约金"), "按日万分之三支付违约金");
  assert.equal(restoreOursText("9.1 甲方应于九十日内付款。", "8.1 甲方应于三十日内付款。", "甲方应于九十日内付款。"), null, "条款号也改了：对不上");
  assert.equal(restoreOursText("新增一段。", "", "新增一段。"), null, "对方新增的段落没有我方原稿");
});

test("批量接受后“撤回本批”仍在（走查发现：本批接受完已没有可勾的卡，整行曾被隐藏）", () => {
  const w = src("components/ReviewWorkbench.tsx");
  assert.ok(w.includes("|| (lastBatch?.ids.length ?? 0) > 0) && ("), "有本批就显示这一行");
});

test("新成果类型有中文名：意见表 Word 版、证据目录与尽调发现按文件名（去扩展名）", async () => {
  const { artifactName, ARTIFACT_LABELS } = await import("../src/lib/labels.ts");
  assert.equal(artifactName({ kind: "review_table_docx", filename: "采购合同（审查意见表）.docx" }), "采购合同（审查意见表）");
  assert.equal(artifactName({ kind: "evidence_index", filename: "证据目录（证据清单）.docx" }), "证据目录（证据清单）");
  for (const k of ["review_table_docx", "evidence_index", "dd_findings"]) assert.ok(ARTIFACT_LABELS[k], k);
});
