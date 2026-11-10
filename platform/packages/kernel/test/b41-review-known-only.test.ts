/**
 * V16 第 41 批：交给独立复核人的文书文字只替换事项里已经认得的姓名，不从助手写的文字里认新名字。
 * 两轮真实回归里，文书中的“被告应予返还”“应休”“应发”“权限”被当成新姓名换成代号，复核人报“无出处的自然人代号，必须改”。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b41-known-only-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b41-known-only-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000" }, "b41-known-only-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);

test("复核人看到的文书：材料里的真名仍是代号，助手写的“曾根据”“应发工资”“公式成立”原样不变", { timeout: 180_000 }, async () => {
  const seen: Record<string, unknown>[] = [];
  cloud.model.script = (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes("现在独立复核")) {
      seen.push(body);
      return { content: "未发现实质问题。" };
    }
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("B41KNOWN")) return null;
    if (!ms.some((m) => m.role === "tool" && m.tool_call_id === "render_1")) {
      // 助手只见过代号：真名处照抄它在材料里看到的代号
      const token = /〔自然人·[0-9A-Z]{6}〕/.exec(JSON.stringify(ms))?.[0] ?? "〔自然人·AAAAAA〕";
      return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "设备买卖合同", sections: [{ heading: "第一条 标的", paragraphs: ["1.1 买方向卖方购买压装设备一台。"] }, { heading: "第二条 价款与联系人", paragraphs: [`2.1 买方联系人${token}2025年度休假期间，由卖方经办人曾根据指示办理的人员对接；被申请人应发工资、员工公式成立等内容与本合同无关。`] }] } }] };
    }
    return { content: "已起草《设备买卖合同》。" };
  };
  try {
    const { matter } = await tk.inv("matters.create", { title: "复核只换已知姓名 B41KNOWN", stance: "买方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, model_endpoint: "standard" });
    const doc = await importBytes(tk.inv, matter.matter_id, "交易条款清单.txt", Buffer.from("设备：压装设备一台。买方联系人：庞知远，男，电话另附。价款：人民币120万元。", "utf8"), "text/plain");
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b41-known-${Date.now()}`, goal: "B41KNOWN 起草设备买卖合同，价款120万元，对方经办人沈墨言另行联系", skill: "contract-draft", document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => e.type)));
    assert.equal(seen.length, 1, "复核调用了一次");
    const u = String(msgs(seen[0]!)[1]!.content);
    assert.equal(u.includes("庞知远"), false, "材料里的真名不以明文交给复核人");
    assert.match(u, /买方联系人〔自然人·[0-9A-Z]{6}〕2025年度休假期间/, "文书里的真名仍是原来那个代号");
    assert.match(u, /由卖方经办人曾根据指示办理的人员对接；被申请人应发工资、员工公式成立等内容与本合同无关/, "助手写的普通词没有被换成新代号（“曾根”“应发工”“公式成”按规则会被认成姓名）");
    // 委托原话照常识别：材料里没有的新姓名也在助手开工前换成了代号，复核请求整段只换已知名单时不会漏
    assert.equal(u.includes("沈墨言"), false, "委托原话里新出现的姓名不以明文交给复核人");
    assert.match(u, /对方经办人〔自然人·[0-9A-Z]{6}〕另行联系/, "委托原话里的新姓名仍是代号");
  } finally {
    cloud.model.script = null;
  }
});

test("交回修改那一轮：复核意见里引用的“曾根据”不再被闸门认成新姓名", { timeout: 180_000 }, async () => {
  const fixBodies: Record<string, unknown>[] = [];
  cloud.model.script = (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes("现在独立复核")) {
      return { content: "【1】第二条｜“由卖方经办人曾根据指示办理的人员对接”与交易无关，员工公式成立的表述不应出现｜委托原话｜删去这一句｜必须改" };
    }
    const all = JSON.stringify(ms);
    if (!all.includes("B41FIX")) return null;
    if (all.includes("【独立复核】")) {
      fixBodies.push(body);
      return { content: "已逐条核对：第 1 条不成立，未改。\n\n独立复核处理情况\n1｜未改（与委托无关的说明已核对）" };
    }
    if (!ms.some((m) => m.role === "tool" && m.tool_call_id === "render_f")) {
      return { toolCalls: [{ id: "render_f", name: "mcp__legal__docx_render_report", args: { title: "设备买卖合同", sections: [{ heading: "第一条 标的", paragraphs: ["1.1 买方向卖方购买压装设备一台。由卖方经办人曾根据指示办理的人员对接。"] }] } }] };
    }
    return { content: "已起草《设备买卖合同》。" };
  };
  try {
    const { matter } = await tk.inv("matters.create", { title: "修改轮只换已知姓名 B41FIX", stance: "买方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, model_endpoint: "standard" });
    const doc = await importBytes(tk.inv, matter.matter_id, "交易条款清单.txt", Buffer.from("设备：压装设备一台。买方联系人：庞知远。价款：人民币120万元。", "utf8"), "text/plain");
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b41-fix-${Date.now()}`, goal: "B41FIX 起草设备买卖合同，价款120万元", skill: "contract-draft", document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    assert.ok(fixBodies.length >= 1, `修改轮发出了请求：${JSON.stringify(done.events.map((e: any) => e.type))}`);
    const users = msgs(fixBodies[0]!).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    const fix = users.find((t) => t.includes("【独立复核】")) ?? "";
    assert.match(fix, /由卖方经办人曾根据指示办理的人员对接/, "复核意见里引用的原句原样交给助手（“曾根”没有被认成姓名）");
    assert.match(fix, /员工公式成立/, "“公式成”没有被认成姓名");
  } finally {
    cloud.model.script = null;
  }
});
