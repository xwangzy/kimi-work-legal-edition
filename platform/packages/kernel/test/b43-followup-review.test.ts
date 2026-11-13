/**
 * V18 第 43 批续四（偏离 D-184）：追问这一轮重新交出了文书的，同样做独立复核。
 * 原先追问一律不复核（V13 第 38 批）：补了材料的追问重出主文书（真实复验 m36 改了 48 个单元格），那一版就成了没人复核过的最新版，界面上也没有提示。
 * - 追问自己不带方法：复核按追问链上最初任务的方法；委托原话 = 最初的委托 + 其间的追问 + 本轮追问；
 * - 只用文字回答的追问没有复核对象，不复核；
 * - 复核提出“必须改”的，照常交回本轮的对话改正、回看。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b43-fu-review-secret-0123456789abcd";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { followUpChain, followUpReviewGoal } from "../src/executor/executor.ts";
import { followUpMessages, lawRefsIn, replyForReviewer, reviewMessages } from "../src/services/independent-review.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b43-fu-review-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000", ZR_REVIEW_RETRY_WAIT_MS: "50" }, "b43-fu-review-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const REVIEWER = "现在独立复核";
const LOOK_BACK = "逐条核对你标为“必须改”的意见";
const M = "B43FUREV";

const render = (id: string, price: number) => ({
  toolCalls: [{ id, name: "mcp__legal__docx_render_report", args: { title: "设备买卖合同", sections: [{ heading: "第一条 标的", paragraphs: ["1.1 买方向卖方购买压装设备一台。"] }, { heading: "第二条 价款", paragraphs: [`2.1 价款为人民币${price}万元。`] }] } }],
});

test("追问重出文书的做独立复核：方法沿追问链取，复核人看到最初的委托与各轮追问；只用文字回答的追问不复核；复核提“必须改”的照常交回本轮改正并回看", { timeout: 300_000 }, async () => {
  const seen = { review: [] as string[], lookBack: 0, fixUser: [] as string[], fuPrompt: "" };
  const reviews = ["未发现实质问题。", "未发现实质问题。", "【1】第二条｜价款写成 170 万元，与本轮追问要求的 180 万元不一致｜本轮追问：价款改成180万元｜2.1 改为“价款为人民币180万元”｜必须改"];
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(LOOK_BACK)) {
      seen.lookBack += 1;
      return { content: "【1】已落实｜第 2.1 款已是 180 万元" };
    }
    if (sys.includes(REVIEWER)) {
      seen.review.push(String(ms.find((m) => m.role === "user")?.content ?? ""));
      return { content: reviews.shift() ?? "未发现实质问题。" };
    }
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    if (!(users[0] ?? "").includes(M)) return null;
    const done = (id: string) => ms.some((m) => m.role === "tool" && m.tool_call_id === id);
    // 本轮是哪一步：从最后一条用户消息往前，找到第一条带标记的
    const cur = [...users].reverse().find((u) => /FUTEXT|FU150|FU180|【独立复核】/.test(u)) ?? users[0]!;
    if (cur.includes("【独立复核】")) {
      seen.fixUser.push(cur);
      if (!done("edit_180")) {
        const r170 = ms.find((m) => m.role === "tool" && m.tool_call_id === "render_170");
        const id = /artv_[0-9a-f-]+/.exec(JSON.stringify(r170?.content ?? ""))?.[0];
        return { toolCalls: [{ id: "edit_180", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: "价款为人民币170万元", proposed_text: "价款为人民币180万元" }] } }] };
      }
      return { content: "已按独立复核意见改正。\n\n独立复核处理情况：\n1｜已改（第 2.1 款价款改为 180 万元）" };
    }
    if (cur.includes("FUTEXT")) return { content: "第二条约定的是价款：人民币120万元。" };
    if (cur.includes("FU150")) {
      // 续五：追问提示里列了上一轮合同的成果编号，直接在它上面改（不整份重出）
      seen.fuPrompt = cur;
      if (done("edit_150")) return { content: "已把价款改为 150 万元。" };
      const id = /成果编号 (artv_[0-9a-f-]+)/.exec(cur)?.[1];
      return { toolCalls: [{ id: "edit_150", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: "价款为人民币120万元", proposed_text: "价款为人民币150万元" }] } }] };
    }
    if (cur.includes("FU180")) return done("render_170") ? { content: "已把价款改为 180 万元，重出了《设备买卖合同》。" } : render("render_170", 170);
    return done("render_1") ? { content: "已起草《设备买卖合同》。" } : render("render_1", 120);
  };
  try {
    const { matter } = await tk.inv("matters.create", { title: "追问复核", stance: "买方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, model_endpoint: "standard" });
    const doc = await importBytes(tk.inv, matter.matter_id, "交易条款清单.txt", Buffer.from("设备：压装设备一台。价款：人民币120万元，验收合格后10日内一次付清。", "utf8"), "text/plain");
    const start = async (goal: string, extra: Record<string, unknown>) => {
      const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
      const r = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b43fu-${Date.now()}-${Math.random()}`, goal, ...extra });
      return waitRun(tk.inv, r.run_id, 150_000);
    };
    const types = (d: any) => d.events.map((e: any) => e.type);

    // 第一轮：指定方法起草，照常复核
    const r1 = await start(`${M} 起草设备买卖合同，价款120万元`, { skill: "contract-draft", mode: "default", plan_first: false });
    assert.equal(r1.run.status, "succeeded", JSON.stringify(types(r1)));
    assert.equal(seen.review.length, 1);
    assert.equal(r1.events.find((e: any) => e.type === "review.started")?.payload.followup, undefined);

    // 追问一：只用文字回答——没有复核对象，不复核
    const a = await start("FUTEXT 第二条写了什么", { followup_of: r1.run.run_id });
    assert.equal(a.run.status, "succeeded", JSON.stringify(types(a)));
    assert.equal(types(a).some((t: string) => t.startsWith("review.")), false, JSON.stringify(types(a)));
    assert.equal(seen.review.length, 1, "只用文字回答的追问不调用复核");

    // 追问二：重出合同——复核；追问没带方法，方法取最初任务的（起草类）
    const b = await start("FU150 价款改成150万元", { followup_of: a.run.run_id });
    assert.equal(b.run.status, "succeeded", JSON.stringify(types(b)));
    assert.equal(seen.review.length, 2, "重出文书的追问做了复核");
    // 续五：追问提示列出上一轮的合同与成果编号；助手按这个编号直接改，新版本登记在本轮、是同名文件的第 2 版
    const v1 = r1.artifacts.find((x: any) => x.kind === "agent_report" && x.filename === "设备买卖合同.docx");
    assert.match(seen.fuPrompt, /【此前交出的文件】这次只改其中几处的，直接在最新版上改，不要整份重出/);
    assert.ok(seen.fuPrompt.includes(`《设备买卖合同.docx》——用 docx.edit_draft，成果编号 ${v1.artifact_version_id}`), seen.fuPrompt.slice(0, 900));
    const editedB = b.artifacts.filter((x: any) => x.kind === "agent_report" && x.filename === "设备买卖合同.docx");
    assert.equal(editedB.length, 1, "本轮登记了改后的合同");
    assert.notEqual(editedB[0].artifact_version_id, v1.artifact_version_id);
    assert.equal(b.events.filter((e: any) => e.type === "agent.tool_result" && e.payload?.is_error).length, 0, "直接改成功，没有被拒绝的调用");
    const startedB = b.events.find((e: any) => e.type === "review.started")?.payload;
    assert.equal(startedB?.followup, true);
    assert.equal(startedB?.skill, "contract-draft");
    assert.equal(startedB?.kind, r1.events.find((e: any) => e.type === "review.started")?.payload.kind);
    const u2 = seen.review[1]!;
    assert.match(u2, new RegExp(`【最初的委托】${M} 起草设备买卖合同，价款120万元`));
    assert.match(u2, /【其后的追问（按先后）】\n1\. FUTEXT 第二条写了什么/);
    assert.match(u2, /【本轮追问】FU150 价款改成150万元/);
    assert.match(u2, /本轮是在原任务的对话上接着做的追问，复核的是这一轮重新交出的文件/);
    assert.match(u2, /待复核交付件[\s\S]*价款为人民币150万元/);
    assert.equal(/价款为人民币120万元/.test(u2.split("待复核交付件")[1] ?? ""), false, "复核的是本轮重出的那一版，不是上一轮的");
    assert.match(u2, /材料：[^\n]*交易条款清单/, "材料照样给复核人");
    // 复核结论与第一轮一字不差（都是“未发现实质问题”）：仍登记在本轮任务下，写明复核的是第几次追问后的版本（否则按内容去重，只挂在第一轮）
    const noteB = b.artifacts.find((x: any) => x.kind === "a1_review_note");
    assert.ok(noteB, "本轮有《独立复核意见》");
    const noteText = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: noteB.artifact_version_id })).data_base64, "base64").toString("utf8");
    assert.match(noteText, /本次复核的是第 2 次追问后重新交出的版本。/);
    assert.equal(types(b).includes("review.fix_started"), false);

    // 追问三：重出的合同写错了（170）——复核提必须改，交回本轮对话改成 180，回看通过
    const c = await start("FU180 价款改成180万元，重出合同", { followup_of: b.run.run_id });
    assert.equal(c.run.status, "succeeded", JSON.stringify(types(c)));
    assert.equal(seen.review.length, 3);
    assert.match(seen.review[2]!, /【其后的追问（按先后）】\n1\. FUTEXT[^\n]*\n2\. FU150/);
    assert.equal(c.events.find((e: any) => e.type === "review.completed")?.payload.must, 1);
    assert.equal(c.events.find((e: any) => e.type === "review.fix_outcome")?.payload.status, "succeeded");
    assert.equal(c.events.find((e: any) => e.type === "review.fix_outcome")?.payload.revised, 1);
    assert.match(seen.fixUser.at(-1) ?? "", /【独立复核】[\s\S]*价款写成 170 万元/);
    assert.equal(seen.lookBack, 1, "回看照常做");
    assert.equal(c.events.find((e: any) => e.type === "review.followup")?.payload.done, 1);
    const contracts = c.artifacts.filter((x: any) => x.kind === "agent_report" && x.filename === "设备买卖合同.docx");
    const latest = await tk.inv("artifacts.download", { artifact_version_id: contracts.at(-1).artifact_version_id });
    const { readZipText } = await import("@zr-legal/docx-engine");
    assert.match((readZipText(Buffer.from(latest.data_base64, "base64"), "word/document.xml") ?? "").replace(/<[^>]+>/g, ""), /价款为人民币180万元/);

    // 追问链：从最初那次到本次
    assert.deepEqual(followUpChain(tk.kernel.db, c.run.run_id), [r1.run.run_id, a.run.run_id, b.run.run_id, c.run.run_id]);
    assert.deepEqual(followUpChain(tk.kernel.db, r1.run.run_id), [r1.run.run_id]);
  } finally {
    cloud.model.script = null;
  }
});

test("追问那一轮交给复核人的委托原话：最初的委托、其间的追问、本轮追问与补充的材料；没有其间追问、没有补材料时不写对应的话", () => {
  const full = followUpReviewGoal({ rootGoal: "出交割清单", methodLine: "【方法】按“交割清单”方法做。\n", rulesBlock: "", earlier: ["第 3 行再细一点"], current: "章程补上了，核一下表决比例", added: ["目标公司章程（摘录）.docx"] });
  assert.match(full, /^【最初的委托】出交割清单\n【方法】按“交割清单”方法做。\n【其后的追问（按先后）】\n1\. 第 3 行再细一点\n【本轮追问】章程补上了，核一下表决比例\n【说明】/);
  assert.match(full, /本轮律师补充了材料：《目标公司章程（摘录）\.docx》。/);
  assert.match(full, /不因“本轮追问没有提到”判为超出委托；这些部分有实质错误的照常指出。$/);
  const bare = followUpReviewGoal({ rootGoal: "出交割清单", methodLine: "", rulesBlock: "", earlier: [], current: "再短一点", added: [] });
  assert.equal(/其后的追问|补充了材料/.test(bare), false);
});

test("真实追问暴露的三处误判来源（m36 第二次追问：两条“必须改”都不成立，任务被记成部分完成）", () => {
  // ① 条号并列、法名后带版本括注：复核人要拿到全部五条的原文
  const refs = lawRefsIn(["《中华人民共和国公司法》（2023年修订，2024-07-01施行）第三十四、三十五、三十六条涉及变更登记；《中华人民共和国公司法》（2024-07-01施行）第六十六条、第二百二十七条。"]);
  assert.deepEqual(refs.map((r) => r.article).sort((a, b) => a - b), [34, 35, 36, 66, 227]);
  // ② 最终答复末尾的质量说明不交给复核人，并写明答复只给律师看
  const reply = "已更新《交割清单》。该冲突也已提交审查工作台。\n\n通用辅助 · 未经本所质量验收";
  assert.equal(replyForReviewer(reply), "已更新《交割清单》。该冲突也已提交审查工作台。");
  const user = String(reviewMessages({ kind: "table", stance: "投资方", jurisdiction: "内地民商事", asOf: "2026-11-09", goal: "出交割清单", materials: [], docs: [{ filename: "交割清单.xlsx", text: "［第 1 行］先决条件" }], diff: [], inventory: [], reply, answers: [], laws: [] }).at(-1)!.content);
  assert.match(user, /这份答复只给律师本人看，不对外发出[^\n]*不要就这类用语提意见/);
  assert.equal(/未经本所质量验收/.test(user.split("助手给律师的最终答复")[1] ?? ""), false, "质量说明不进复核提示");
  // ③ 回看带上法条原文：起草方以法条为由不改的，复核人有依据判“理由成立”
  const fu = String(
    followUpMessages({
      findings: [{ no: 1, where: "说明第11行", problem: "称已核对原文但未附", basis: "", fix: "改为尚未核验", must: true }],
      handling: "1｜未改（复核意见不成立）。所附条文支持现有表述。\n\n通用辅助 · 未经本所质量验收",
      docs: [{ filename: "交割清单.xlsx", text: "说明第11行" }],
      hints: [],
      laws: ["【《中华人民共和国公司法》第六十六条】……须经代表三分之二以上表决权的股东通过。"],
      asOf: "2026-11-09",
    }).at(-1)!.content,
  );
  assert.match(fu, /引用的法条在本机法规库里的原文（按分析截止日 2026-11-09 适用的版本）：起草方以法条为由不改的，对照这里判断理由是否成立/);
  assert.match(fu, /【《中华人民共和国公司法》第六十六条】/);
  assert.equal(/未经本所质量验收/.test(fu), false);
  // 不给法条时没有这一节
  assert.equal(/本机法规库里的原文/.test(String(followUpMessages({ findings: [], handling: "", docs: [], hints: [] }).at(-1)!.content)), false);
});

