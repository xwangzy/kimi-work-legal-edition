/**
 * V12：docx.edit_draft 基于旧版本修改会丢更新（第 36 批“待拍板”遗留）。
 * 多轮修改里助手拿旧的 artifact_version_id 再改：新版本是在旧版本上改出来的，上一轮的修改不在里面，
 * 却登记成“最新版”——律师看到的最新文书悄悄少了已经改好的内容（非授权丢失原有内容）。
 * - edit_draft：只能在这份文书的最新版本上改（乐观并发）；不是最新的整体不写，返回 stale_version 与最新版本编号；
 * - 改回与更早某版一模一样的内容：登记为新的最新版（不能复用旧编号，否则“最新版”仍是改回之前那版）；
 * - docx.revise 多轮：每次都在原件上重出，后一轮没带上前一轮的修改时提示助手（不再悄悄只剩后一轮的修改）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createStyledDocx, extractParagraphs } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { withFileVersions } from "../src/services/artifact-lineage.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "edit-draft-stale-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function agentFor(matterId: string, label: string) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const raw = async (name: string, args: unknown) =>
    (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
  const call = async (name: string, args: unknown) => {
    const r = await raw(name, args);
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 600)}`);
    return r.result.structuredContent;
  };
  return { live, raw, call, close: () => agent.close() };
}

/** 律师看到的“最新版”（与界面同一口径：同一 lineage 里版本号最大的）。 */
function latestOf(matterId: string, runId: string, kind: string, filename: string): string {
  const rows = tk.kernel.db.all<{ artifact_version_id: string; matter_id: string; kind: string; audience: string; version: number; lineage: string | null }>(
    `SELECT artifact_version_id, matter_id, kind, audience, version, lineage FROM artifact_versions WHERE run_id = ? AND kind = ? AND filename = ?`,
    [runId, kind, filename],
  );
  const latest = withFileVersions(tk.kernel.db, matterId, rows).filter((r) => r.is_latest);
  assert.equal(latest.length, 1, JSON.stringify(rows));
  return latest[0]!.artifact_version_id;
}

const p = (t: string) => ({ kind: "p" as const, runs: [{ text: t }] });
const contract = () =>
  createStyledDocx(
    [
      { kind: "title", text: "技术服务合同" },
      { kind: "h1", text: "第三条 服务费用" },
      p("3.2 甲方应于本合同签订之日起五个工作日内一次性支付全部服务费用。"),
      { kind: "h1", text: "第八条 争议解决" },
      p("8.1 协商不成的，提交乙方所在地有管辖权的人民法院诉讼解决。"),
    ],
    undefined,
    null,
    { mark: false },
  );

const textOf = async (id: string) => extractParagraphs(Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: id })).data_base64, "base64")).map((x) => x.text).join("\n");

test("基于旧版本再改：整体不写，返回 stale_version 与最新版本编号；在最新版本上改两轮修改都在", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "多轮修改", stance: "受让方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-04" } });
  const a = await agentFor(matter.matter_id, "stale");
  try {
    const r1 = await a.call("docx.render_report", {
      title: "股权转让协议",
      sections: [
        { heading: "第一条 标的股权", paragraphs: ["1.1 转让方应于交割前办理变更登记。"] },
        { heading: "第二条 违约责任", paragraphs: ["2.1 转让方迟延支付赔偿款的，应支付资金占用利息。"] },
        { heading: "第三条 争议解决", paragraphs: ["3.1 因本协议发生的争议，提交上海仲裁委员会仲裁。"] },
      ],
    });
    // 第一轮：在 r1 上改“迟延”
    const r2 = await a.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "迟延支付", proposed_text: "逾期支付" }] });
    assert.equal(r2.status, "applied", JSON.stringify(r2));
    // 第二轮：助手仍拿 r1 的编号改仲裁机构——此前照常写入，新版本里“逾期支付”丢了，却成了最新版
    const before = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_versions WHERE run_id = ?`, [a.live.rid])!.n;
    const stale = await a.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "上海仲裁委员会", proposed_text: "上海国际仲裁中心" }] });
    assert.equal(stale.status, "not_applied", `基于旧版本的修改不能写入：${JSON.stringify(stale)}`);
    assert.equal(stale.written, false);
    assert.equal(stale.reason, "stale_version");
    assert.equal(stale.latest_artifact_version_id, r2.artifact_version_id, "告诉助手最新版本的编号");
    assert.match(stale.note, new RegExp(r2.artifact_version_id), "改法里写明用哪个编号");
    assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_versions WHERE run_id = ?`, [a.live.rid])!.n, before, "没有登记新版本");
    // 试写也一样拦（否则试写通过、正式提交才失败）
    const dry = await a.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, dry_run: true, patches: [{ anchor: "上海仲裁委员会", proposed_text: "上海国际仲裁中心" }] });
    assert.equal(dry.reason, "stale_version");
    assert.equal(latestOf(matter.matter_id, a.live.rid, "agent_report", "股权转让协议.docx"), r2.artifact_version_id, "最新版仍是 r2");

    // 按返回的编号在最新版本上改：两轮修改都在
    const r3 = await a.call("docx.edit_draft", { artifact_version_id: stale.latest_artifact_version_id, patches: [{ anchor: "上海仲裁委员会", proposed_text: "上海国际仲裁中心" }] });
    assert.equal(r3.status, "applied", JSON.stringify(r3));
    assert.equal(latestOf(matter.matter_id, a.live.rid, "agent_report", "股权转让协议.docx"), r3.artifact_version_id);
    const all = await textOf(r3.artifact_version_id);
    assert.ok(all.includes("逾期支付") && all.includes("上海国际仲裁中心"), all);

    // 同名文书整份重出（docx.render_report）之后，旧的 edit_draft 版本也不是最新了
    const r4 = await a.call("docx.render_report", {
      title: "股权转让协议",
      sections: [
        { heading: "第一条 标的股权", paragraphs: ["1.1 转让方应于交割前办理变更登记。"] },
        { heading: "第二条 违约责任", paragraphs: ["2.1 转让方逾期支付赔偿款的，应支付资金占用利息。"] },
        { heading: "第三条 争议解决", paragraphs: ["3.1 因本协议发生的争议，提交上海国际仲裁中心仲裁。", "3.2 仲裁裁决是终局的。"] },
      ],
    });
    const stale2 = await a.call("docx.edit_draft", { artifact_version_id: r3.artifact_version_id, patches: [{ anchor: "变更登记", proposed_text: "股权变更登记" }] });
    assert.equal(stale2.reason, "stale_version");
    assert.equal(stale2.latest_artifact_version_id, r4.artifact_version_id);
  } finally {
    await a.close();
  }
});

test("改回与更早某版相同的内容：登记为新的最新版，不复用旧编号", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "改回", stance: "受让方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-04" } });
  const a = await agentFor(matter.matter_id, "revert");
  try {
    const r1 = await a.call("docx.render_report", { title: "律师函", sections: [{ heading: "一、事实", paragraphs: ["贵方迟延交货已逾三十日。"] }] });
    const r2 = await a.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "迟延交货", proposed_text: "逾期交货" }] });
    const r3 = await a.call("docx.edit_draft", { artifact_version_id: r2.artifact_version_id, patches: [{ anchor: "三十日", proposed_text: "四十日" }] });
    // 律师说“四十日”不对，改回：内容与 r2 一模一样
    const r4 = await a.call("docx.edit_draft", { artifact_version_id: r3.artifact_version_id, patches: [{ anchor: "四十日", proposed_text: "三十日" }] });
    assert.equal(r4.status, "applied", JSON.stringify(r4));
    const latest = latestOf(matter.matter_id, a.live.rid, "agent_report", "律师函.docx");
    assert.equal(latest, r4.artifact_version_id, `返回的编号就是最新版（r2=${r2.artifact_version_id} r3=${r3.artifact_version_id} r4=${r4.artifact_version_id}）`);
    assert.ok((await textOf(latest)).includes("三十日"), "最新版是改回后的内容");
    // 再改一次照常（返回的编号确是最新）
    const r5 = await a.call("docx.edit_draft", { artifact_version_id: r4.artifact_version_id, patches: [{ anchor: "逾期交货", proposed_text: "逾期交付货物" }] });
    assert.equal(r5.status, "applied", JSON.stringify(r5));
    // 响应丢了、助手拿 r4 原样重试：本机端点按幂等键重放上次结果（就是 r5），不会在 r4 上又出一版
    const again = await a.call("docx.edit_draft", { artifact_version_id: r4.artifact_version_id, patches: [{ anchor: "逾期交货", proposed_text: "逾期交付货物" }] });
    assert.equal(again.artifact_version_id, r5.artifact_version_id);
    // 换一处修改仍拿 r4：已不是最新，拦下并给出 r5
    const stale = await a.call("docx.edit_draft", { artifact_version_id: r4.artifact_version_id, patches: [{ anchor: "三十日", proposed_text: "30 日" }] });
    assert.equal(stale.reason, "stale_version");
    assert.equal(stale.latest_artifact_version_id, r5.artifact_version_id);

    // 整份重出：A → B → 又交一次与 A 完全相同的调用——本机端点不能重放 A 的旧编号（最新版仍是 B），要登记成新的最新版
    const secs = (x: string) => [{ heading: "一、事实", paragraphs: [`贵方${x}交货已逾三十日。`] }];
    const g1 = await a.call("docx.render_report", { title: "催告函", sections: secs("迟延") });
    const dup = await a.call("docx.render_report", { title: "催告函", sections: secs("迟延") });
    assert.equal(dup.artifact_version_id, g1.artifact_version_id, "原样重试仍重放（不多出一版）");
    const g2 = await a.call("docx.render_report", { title: "催告函", sections: secs("逾期") });
    const g3 = await a.call("docx.render_report", { title: "催告函", sections: secs("迟延") });
    assert.equal(latestOf(matter.matter_id, a.live.rid, "agent_report", "催告函.docx"), g3.artifact_version_id, `g1=${g1.artifact_version_id} g2=${g2.artifact_version_id} g3=${g3.artifact_version_id}`);
    assert.notEqual(g3.artifact_version_id, g1.artifact_version_id);
    assert.ok((await textOf(g3.artifact_version_id)).includes("迟延"));
    const again3 = await a.call("docx.render_report", { title: "催告函", sections: secs("迟延") });
    assert.equal(again3.artifact_version_id, g3.artifact_version_id, "g3 仍是最新：原样重试照旧重放");
    const ops = tk.kernel.db.all<{ status: string }>(`SELECT status FROM tool_operations WHERE run_id = ? AND tool = 'docx.render_report'`, [a.live.rid]);
    assert.ok(ops.every((o) => o.status === "succeeded"), JSON.stringify(ops));
  } finally {
    await a.close();
  }
});

test("docx.revise 多轮：每次都在原件上重出；后一轮没带上前一轮的修改时提示助手", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "多轮修订", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-04" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "技术服务合同.docx", contract(), DOCX_MIME);
  const a = await agentFor(matter.matter_id, "revise-rounds");
  try {
    const round1 = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "五个工作日", proposed_text: "十个工作日" }] });
    assert.equal(round1.status, "applied", JSON.stringify(round1));
    assert.equal(round1.previous_round, undefined, "第一轮没有前一轮");
    // 第二轮只交了新增的修改：修订稿在原件上重出，只含第二轮这一处
    const round2 = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "乙方所在地", proposed_text: "甲方所在地" }] });
    assert.equal(round2.status, "applied", JSON.stringify(round2));
    assert.ok(round2.previous_round, `提示前一轮的修改没有带上：${JSON.stringify(round2).slice(0, 800)}`);
    assert.equal(round2.previous_round.revision_artifact_version_id, round1.revision.artifact_version_id);
    assert.equal(round2.previous_round.missing.length, 1);
    assert.match(round2.previous_round.missing[0].after, /十个工作日/);
    assert.match(round2.previous_round.note, /全部修改/);
    // 第三轮带上了全部修改（同一段里还多改了付款方式）：不再提示
    const round3 = await a.call("docx.revise", {
      document_version_id: doc.document_version_id,
      patches: [
        { anchor: "五个工作日内一次性支付", proposed_text: "十个工作日内分两期支付" },
        { anchor: "乙方所在地", proposed_text: "甲方所在地" },
      ],
    });
    assert.equal(round3.status, "applied", JSON.stringify(round3));
    assert.equal(round3.previous_round, undefined, JSON.stringify(round3.previous_round));
    const clean = await textOf(round3.clean.artifact_version_id);
    assert.ok(clean.includes("十个工作日内分两期支付") && clean.includes("甲方所在地"), clean);
    // 第四轮删掉了第三轮新增的“分两期”、也没交第八条：两处都列出（删字的也查得出）
    const round4 = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "五个工作日", proposed_text: "十个工作日" }] });
    assert.equal(round4.previous_round?.revision_artifact_version_id, round3.revision.artifact_version_id, JSON.stringify(round4));
    assert.deepEqual(round4.previous_round.missing.map((m: any) => m.kind), ["edit", "edit"], JSON.stringify(round4.previous_round));
  } finally {
    await a.close();
  }
});

test("docx.revise 撤回第二轮、回到第一轮的改法：清洁稿登记为新的最新版（不复用第一轮的旧编号）", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "撤回修订", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-04" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "技术服务合同.docx", contract(), DOCX_MIME);
  const a = await agentFor(matter.matter_id, "revise-back");
  try {
    const r1 = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "五个工作日", proposed_text: "十个工作日", comment: "付款期限过短" }] });
    const r2 = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "五个工作日", proposed_text: "十五个工作日", comment: "按客户意见" }] });
    // 律师：还是按第一轮的“十个工作日”。批注不同（修订稿不同），清洁稿与第一轮的字节相同
    const r3 = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "五个工作日", proposed_text: "十个工作日", comment: "回到第一轮的改法" }] });
    assert.equal(r3.status, "applied", JSON.stringify(r3));
    const ids = JSON.stringify({ r1: r1.clean, r2: r2.clean, r3: r3.clean });
    assert.equal(latestOf(matter.matter_id, a.live.rid, "revision_draft", "技术服务合同（修订稿）.docx"), r3.revision.artifact_version_id);
    assert.equal(latestOf(matter.matter_id, a.live.rid, "revision_clean", "技术服务合同（清洁稿）.docx"), r3.clean.artifact_version_id, `清洁稿的最新版是第三轮的：${ids}`);
    assert.ok((await textOf(r3.clean.artifact_version_id)).includes("十个工作日"));
  } finally {
    await a.close();
  }
});
