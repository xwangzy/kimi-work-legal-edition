/**
 * 检索补位与抓取经闸门（v9 第 04 篇 §5.1 `/search`、`/fetch`，§11 P4/P5；第 02 篇 §8.3 检索行与 URL 行、§11.2）：
 * kap-host 中真实的 WebSearch / FetchURL 工具 → 宿主出口（按工具调用 ID 与参数摘要对到宿主策略刚放行的那次裁决）
 * → 出站闸门（去标识、泛化或拒绝、URL 检查）→ 检索服务 v0（不带事项编号）。
 * - 一般性查询放行；含当事人实体的查询由宿主预筛出确认卡（W1）——本用例中律师拒绝，查询没有离开律师电脑；
 * - URL 携带当事人信息被闸门拦截，拒绝原因原样交给模型（ZP-11 补充：不回落）；白名单之外的新域名由宿主策略询问——律师拒绝，不出站；
 * - 查询原文只在本机事项账本的去向记录里；检索服务只见发出的查询。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "kap-gate-test-secret-0123456789ab";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, importText, waitRunAnswering, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_kap-gate-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "kap-gate-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const toolText = (body: Record<string, unknown>, id: string): string => {
  const m = msgs(body).find((x) => x.role === "tool" && x.tool_call_id === id);
  return m ? (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) : "";
};

test("WebSearch 与 FetchURL 经出站闸门：一般查询放行且不带事项编号；含当事人的查询被拒绝并提示改写；URL 带当事人姓名被拦截且原因交给模型；新域名经宿主策略询问", { timeout: 240_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", {
    title: "股权纠纷",
    stance: "原告",
    client_name: "孙悦",
    counterparty: "甲科技有限公司",
    consent_status: "agreed",
    model_endpoint: "standard",
    key_dates: { analysis_as_of: "2026-10-01" },
  });
  const doc = await importText(inv, matter.matter_id, "起诉状.txt", "原告孙悦诉被告甲科技有限公司（以下简称“甲科”）股东出资纠纷。");
  const M = "KAPGATE";
  const calls: { id: string; name: string; args: unknown }[] = [
    { id: "ws_0", name: "WebSearch", args: { query: "股东未实缴出资 补足责任 判例" } },
    { id: "ws_1", name: "WebSearch", args: { query: "甲科技有限公司 股东未实缴出资" } },
    { id: "fu_2", name: "FetchURL", args: { url: "https://www.court.gov.cn/search?q=孙悦" } },
    { id: "fu_3", name: "FetchURL", args: { url: "https://example.org/a" } },
    // 材料里的简称定义已进当事人词典：用简称写的检索同样被拦截（审查 S4-02）
    { id: "ws_4", name: "WebSearch", args: { query: "甲科 股东出资 纠纷" } },
  ];
  let last: Record<string, unknown> | null = null;
  cloud.model.script = (body) => {
    const first = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
    if (!first.includes(M)) return null;
    last = body;
    const answered = new Set(msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    const next = calls.find((c) => !answered.has(c.id));
    return next ? { toolCalls: [next] } : { content: "研究完成。" };
  };
  try {
    const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `kg-${Date.now()}`, goal: `${M} 研究股东未实缴出资的补足责任` });
    // 律师：含当事人的检索卡与新域名抓取卡一律拒绝
    const { run: fin, events, cards } = await waitRunAnswering(inv, run.run_id, (c) => (c.kind === "search" || c.kind === "fetch" ? { decision: "reject" } : { decision: "approve" }), 200_000);
    assert.equal(fin.status, "succeeded", JSON.stringify(events.map((e: any) => [e.type, e.type === "agent.error" || e.type === "agent.outcome" ? e.payload : null])));
    assert.ok(last, "模型收到了全部工具结果");
    const body = last!;
    // 一般性查询：经闸门到检索服务，结果回到模型
    assert.match(toolText(body, "ws_0"), /（mock）/, toolText(body, "ws_0"));
    assert.ok(cloud.search.calls.some((c) => c.query === "股东未实缴出资 补足责任 判例"), JSON.stringify(cloud.search.calls));
    // 含当事人实体：宿主预筛出确认卡（卡片给出原文放行与改写后将发出的查询）；律师拒绝，检索服务没有收到
    const searchCards = cards.filter((c: any) => c.kind === "search");
    assert.equal(searchCards.length, 2, JSON.stringify(cards.map((c: any) => [c.kind, c.title])));
    assert.deepEqual(searchCards[0].variants, ["original", "generalized"]);
    assert.ok(searchCards[0].preview.send_generalized && !searchCards[0].preview.send_generalized.includes("甲科技"), JSON.stringify(searchCards[0].preview));
    assert.ok(toolText(body, "ws_1").length > 0);
    assert.ok(!cloud.search.calls.some((c) => c.query.includes("甲科技")), "含当事人的查询没有离开律师电脑");
    // URL 带当事人姓名：闸门拦截，原因原样交给模型（不回落到“本机抓取已禁用”）
    assert.match(toolText(body, "fu_2"), /person_name_in_url|抓取被出站闸门拒绝/, toolText(body, "fu_2"));
    assert.doesNotMatch(toolText(body, "fu_2"), /Direct local fetch is disabled/);
    // 白名单之外的新域名：宿主策略询问（确认卡）；律师拒绝 → 不出站
    assert.ok(cards.some((c: any) => c.kind === "fetch" && c.preview.host === "example.org"));
    assert.ok(toolText(body, "fu_3").length > 0);
    // 简称（材料中的“以下简称”定义）同样命中（第二张检索卡）
    assert.match(searchCards[1].title, /甲科/);
    assert.ok(!cloud.search.calls.some((c) => c.query.includes("甲科")), "简称写的查询没有离开律师电脑");
    const parties = await inv("matters.parties.list", { matter_id: matter.matter_id });
    // 学得的简称标“待确认”（照常参与匹配；复核 S4-20）
    assert.ok(parties.parties.some((p: any) => p.learned.includes("甲科")), JSON.stringify(parties.parties));
    // 去向记录：检索查询原文只在本机事项账本
    const eg = await inv("egress.records", { run_id: run.run_id });
    const searchSent = eg.records.filter((r: any) => r.destination_kind === "search_service" && r.outcome === "sent");
    assert.equal(searchSent.length, 1);
    assert.equal(JSON.parse(searchSent[0].note).query.original, "股东未实缴出资 补足责任 判例");
    // 去向记录关联所依据的宿主裁决（审查 S4-03）
    assert.equal(JSON.parse(searchSent[0].note).host_decision, "approve:search_screened_by_gate");
    // 去向记录带工具调用编号（只作时间线关联；v9.2 Y4 P0-A）：执行页在该步骤显示实际发出的查询与打开的网址
    assert.equal(JSON.parse(searchSent[0].note).tool_call_id, "ws_0");
    // 被闸门拦截的抓取同样带调用编号（界面据此在该步骤写“这个网址没有打开”；映射逻辑见 apps/desktop/test/timeline-sent.test.ts）
    const fu2 = eg.records.find((r: any) => JSON.parse(r.note).tool_call_id === "fu_2");
    assert.ok(fu2 && fu2.outcome === "blocked", JSON.stringify(fu2));
    const blocked = eg.records.filter((r: any) => r.destination_kind === "gate_blocked");
    // 被律师拒绝的检索根本没有到闸门（宿主层面就停住了）；URL 带人名仍由闸门拦截
    assert.ok(!blocked.some((r: any) => JSON.parse(r.note).purpose === "search"), JSON.stringify(blocked));
    assert.ok(blocked.some((r: any) => JSON.parse(r.note).purpose === "fetch" && JSON.parse(r.note).reason === "person_name_in_url"));
    // 检索服务计量只有席位与次数（不带事项编号、不含查询原文）
    assert.ok(!JSON.stringify(cloud.searchMeter).includes(matter.matter_id));
    assert.ok(!JSON.stringify(cloud.searchMeter).includes("股东"));
  } finally {
    cloud.model.script = null;
  }
});
