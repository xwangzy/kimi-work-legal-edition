/**
 * V16 第 41 批安全评审（06-出站闸门改动安全评审.md）：“只替换已知名单”的地方，送进去的原件文字必须先做过完整识别。
 * 每条路径一个用例：原件里有一个从没出现在材料快照里的姓名，经这条路径后，发往模型的请求里仍是代号。
 * - H1：docx.revise 的返回（改前整段）带原件原文，原件可以是没进本任务快照的材料；
 * - H2：审合同任务的复核对象里有清洁稿（源自原件），原件从没识别过；找不到原件的这份整段完整识别并记事件；
 * - M1：docx.edit_draft 不能作用于《修改对照表》（内容是原件原文，结果却按助手写的文字读回）。
 * （L1 读回结果解析失败的方向见 egress-gate/test/model-authored.test.ts。）
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b41-source-known-only-secret-0123456789";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDocx } from "@zr-legal/docx-engine";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
let cloud: CloudV0;
before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b41-source-known" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000" }, "b41-source-known");
});
after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const basis = { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" };

/** 事项：快照里只有一份条款清单；另有一份没勾选进任务的 Word 原件，里面有从没识别过的姓名。 */
async function matterWithUnseenDocx(marker: string, name: string) {
  const { matter } = await tk.inv("matters.create", { title: `原件识别 ${marker}`, stance: "买方", basis, model_endpoint: "standard" });
  const a = await importBytes(tk.inv, matter.matter_id, "交易条款清单.txt", Buffer.from("设备：压装设备一台。价款：人民币120万元。", "utf8"), "text/plain");
  const docx = createDocx("设备买卖合同", [{ heading: "第一条 标的", paragraphs: ["1.1 买方向卖方购买压装设备一台。", `1.2 卖方联系人：${name}，负责安装与验收。`] }], { mark: false });
  const b = await importBytes(tk.inv, matter.matter_id, "设备买卖合同（对方稿）.docx", docx, DOCX);
  return { matter, a, b };
}

async function startRun(matterId: string, docId: string, marker: string, goal: string, skill?: string) {
  const est = await tk.inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [docId] });
  return tk.inv("runs.start", { matter_id: matterId, estimate_id: est.estimate_id, idempotency_key: `${marker}-${Date.now()}`, goal: `${marker} ${goal}`, ...(skill ? { skill } : {}), document_version_ids: [docId], mode: "default", plan_first: false });
}

test("H1：在没进快照的原件上修订，返回的改前整段里那个姓名发往模型时仍是代号", { timeout: 150_000 }, async () => {
  const NAME = "柏青禾";
  const { matter, a, b } = await matterWithUnseenDocx("B41SRC1", NAME);
  const after: string[] = [];
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("B41SRC1")) return null;
    const res = ms.find((m) => m.role === "tool" && m.tool_call_id === "rev_1");
    if (!res) return { toolCalls: [{ id: "rev_1", name: "mcp__legal__docx_revise", args: { document_version_id: b.document_version_id, patches: [{ anchor: "负责安装与验收", proposed_text: "负责安装、调试与验收" }] } }] };
    after.push(JSON.stringify(body));
    return { content: "已在对方稿上修订。" };
  };
  try {
    const run = await startRun(matter.matter_id, a.document_version_id, "B41SRC1", "在对方稿上把验收改成安装调试验收");
    await waitRun(tk.inv, run.run_id, 120_000);
    assert.equal(after.length > 0, true, "修订结果交回了模型");
    const sent = after.at(-1)!;
    assert.match(sent, /负责安装、调试与验收/, "改后整段在返回里");
    assert.equal(sent.includes(NAME), false, "原件里从没识别过的姓名不以明文发往模型");
    assert.match(sent, /卖方联系人：〔自然人·[0-9A-Z]{6}〕/);
  } finally {
    cloud.model.script = null;
  }
});

test("H2：审合同任务的复核对象里有清洁稿（源自从没识别过的原件），复核请求里那个姓名仍是代号；找不到原件的整段完整识别并记事件", { timeout: 150_000 }, async () => {
  const NAME = "苗望舒";
  const { matter, a, b } = await matterWithUnseenDocx("B41SRC2", NAME);
  const reviewed: string[] = [];
  let runId = "";
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes("现在独立复核")) {
      reviewed.push(JSON.stringify(body));
      return { content: "未发现实质问题。" };
    }
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("B41SRC2")) return null;
    if (!ms.some((m) => m.role === "tool" && m.tool_call_id === "render_1")) return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "审查意见书（内部稿）", sections: [{ heading: "一、审查结论", paragraphs: ["对方稿第 1.2 条验收安排需补充。"] }] } }] };
    // 模拟另一条路径登记的清洁稿（不经 docx.revise、原件从没识别过）：一份写明原件，一份 manifest 缺原件编号
    const db = tk.kernel.db;
    const src = db.get<{ storage_uri: string; sha256: string; tenant_id: string; created_by: string }>(`SELECT dv.storage_uri, dv.sha256, r.tenant_id, r.created_by FROM document_versions dv JOIN runs r ON r.run_id = ? WHERE dv.document_version_id = ?`, [runId, b.document_version_id])!;
    const add = (filename: string, manifest: Record<string, unknown>) =>
      db.run(
        `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by, lineage)
         VALUES (?,?,?,?,'revision_clean',(SELECT COALESCE(MAX(version),0)+1 FROM artifact_versions WHERE matter_id = ? AND kind = 'revision_clean'),NULL,'internal','draft',?,?,?,'[]',?,?,NULL)`,
        [`artv_${randomUUID()}`, src.tenant_id, matter.matter_id, runId, matter.matter_id, filename, src.sha256, src.storage_uri, JSON.stringify(manifest), src.created_by],
      );
    if (!db.get(`SELECT 1 FROM artifact_versions WHERE run_id = ? AND kind = 'revision_clean'`, [runId])) {
      add("设备买卖合同（对方稿）（清洁稿）.docx", { tool: "docx.revise", source_document_version_id: b.document_version_id });
      add("另一份（清洁稿）.docx", { tool: "docx.revise" });
    }
    return { content: "已出审查意见书，并在对方稿上修订。" };
  };
  try {
    const run = await startRun(matter.matter_id, a.document_version_id, "B41SRC2", "审查对方稿", "contract-review");
    runId = run.run_id;
    const done = await waitRun(tk.inv, run.run_id, 120_000);
    assert.equal(reviewed.length, 1, JSON.stringify(done.events.map((e: any) => e.type)));
    const u = reviewed[0]!;
    assert.match(u, /设备买卖合同（对方稿）（清洁稿）\.docx/, "清洁稿进了复核对象");
    assert.equal(u.includes(NAME), false, "原件里从没识别过的姓名不以明文交给复核人");
    assert.match(u, /卖方联系人：〔自然人·[0-9A-Z]{6}〕/);
    const ev = done.events.find((e: any) => e.type === "review.source_unread");
    assert.equal(ev?.payload.files, 1, "找不到原件的那一份如实记事件");
  } finally {
    cloud.model.script = null;
  }
});

test("M1：docx.edit_draft 不能改《修改对照表》（内容是原件原文）；修订结果里的姓名同样是代号", { timeout: 150_000 }, async () => {
  const NAME = "邵清川";
  const { matter, a, b } = await matterWithUnseenDocx("B41SRC3", NAME);
  const results: string[] = [];
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("B41SRC3")) return null;
    const rev = ms.find((m) => m.role === "tool" && m.tool_call_id === "rev_1");
    if (!rev) return { toolCalls: [{ id: "rev_1", name: "mcp__legal__docx_revise", args: { document_version_id: b.document_version_id, patches: [{ anchor: "负责安装与验收", proposed_text: "负责安装、调试与验收" }] } }] };
    const edit = ms.find((m) => m.role === "tool" && m.tool_call_id === "edit_1");
    if (!edit) {
      const cmp = /"comparison":\s*\{\s*"artifact_version_id":\s*"(artv_[0-9a-f-]+)"/.exec(String(rev.content ?? ""))?.[1];
      return { toolCalls: [{ id: "edit_1", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: cmp ?? "artv_missing", patches: [{ anchor: "负责安装", proposed_text: "负责安装（已核）" }] } }] };
    }
    results.push(JSON.stringify(body), String(edit.content ?? ""));
    return { content: "已修订。" };
  };
  try {
    const run = await startRun(matter.matter_id, a.document_version_id, "B41SRC3", "在对方稿上修订并整理对照表");
    const done = await waitRun(tk.inv, run.run_id, 120_000);
    assert.ok(results.length > 0);
    assert.match(results[1]!, /不是 docx\.render_report 生成的[\s\S]*修改对照表/, results[1]!);
    const at = results[0]!.indexOf(NAME);
    assert.equal(at, -1, results[0]!.slice(Math.max(0, at - 300), at + 100));
    const tables = done.artifacts.filter((x: any) => /修改对照表/.test(x.filename));
    assert.equal(tables.length, 1, "对照表没有被改出新版本");
  } finally {
    cloud.model.script = null;
  }
});
