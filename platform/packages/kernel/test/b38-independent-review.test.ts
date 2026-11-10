/**
 * V13 第 38 批：独立复核。主任务交出 Word 文书后，内核另起一次不带起草上下文的模型调用复核（只看委托原话、材料与交付件），
 * 意见登记为《独立复核意见》并交回原会话：助手逐条核对、用 docx.edit_draft 改正、重写最终答复。
 * 根因（V9.6～V10 共 18 份独立律师评分 13～18 分，“分析深度”多为 1 分）：方法里写了自查清单，模型在同一上下文里自查照样漏——复核要换一双眼睛，
 * 而且是工作流里必走的一步，不由模型临场决定做不做。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b38-review-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importBytes, makeKernel, waitRun, waitRunAnswering, type TestKernel } from "./helpers.ts";
import { questionAnswerLines } from "../src/executor/kap-agent-client.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { parseFindings, fixPrompt, reviewMessages, reviewNote } from "../src/services/independent-review.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b38-review-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000" }, "b38-review-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const REVIEWER = "现在独立复核";

async function startRun(marker: string) {
  const { matter } = await tk.inv("matters.create", {
    title: `复核测试 ${marker}`,
    stance: "买方",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
    model_endpoint: "standard",
  });
  const doc = await importBytes(tk.inv, matter.matter_id, "交易条款清单.txt", Buffer.from("设备：压装设备一台。价款：人民币120万元，验收合格后10日内一次付清。", "utf8"), "text/plain");
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  return tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b38-${marker}-${Date.now()}`, goal: `${marker} 起草设备买卖合同，价款120万元`, skill: "contract-draft", document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
}

/** 主任务出一份合同；复核调用回 reviewText；交回修改那一轮先用 edit_draft 把 100 万改成 120 万再写答复。 */
function script(marker: string, reviewText: string, seen: { review: Record<string, unknown>[]; fixUser: string[] }) {
  return (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(REVIEWER)) {
      seen.review.push(body);
      return { content: reviewText };
    }
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes(marker)) return null;
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    const inFix = users.some((u) => u.includes("【独立复核】"));
    const render = ms.find((m) => m.role === "tool" && m.tool_call_id === "render_1");
    if (!render) {
      return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "设备买卖合同", sections: [{ heading: "第一条 标的", paragraphs: ["1.1 买方向卖方购买压装设备一台。"] }, { heading: "第二条 价款", paragraphs: ["2.1 价款为人民币100万元。"] }] } }] };
    }
    if (!inFix) return { content: "已起草《设备买卖合同》。" };
    seen.fixUser.push(users.at(-1) ?? "");
    if (!ms.some((m) => m.role === "tool" && m.tool_call_id === "edit_1")) {
      const id = /artv_[0-9a-f-]+/.exec(JSON.stringify(render.content ?? ""))?.[0];
      return { toolCalls: [{ id: "edit_1", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: "价款为人民币100万元", proposed_text: "价款为人民币120万元" }] } }] };
    }
    return { content: "已按独立复核意见改正。\n\n独立复核处理情况：\n1｜已改（第 2.1 款价款改为 120 万元）" };
  };
}

test("交出文书后独立复核：复核调用不带起草上下文，意见登记为《独立复核意见》，交回原会话改正后出新版本", { timeout: 180_000 }, async () => {
  const seen = { review: [] as Record<string, unknown>[], fixUser: [] as string[] };
  cloud.model.script = script("B38REV", "【1】第二条｜价款写成 100 万元，与委托的 120 万元不一致｜委托原话：价款120万元｜2.1 改为“价款为人民币120万元”｜必须改", seen);
  try {
    const run = await startRun("B38REV");
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types));
    // 复核调用：只有系统与用户两条消息（不带起草过程），用户消息里有委托原话、材料与交付件文字
    assert.equal(seen.review.length, 1);
    const rm = msgs(seen.review[0]!);
    assert.deepEqual(rm.map((m) => m.role), ["system", "user"]);
    const u = String(rm[1]!.content);
    assert.match(u, /委托原话[\s\S]*B38REV/);
    assert.match(u, /待复核交付件[\s\S]*价款为人民币100万元/);
    assert.equal(/mcp__legal__|tool_call/.test(u), false, "复核提示里没有起草过程的工具调用");
    // V13 W2 真实走查：没给文件清单与最终答复时，复核人误报“没交修订稿”“其他问题没列给律师”
    assert.match(u, /本任务已交出的文件[\s\S]*设备买卖合同\.docx/);
    assert.match(u, /助手给律师的最终答复[\s\S]*已起草《设备买卖合同》/);
    const completed = done.events.find((e: any) => e.type === "review.completed");
    assert.equal(completed?.payload.findings, 1);
    assert.equal(completed?.payload.must, 1);
    assert.ok(types.includes("review.fix_started") && types.includes("review.fix_outcome"), JSON.stringify(types));
    assert.equal(done.events.find((e: any) => e.type === "review.fix_outcome")?.payload.status, "succeeded");
    // V16 第 41 批：修改轮新登记的交付件版本数如实记录（合同第 2 版），不再只记“文件数”（那是最终答复）
    assert.equal(done.events.find((e: any) => e.type === "review.fix_outcome")?.payload.revised, 1);
    assert.equal(done.events.find((e: any) => e.type === "run.succeeded")?.payload.remaining, undefined, "改出了新版本，不提示");
    // 交回修改的提示带着复核意见原文，材料快照照样在（宿主每轮重写材料区）
    assert.match(seen.fixUser.at(-1) ?? "", /【独立复核】[\s\S]*价款写成 100 万元/);
    assert.match(seen.fixUser.at(-1) ?? "", /本事项材料快照/);
    // V16 第 41 批：修改轮提示列出要改的文件与成果编号（不靠会话记忆找文件），并写明不要换文件名另起一份
    const firstVersion = done.artifacts.find((a: any) => a.kind === "agent_report" && a.filename === "设备买卖合同.docx" && a.version === 1);
    assert.ok(firstVersion, "有合同第 1 版");
    assert.ok((seen.fixUser.at(-1) ?? "").includes(`《设备买卖合同.docx》——用 docx.edit_draft，成果编号 ${firstVersion.artifact_version_id}`), seen.fixUser.at(-1) ?? "");
    assert.match(seen.fixUser.at(-1) ?? "", /不要换标题或文件名另起一份/);
    assert.match(u, /材料：[^\n]*交易条款清单[\s\S]*验收合格后10日内/, "复核提示里有材料原文");
    // 成果：复核意见、合同第 2 版（120 万）、最终答复新版本
    const note = done.artifacts.find((a: any) => a.kind === "a1_review_note");
    assert.ok(note, "有《独立复核意见》");
    const contracts = done.artifacts.filter((a: any) => a.kind === "agent_report" && a.filename === "设备买卖合同.docx");
    assert.equal(contracts.length, 2, "合同有复核后的新版本");
    const replies = done.artifacts.filter((a: any) => a.kind === "a1_agent_draft");
    assert.equal(replies.length, 2, "最终答复有复核后的新版本");
    const latest = await tk.inv("artifacts.download", { artifact_version_id: contracts.at(-1).artifact_version_id });
    const { readZipText } = await import("@zr-legal/docx-engine");
    assert.match((readZipText(Buffer.from(latest.data_base64, "base64"), "word/document.xml") ?? "").replace(/<[^>]+>/g, ""), /价款为人民币120万元/);
    const md = await tk.inv("artifacts.download", { artifact_version_id: note.artifact_version_id });
    assert.match(Buffer.from(md.data_base64, "base64").toString("utf8"), /独立复核意见[\s\S]*必须改/);
  } finally {
    cloud.model.script = null;
  }
});

test("复核未发现实质问题：只登记复核意见，不再交回修改", { timeout: 120_000 }, async () => {
  const seen = { review: [] as Record<string, unknown>[], fixUser: [] as string[] };
  cloud.model.script = script("B38OK", "未发现实质问题。", seen);
  try {
    const run = await startRun("B38OK");
    const done = await waitRun(tk.inv, run.run_id, 100_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types));
    assert.equal(done.events.find((e: any) => e.type === "review.completed")?.payload.findings, 0);
    assert.equal(types.includes("review.fix_started"), false);
    assert.equal(seen.fixUser.length, 0);
    assert.ok(done.artifacts.some((a: any) => a.kind === "a1_review_note"));
  } finally {
    cloud.model.script = null;
  }
});

test("复核调用失败：文书照常交付，“还差什么”写明未经复核", { timeout: 120_000 }, async () => {
  const seen = { review: [] as Record<string, unknown>[], fixUser: [] as string[] };
  const base = script("B38ERR", "", seen);
  cloud.model.script = (body) => {
    const sys = msgs(body).filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(REVIEWER)) return { status: 400, content: "bad request" };
    return base(body);
  };
  try {
    const run = await startRun("B38ERR");
    const done = await waitRun(tk.inv, run.run_id, 100_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types));
    assert.ok(types.includes("review.skipped"), JSON.stringify(types));
    const settled = done.events.find((e: any) => e.type === "run.succeeded");
    assert.ok(settled, "照常结算");
    assert.ok(done.artifacts.some((a: any) => a.kind === "agent_report" && a.filename === "设备买卖合同.docx"));
  } finally {
    cloud.model.script = null;
  }
});

test("复核提出意见而交回修改失败：任务记部分完成，“还差什么”写明文书是复核前的版本", { timeout: 120_000 }, async () => {
  const seen = { review: [] as Record<string, unknown>[], fixUser: [] as string[] };
  const base = script("B38FIXERR", "【1】第二条｜价款与委托不一致｜委托原话｜改为 120 万元｜必须改", seen);
  cloud.model.script = (body) => {
    const users = msgs(body).filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    if (users.some((u) => u.includes("【独立复核】")) && users.some((u) => u.includes("B38FIXERR"))) return { status: 400, content: "bad request" };
    return base(body);
  };
  try {
    const run = await startRun("B38FIXERR");
    const done = await waitRun(tk.inv, run.run_id, 100_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "partial", JSON.stringify(types));
    assert.notEqual(done.events.find((e: any) => e.type === "review.fix_outcome")?.payload.status, "succeeded");
    const settled = done.events.find((e: any) => e.type === "run.partial");
    assert.match(String(settled?.payload.remaining?.join("") ?? ""), /复核前的版本/);
    assert.ok(done.artifacts.some((a: any) => a.kind === "a1_review_note"), "复核意见照常登记");
  } finally {
    cloud.model.script = null;
  }
});

test("复核正文为空（推理用尽输出上限）：按复核没有完成处理，不当作“未发现问题”", { timeout: 120_000 }, async () => {
  const seen = { review: [] as Record<string, unknown>[], fixUser: [] as string[] };
  cloud.model.script = script("B38EMPTY", "", seen);
  try {
    const run = await startRun("B38EMPTY");
    const done = await waitRun(tk.inv, run.run_id, 100_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types));
    const skipped = done.events.find((e: any) => e.type === "review.skipped");
    assert.match(String(skipped?.payload.error ?? ""), /输出为空/);
    assert.equal(types.includes("review.completed"), false);
    assert.equal(done.artifacts.some((a: any) => a.kind === "a1_review_note"), false);
  } finally {
    cloud.model.script = null;
  }
});

test("称呼代号说明随任务说明发出：委托原话写“周总”、材料署名“周启明”，模型收到一行只含代号的说明（V13 真实走查 W1 起草说明写出“指示人代号不一致”）", { timeout: 120_000 }, async () => {
  let firstUser = "";
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const u = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!u.includes("B38LEG")) return null;
    firstUser = u;
    return { content: "已收到。" };
  };
  try {
    const { matter } = await tk.inv("matters.create", { title: "称呼代号", stance: "买方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, model_endpoint: "standard" });
    const doc = await importBytes(tk.inv, matter.matter_id, "客户指示邮件.txt", Buffer.from("顾律师：协议用我们的抬头起草，先发我看。\n董事长：周启明", "utf8"), "text/plain");
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b38-leg-${Date.now()}`, goal: "B38LEG 周总的指示和条款清单不一致的，单独列清单。", document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
    await waitRun(tk.inv, run.run_id, 100_000);
    assert.match(firstUser, /【代号说明】/, firstUser.slice(0, 400));
    assert.doesNotMatch(firstUser.slice(firstUser.indexOf("【代号说明】")), /^【代号说明】[^。]*(周|启明)/, "说明里不出现姓名");
  } finally {
    cloud.model.script = null;
  }
});

test("复核意见解析：标准格式、续行与“建议改”；交回修改的提示按方法区分（修订任务重提完整修改清单）", () => {
  const f = parseFindings("前言\n【1】第三条｜定金超过 20%｜民法典第五百八十六条｜改为 1,720 万元｜必须改\n【2】第 9.1 款｜上限封住全额赔偿\n续行说明｜算式：300<360｜提示律师｜建议改\n【3】整份没有签署页");
  assert.equal(f.length, 3);
  assert.deepEqual([f[0]!.where, f[0]!.must], ["第三条", true]);
  assert.equal(f[1]!.must, false);
  assert.match(f[1]!.problem, /上限封住全额赔偿 续行说明/);
  assert.equal(f[2]!.problem, "整份没有签署页");
  assert.match(fixPrompt("revise", f, ""), /重新调用 docx\.revise，提交完整的修改清单/);
  assert.match(fixPrompt("draft", f, ""), /docx\.edit_draft/);
  // 要改的文件清单：Word 用 edit_draft、表格用 edit_cells，各带成果编号；编号不写进答复；修订任务不列（照旧重新调用 docx.revise）
  const targets = [{ filename: "意见书.docx", artifact_version_id: "artv_doc-2", kind: "docx" as const }, { filename: "计算表.xlsx", artifact_version_id: "artv_tab-3", kind: "xlsx" as const }];
  const withTargets = fixPrompt("draft", f, "", undefined, targets);
  assert.ok(withTargets.includes("《意见书.docx》——用 docx.edit_draft，成果编号 artv_doc-2"), withTargets);
  assert.ok(withTargets.includes("《计算表.xlsx》——用 xlsx.edit_cells，成果编号 artv_tab-3"), withTargets);
  assert.match(withTargets, /成果编号只在调用工具时用，不写进给律师的答复/);
  assert.match(withTargets, /确需整份重出时，标题与原文件名完全一致/);
  assert.equal(fixPrompt("draft", f, "").includes("成果编号"), false, "没有文件时不出清单");
  assert.equal(fixPrompt("revise", f, "", undefined, targets).includes("artv_doc-2"), false, "修订任务不列编号");
  const m = reviewMessages({ kind: "revise", stance: "委托方", jurisdiction: "中国大陆", asOf: "2026-11-07", goal: "改第8.1款", materials: [{ filename: "原件.docx", text: "原文" }], docs: [{ filename: "清洁稿.docx", text: "改后" }], diff: ["［修改前］8.1 50万元\n［修改后］8.1 20万元"] });
  assert.match(m[1]!.content, /原件与清洁稿的段落差异[\s\S]*8\.1 20万元/);
  assert.match(m[1]!.content, /授权范围/);
});

test("V16 第 41 批：复核人没按“【1】”写序号也能认出意见（真实回归：写成“1. 位置｜问题｜…｜必须改”，记成 0 条、修改轮被跳过）", () => {
  // 真实写法：阿拉伯数字加点、竖线分栏；依据里有“1.2 条”“第 1. 项”，第二条跨两行、续行以“3.5 万元”起头
  const real = parseFindings(
    "复核意见如下：\n1. 第二条｜价款写成 100 万元｜委托原话：价款120万元；合同第 1.2 条｜改为 120 万元｜必须改\n2. 第五条｜违约金比例偏高，\n3.5 万元的计算未列算式｜材料：条款清单第 1. 项｜补算式｜建议改",
  );
  assert.equal(real.length, 2, JSON.stringify(real));
  assert.deepEqual([real[0]!.no, real[0]!.where, real[0]!.must], [1, "第二条", true]);
  assert.match(real[0]!.basis, /合同第 1\.2 条/);
  assert.deepEqual([real[1]!.no, real[1]!.must], [2, false]);
  assert.match(real[1]!.problem, /3\.5 万元的计算未列算式/);
  // 全角括号、顿号、方括号写法
  const paren = parseFindings("（1）第三条｜定金超过 20%｜民法典第五百八十六条｜改为 20%｜必须改\n2、第四条｜交付期限未写｜条款清单｜补写｜建议改\n[3] 第六条｜管辖约定不明｜合同原文｜明确法院｜建议改");
  assert.deepEqual(paren.map((f) => [f.no, f.where, f.must]), [[1, "第三条", true], [2, "第四条", false], [3, "第六条", false]]);
  // 认不出分条、但明确写了“必须改”的：整段作为一条交回，不当作没有意见
  const whole = parseFindings("价款与委托不一致，应改为 120 万元，必须改。");
  assert.equal(whole.length, 1);
  assert.equal(whole[0]!.must, true);
  // “未发现实质问题”仍是 0 条；只有普通编号、没有竖线和“必须改/建议改”的说明不当作意见
  assert.equal(parseFindings("未发现实质问题。").length, 0);
  assert.equal(parseFindings("未发现实质问题。个别措辞可以斟酌，但不属于建议改的范围。").length, 0);
  assert.equal(parseFindings("复核要点：\n1. 事实对照已做\n2. 计算已复算").length, 0);
  // 末尾写“其余未发现实质问题”的，前面的意见照样认出
  assert.equal(parseFindings("1. 第二条｜价款不一致｜委托原话｜改为 120 万元｜必须改\n其余未发现实质问题。").length, 1);
});

test("V16 第 41 批：没有交回修改时，《独立复核意见》抬头不写“已交回起草的助手逐条处理”", () => {
  const f = parseFindings("【1】第二条｜价款不一致｜委托原话｜改为 120 万元｜必须改");
  assert.match(reviewNote("合同", f, "", true), /已交回起草的助手逐条处理/);
  const notBack = reviewNote("合同", f, "", false);
  assert.equal(/已交回/.test(notBack), false, notBack);
  assert.match(notBack, /没有交回起草的助手修改[\s\S]*请律师逐条核对/);
  const none = reviewNote("合同", [], "未发现实质问题。");
  assert.equal(/已交回/.test(none), false, none);
  assert.match(none, /没有交回修改[\s\S]*未发现实质问题/);
});

test("V16 第 41 批：有必须改的意见、修改轮一个字没改——任务照样完成，但提示律师核对（真实任务：助手自述“尚未实际写入原文书”却记“成功、1 个文件”）", { timeout: 120_000 }, async () => {
  const seen = { review: [] as Record<string, unknown>[], fixUser: [] as string[] };
  const base = script("B38NOEDIT", "1. 第二条｜价款写成 100 万元，与委托不一致｜委托原话：价款120万元｜改为 120 万元｜必须改", seen);
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    // 修改轮：不调用任何文书工具，直接写答复
    if (users.some((u) => u.includes("【独立复核】")) && users.some((u) => u.includes("B38NOEDIT"))) return { content: "复核意见已核对。\n\n独立复核处理情况：\n1｜未改（尚未实际写入原文书）" };
    return base(body);
  };
  try {
    const run = await startRun("B38NOEDIT");
    const done = await waitRun(tk.inv, run.run_id, 100_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types));
    assert.equal(done.events.find((e: any) => e.type === "review.completed")?.payload.must, 1, "“1.”写法的意见认出来了");
    const outcome = done.events.find((e: any) => e.type === "review.fix_outcome")?.payload;
    assert.equal(outcome?.status, "succeeded");
    assert.equal(outcome?.files, 1, "交回的只有最终答复");
    assert.equal(outcome?.revised, 0, "没有任何文书或表格出新版本");
    const remaining = String(done.events.find((e: any) => e.type === "run.succeeded")?.payload.remaining?.join("") ?? "");
    assert.match(remaining, /独立复核提出 1 条必须改的意见，修改轮没有改动任何文书或表格：处理理由见最终答复的“独立复核处理情况”，请对照《独立复核意见》核对/);
  } finally {
    cloud.model.script = null;
  }
});

test("律师在任务中的答复交给复核人（V13 W6：律师答了“180 万元含税”“30%/40%/30%”，复核人只看委托原话，把这两项当成无出处的商业条件、要求改回待定）", { timeout: 180_000 }, async () => {
  // 纯函数：单选、多选、其他、跳过；去掉引擎要求的推荐后缀
  const q = { question_id: "q", questions: [
    { id: "a", question: "价款是否含税？", options: [{ id: "o1", label: "含税 (Recommended)" }, { id: "o2", label: "不含税" }] },
    { id: "b", question: "付款节点？", options: [{ id: "p1", label: "签约" }, { id: "p2", label: "终验" }], multi_select: true },
    { id: "c", question: "违约金比例？", options: [] },
    { id: "d", question: "管辖？", options: [] },
  ] };
  assert.deepEqual(questionAnswerLines(q, { a: { kind: "single", option_id: "o1" }, b: { kind: "multi", option_ids: ["p1", "p2"] }, c: { kind: "other", text: "日万分之五" }, d: { kind: "skipped" } }), [
    "问：价款是否含税？　答：含税",
    "问：付款节点？　答：签约；终验",
    "问：违约金比例？　答：日万分之五",
  ]);
  const base = { kind: "draft" as const, stance: "买方", jurisdiction: "中国大陆", asOf: "2026-11-07", goal: "起草", materials: [], docs: [{ filename: "合同.docx", text: "2.1 价款为人民币120万元（含税）。" }] };
  assert.ok(!reviewMessages(base)[1]!.content.includes("律师在任务中的答复"), "没有答复时不出这一段");
  assert.ok(reviewMessages({ ...base, answers: ["问：价款是否含税？　答：含税"] })[1]!.content.includes("【律师在任务中的答复】"));

  // 整条链路：主任务提问 → 律师在界面作答 → 交出文书 → 复核调用里带着这条答复
  const seen = { review: [] as Record<string, unknown>[], fixUser: [] as string[] };
  const inner = script("B38QA", "未发现实质问题", seen);
  cloud.model.script = (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!sys.includes(REVIEWER) && first.includes("B38QA") && !ms.some((m) => m.role === "tool" && m.tool_call_id === "q_tax")) {
      return { toolCalls: [{ id: "q_tax", name: "AskUserQuestion", args: { questions: [{ question: "价款是否含税？", header: "含税", options: [{ label: "含税", description: "" }, { label: "不含税", description: "" }], multi_select: false }] } }] };
    }
    return inner(body);
  };
  try {
    const run = await startRun("B38QA");
    const done = await waitRunAnswering(tk.inv, run.run_id, () => ({ decision: "approve" }), 150_000, (qq: any) => Object.fromEntries(qq.questions.map((x: any) => [x.id, { kind: "single", option_id: x.options.find((o: any) => o.label === "含税")?.id }])));
    assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => e.type)));
    assert.equal(seen.review.length, 1);
    const user = String(msgs(seen.review[0]!).find((m) => m.role === "user")?.content ?? "");
    assert.ok(user.includes("【律师在任务中的答复】") && user.includes("问：价款是否含税？　答：含税"), user.slice(0, 600));
  } finally {
    cloud.model.script = null;
  }
});

test("修改轮已改出新版本但没做完：“还差什么”写明以最新版本为准，不说“文书是复核前的版本”（V13 真实走查 W4：修改轮超时前意见书已改出第 4～6 版）", { timeout: 120_000 }, async () => {
  const seen = { review: [] as Record<string, unknown>[], fixUser: [] as string[] };
  const base = script("B38FIXHALF", "【1】第二条｜价款与委托不一致｜委托原话｜改为 120 万元｜必须改\n【2】第一条｜标的型号未写｜条款清单｜补型号｜建议改", seen);
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    const inFix = users.some((u) => u.includes("【独立复核】")) && users.some((u) => u.includes("B38FIXHALF"));
    // 修改轮：先按第 1 条改出新版本（edit_1），之后模型出错，修改轮失败
    if (inFix && ms.some((m) => m.role === "tool" && m.tool_call_id === "edit_1")) return { status: 400, content: "bad request" };
    return base(body);
  };
  try {
    const run = await startRun("B38FIXHALF");
    const done = await waitRun(tk.inv, run.run_id, 100_000);
    assert.equal(done.run.status, "partial", JSON.stringify(done.events.map((e: any) => e.type)));
    const reports = done.artifacts.filter((a: any) => a.kind === "agent_report");
    assert.ok(reports.some((a: any) => a.version >= 2), "修改轮已改出新版本");
    const text = String(done.events.find((e: any) => e.type === "run.partial")?.payload.remaining?.join("") ?? "");
    assert.match(text, /改出了新版本/);
    assert.match(text, /以最新版本为准/);
    assert.doesNotMatch(text, /复核前的版本/);
  } finally {
    cloud.model.script = null;
  }
});

test("律师退回计划时写的修改意见也交给复核人（V13 W6 复测：律师在计划卡“提修改意见”里给出含税口径与付款比例）", { timeout: 180_000 }, async () => {
  const seen = { review: [] as Record<string, unknown>[], fixUser: [] as string[] };
  const inner = script("B38PLANFB", "未发现实质问题", seen);
  const planPath = (body: Record<string, unknown>): string | null => /(\/[^\s"\\]+\/plans\/[A-Za-z0-9._-]+\.md)/.exec(JSON.stringify(body.messages ?? []))?.[1] ?? null;
  cloud.model.script = (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!sys.includes(REVIEWER) && first.includes("B38PLANFB")) {
      const answered = new Set(ms.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
      if (!answered.has("pl_write")) return { toolCalls: [{ id: "pl_write", name: "Write", args: { path: planPath(body) ?? "/nonexistent/plan.md", content: "# 计划\n1. 起草设备买卖合同\n" } }] };
      if (!answered.has("pl_exit")) return { toolCalls: [{ id: "pl_exit", name: "ExitPlanMode", args: { options: [{ label: "按计划执行" }] } }] };
      if (!answered.has("pl_exit2")) return { toolCalls: [{ id: "pl_exit2", name: "ExitPlanMode", args: { options: [{ label: "按修改后的计划执行" }] } }] };
    }
    return inner(body);
  };
  try {
    const { matter } = await tk.inv("matters.create", { title: "复核测试 B38PLANFB", stance: "买方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, model_endpoint: "standard" });
    const doc = await importBytes(tk.inv, matter.matter_id, "交易条款清单.txt", Buffer.from("设备：压装设备一台。价款：人民币120万元。", "utf8"), "text/plain");
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b38-planfb-${Date.now()}`, goal: "B38PLANFB 起草设备买卖合同，价款120万元", skill: "contract-draft", document_version_ids: [doc.document_version_id], mode: "default", plan_first: true });
    let plans = 0;
    const done = await waitRunAnswering(tk.inv, run.run_id, (card: any) => {
      if (card.kind !== "plan") return { decision: "approve" };
      plans += 1;
      return plans === 1 ? { decision: "reject", feedback: "价款120万元按含税口径写" } : { decision: "approve", scope: "once" };
    }, 150_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => e.type)));
    assert.equal(plans, 2, "退回一次后第二次批准");
    assert.equal(seen.review.length, 1);
    const user = String(msgs(seen.review[0]!).find((m) => m.role === "user")?.content ?? "");
    assert.ok(user.includes("律师退回计划时的修改意见：价款120万元按含税口径写"), user.slice(0, 800));
  } finally {
    cloud.model.script = null;
  }
});

test("V14 第 39 批：修改轮说明写出时限与先后（先改必须改的，改完一批就重写答复与附件）；不给时限时不写", async () => {
  const { fixPrompt } = await import("../src/services/independent-review.ts");
  const f = [{ no: 1, where: "第三条", problem: "期限算错", basis: "材料", fix: "改为11-13", must: true }] as any;
  const withLimit = fixPrompt("draft" as any, f, "", 15 * 60_000);
  assert.match(withLimit, /约 15 分钟/);
  assert.match(withLimit, /先改“必须改”的/);
  assert.match(withLimit, /附件（证据目录、核对清单）跟正文同步改/);
  assert.equal(/分钟，到时即停止/.test(fixPrompt("draft" as any, f, "")), false);
});
