/**
 * V16 第 41 批：独立复核人查不了法规库，凭记忆把正确的条号判成“必须改”（真实回归 m09、E7：要求把仲裁法第二十七条改为第二十五条，
 * 2026-03-01 起施行的新仲裁法里第二十七条正是仲裁协议；m12、m21 同类）。
 * 做法：组装复核请求时从交付件文字里抽出法条引用，按分析截止日查本机法规库，把条文原文附在复核请求里；复核人对条号的意见只能以这一节为依据；
 * 复核意见里涉及的法条（含“改为第二十五条”这种只写条号的）同样查库，原文附在交回修改的提示里。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b41-law-excerpt-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { LAW_ITEMS_MAX, fixPrompt, lawExcerptLines, lawRefsIn, reviewMessages } from "../src/services/independent-review.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: signerPub });

test("抽引用：按出现先后、同条只取一次；复核意见里只写条号的“改为第二十五条”归到前面那部法；合同条款不算", () => {
  const doc = lawRefsIn(["依据《中华人民共和国仲裁法》第二十七条，仲裁协议有效。又依《民法典》第五百八十五条主张违约金；再引仲裁法第二十七条。", "本合同第七条约定仲裁。"]);
  assert.deepEqual(doc.map((r) => [r.law, r.article]), [["中华人民共和国仲裁法", 27], ["民法典", 585]]);
  // 文书里不跟法名的条号不归（不知道是哪部法的）
  assert.equal(lawRefsIn(["仲裁法第二十七条应改为第二十五条"]).length, 1);
  const finding = lawRefsIn(["申请书第三段｜仲裁法第二十七条应改为第二十五条｜仲裁法｜改为第二十五条，并核对合同第七条｜必须改"], { followBare: true });
  assert.deepEqual(finding.map((r) => [r.law, r.article]), [["仲裁法", 27], ["仲裁法", 25]], "合同第七条不归到仲裁法");
});

test("查库附原文：有原文的附原文与版本；条号超出、未收录的写明无法核对；超出上限写“其余 N 条未附”", () => {
  const lines = lawExcerptLines(lawdb, [{ law: "中华人民共和国仲裁法", article: 27 }, { law: "民法典", article: 1300 }, { law: "证券法", article: 78 }], "2026-11-10");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^【《仲裁法》第二十七条】（2026-03-01 起施行的版本）\n仲裁协议包括合同中订立的仲裁条款/);
  assert.match(lines[1]!, /【《民法典》第一千三百条】本机法规库里这部法规（2021-01-01 起施行的版本）共 1260 条，没有这一条/);
  assert.match(lines[2]!, /【《证券法》第七十八条】本机法规库未收录这部法规，无法核对/);
  // 新仲裁法施行前：没有有效版本，如实写无法核对
  assert.match(lawExcerptLines(lawdb, [{ law: "仲裁法", article: 27 }], "2025-06-01")[0]!, /没有有效版本/);
  // 上限：民法典第 1～60 条，只附前 LAW_ITEMS_MAX 条（按出现先后），其余写明未附
  const many = lawExcerptLines(lawdb, Array.from({ length: 60 }, (_, i) => ({ law: "民法典", article: i + 1 })), "2026-11-10");
  assert.equal(many.length, LAW_ITEMS_MAX + 1);
  assert.match(many[0]!, /第一条】/);
  assert.match(many.at(-1)!, /其余 20 条未附/);
});

test("复核请求带“法条原文”一节与只能依此判条号的约束；没有引用时也写明；修改提示附意见涉及的法条原文", () => {
  const laws = lawExcerptLines(lawdb, lawRefsIn(["依《仲裁法》第二十七条"]), "2026-11-10");
  const m = reviewMessages({ kind: "pleading", stance: "申请人", jurisdiction: "中国大陆", asOf: "2026-11-10", goal: "写仲裁申请书", materials: [], docs: [{ filename: "仲裁申请书.docx", text: "依《仲裁法》第二十七条" }], laws });
  assert.match(m[0]!.content, /对条号、条文内容的意见，只能以“文书引用的法条在本机法规库里的原文”一节为依据[\s\S]*写“建议核对原文”，不定为“必须改”/);
  assert.match(m[1]!.content, /=== 文书引用的法条在本机法规库里的原文（按分析截止日 2026-11-10 适用的版本[\s\S]*仲裁协议包括合同中订立的仲裁条款/);
  const none = reviewMessages({ kind: "pleading", stance: "申请人", jurisdiction: "中国大陆", asOf: "2026-11-10", goal: "x", materials: [], docs: [{ filename: "a.docx", text: "正文" }] });
  assert.match(none[1]!.content, /没有认出“《法名》第N条”式的引用，本节为空/);
  const fp = fixPrompt("pleading", [{ no: 1, where: "第三段", problem: "仲裁法第二十七条应改为第二十五条", basis: "", fix: "", must: true }], "", undefined, [], lawExcerptLines(lawdb, lawRefsIn(["仲裁法第二十七条应改为第二十五条"], { followBare: true }), "2026-11-10"));
  assert.match(fp, /复核意见涉及的法条在本机法规库里的原文[\s\S]*【《仲裁法》第二十七条】[\s\S]*【《仲裁法》第二十五条】[\s\S]*判定不成立，不改，在答复里写明依据的条文/);
  assert.equal(/本机法规库里的原文/.test(fixPrompt("pleading", [], "未发现")), false, "没有法条时不出这一节");
});

let tk: TestKernel;
let cloud: CloudV0;
before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b41-law-excerpt" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000" }, "b41-law-excerpt");
});
after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);

test("整条链路：复核请求里有文书所引条文的原文；复核人要求改条号，交回修改的提示附上两条的原文", { timeout: 180_000 }, async () => {
  const seen = { review: [] as string[], fixUser: [] as string[] };
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes("现在独立复核")) {
      seen.review.push(String(ms.find((m) => m.role === "user")?.content ?? ""));
      return { content: "【1】第一部分｜仲裁法第二十七条应改为第二十五条｜仲裁法｜改为第二十五条｜必须改" };
    }
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("B41LAW")) return null;
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    if (!ms.some((m) => m.role === "tool" && m.tool_call_id === "render_1")) {
      return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "设备买卖合同", sections: [{ heading: "第十二条 争议解决", paragraphs: ["12.1 争议提交仲裁委员会仲裁；依《中华人民共和国仲裁法》第二十七条，本条构成仲裁协议。"] }] } }] };
    }
    if (users.some((u) => u.includes("【独立复核】"))) {
      seen.fixUser.push(users.at(-1) ?? "");
      return { content: "复核意见不成立：新仲裁法第二十七条即仲裁协议条文。\n\n独立复核处理情况：\n1｜未改（法规库原文支持原写法）" };
    }
    return { content: "已起草《设备买卖合同》。" };
  };
  try {
    const { matter } = await tk.inv("matters.create", { title: "法条原文 B41LAW", stance: "申请人", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, model_endpoint: "standard" });
    const doc = await importBytes(tk.inv, matter.matter_id, "合同.txt", Buffer.from("第十二条 争议提交仲裁委员会仲裁。", "utf8"), "text/plain");
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b41-law-${Date.now()}`, goal: "B41LAW 起草设备买卖合同，争议走仲裁", skill: "contract-draft", document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => e.type)));
    assert.equal(seen.review.length, 1);
    assert.match(seen.review[0]!, /文书引用的法条在本机法规库里的原文[\s\S]*【《仲裁法》第二十七条】（2026-03-01 起施行的版本）\n仲裁协议包括/);
    const fix = seen.fixUser.at(-1) ?? "";
    assert.match(fix, /复核意见涉及的法条在本机法规库里的原文[\s\S]*【《仲裁法》第二十七条】[\s\S]*仲裁协议包括[\s\S]*【《仲裁法》第二十五条】/, fix.slice(-1500));
  } finally {
    cloud.model.script = null;
  }
});

test("第三轮复验：不带书名号的法名、省写的条号串、文书自起的简称都取得到原文", () => {
  const key = (r: { law: string; article: number }[]) => r.map((x) => `${x.law}#${x.article}`);
  const refs = key(
    lawRefsIn([
      "依据《劳动人事争议仲裁办案规则》第八条。",
      "收到副本；劳动人事争议仲裁办案规则第三十三条、第八十条；办案规则第十、三十六条",
      "《劳动争议调解仲裁法》第四十七至五十条及《办案规则》第五十条",
    ]),
  );
  for (const want of ["劳动人事争议仲裁办案规则#33", "劳动人事争议仲裁办案规则#80", "劳动人事争议仲裁办案规则#10", "劳动人事争议仲裁办案规则#36", "劳动人事争议仲裁办案规则#50", "劳动争议调解仲裁法#47", "劳动争议调解仲裁法#48", "劳动争议调解仲裁法#49", "劳动争议调解仲裁法#50"]) assert.ok(refs.includes(want), want);
  assert.ok(!refs.some((x) => x.startsWith("办案规则#")), "简称按全称取");
  assert.deepEqual(key(lawRefsIn(["《劳动合同法》第三十九条第二项、第三项，及第四十七条至第四十九条"])), ["劳动合同法#39", "劳动合同法#47", "劳动合同法#48", "劳动合同法#49"]);
  // 合同自己的条款不算法条；跨度过大的“至”只取两端
  assert.deepEqual(key(lawRefsIn(["《民法典》第五百七十七条。本合同第七条、第八条约定；《采购合同》第三条"])), ["民法典#577"]);
  assert.deepEqual(key(lawRefsIn(["《劳动合同法》第四十六条至第八十七条"])), ["劳动合同法#46", "劳动合同法#87"]);
  const lines = lawExcerptLines(lawdb, lawRefsIn(["《劳动人事争议仲裁办案规则》第八条；《办案规则》第三十三、八十条"]), "2026-11-11");
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => !/无法核对/.test(l)), lines.join("\n"));
});

test("分段复验：法名后面跟的是司法解释的名字时，不归到那部法（“关于适用《民法典》合同编通则若干问题的解释（2023年12月5日施行）第10条”曾被取成民法典第十条）", async () => {
  const { extractCitations } = await import("../src/tools/tools/citations.ts");
  const key = (t: string) => extractCitations(t).map((x) => `${x.law}#${x.article}`);
  const JS = "最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释";
  assert.deepEqual(key("原文已对照最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释（2023年12月5日施行）第10条、第六十五条"), [`${JS}#10`, `${JS}#65`]);
  assert.deepEqual(key("民法典合同编通则解释第65条"), [`${JS}#65`]);
  // 编章名照旧归到这部法；说不清是哪份文件的不提取
  assert.deepEqual(key("《民法典》合同编第五百七十七条；民法典第三编第一分编通则第四百六十九条"), ["民法典#577", "民法典#469"]);
  assert.deepEqual(key("参照《民法典》有关规定第十条"), []);
  const lines = lawExcerptLines(lawdb, lawRefsIn(["最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释（2023年12月5日施行）第10条"]), "2026-11-11");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /合同编通则若干问题的解释》第十条】（/);
});
