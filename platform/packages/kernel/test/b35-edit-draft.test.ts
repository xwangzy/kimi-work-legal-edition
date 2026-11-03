/**
 * 第 35 批：docx.edit_draft——在本任务已生成的文书草稿上逐处修改（真实走查 N1：为改两个词整份重出约 1 万字的协议 5 次，任务到时限停止）。
 * - 经本机端点调用：锚点照抄草稿文字（代号形态）即可定位；改好的是同名文书的新版本，旧版本保留、同一任务里串成“第 n 版”；
 * - 改后重做交付前检查；导出时代号还原真名；
 * - 律师上传的材料、别的任务的成果不能改；锚点找不到时整体不写、逐条给原因。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { createStyledDocx, extractParagraphs } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { findTool, legalToolLockProblems } from "../src/tools/registry.ts";
import { sectionsOfDocx } from "../src/tools/tools/edit-draft.ts";
import { deliveredBeforeDeadline } from "../src/executor/executor.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "edit-draft-firm");
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
    assert.equal(JSON.stringify(r).includes("周牧之"), false, `${name} 的结果交回 Agent 前须令牌化`);
    return r.result.structuredContent;
  };
  return { live, raw, call, close: () => agent.close() };
}

test("docx.edit_draft 已登记、锁文件一致、对 Agent 开放", () => {
  assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes("docx.edit_draft"));
  assert.ok(findTool("docx.edit_draft"));
  assert.equal(legalToolLockProblems().has("docx.edit_draft"), false, String(legalToolLockProblems().get("docx.edit_draft")));
});

test("在本任务的文书草稿上逐处修改：同名新版本、旧版本保留、代号照抄可定位、改后重做交付前检查、导出还原真名", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "股权转让", stance: "受让方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-02" } });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "周牧之", kind: "person" });
  const a = await agentFor(matter.matter_id, "edit");
  try {
    // 助手看到的转让方一姓名是代号（材料经令牌化）：生成文书时照抄代号
    const doc = await importBytes(tk.inv, matter.matter_id, "条款清单.txt", Buffer.from("转让方一：周牧之，持有目标公司45%股权。", "utf8"), "text/plain");
    const excerpt = await a.call("materials.read_excerpt", { parse_version_id: doc.parse_version_id, char_start: 0, char_end: 100 });
    const tok = /〔自然人·[^〕]+〕/.exec(JSON.stringify(excerpt))?.[0];
    assert.ok(tok, "材料里的姓名是代号");
    const r1 = await a.call("docx.render_report", {
      title: "股权转让协议",
      sections: [
        { heading: "", paragraphs: [`转让方一：${tok}（以下简称“转让方一”）`] },
        { heading: "第一条 标的股权", paragraphs: [`1.1 “星衡视觉检测平台V3.0”著作权登记在转让方一 personal名下的，转让方应于交割前办理变更登记。`] },
        { heading: "第二条 违约责任", paragraphs: ["2.1 转让方迟延支付赔偿款的，应按一年期贷款市场报价利率支付资金占用利息。"] },
        { heading: "第三条 争议解决", paragraphs: ["3.1 因本协议发生的争议，提交上海仲裁委员会仲裁。"] },
      ],
    });
    assert.ok(r1.artifact_version_id);
    assert.equal(r1.quality_check.ok, false, "生成时交付前检查报出夹杂英文");
    assert.ok(r1.quality_check.issues.some((i: any) => i.kind === "foreign_word"));
    assert.match(r1.quality_check.note, /docx\.edit_draft/, "检查结果指向逐处修改，不是整份重出");

    // 锚点找不到：整体不写，逐条给原因
    const miss = await a.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "转让方一 personal名下", proposed_text: "转让方一个人名下" }, { anchor: "草稿里没有的一句话", proposed_text: "x" }] });
    assert.equal(miss.status, "not_applied");
    assert.deepEqual(miss.conflicts.map((c: any) => [c.index, c.reason]), [[1, "anchor_not_found"]]);

    const r2 = await a.call("docx.edit_draft", {
      artifact_version_id: r1.artifact_version_id,
      patches: [
        { anchor: "转让方一 personal名下", proposed_text: "转让方一个人名下" },
        { anchor: "迟延支付", proposed_text: "逾期支付" },
        { anchor: `转让方一：${tok}（以下简称“转让方一”）`, proposed_text: `转让方一：${tok}（以下简称“转让方一”），身份证件号码【待填】` },
        { anchor: "3.1 因本协议发生的争议，提交上海仲裁委员会仲裁。", proposed_text: "3.2 仲裁裁决是终局的，对各方均有约束力。", insert_after: true },
      ],
    });
    assert.equal(r2.status, "applied", JSON.stringify(r2));
    assert.equal(r2.applied, 4);
    assert.notEqual(r2.artifact_version_id, r1.artifact_version_id, "新版本");
    assert.equal(r2.filename, "股权转让协议.docx", "同名");
    assert.equal(r2.quality_check.ok, true, `改后重做检查：${JSON.stringify(r2.quality_check.issues)}`);

    // 两个版本都在本任务下，串成同一份文书的两版
    const rows = tk.kernel.db.all<{ artifact_version_id: string; lineage: string | null; manifest: string }>(`SELECT artifact_version_id, lineage, manifest FROM artifact_versions WHERE run_id = ? AND kind = 'agent_report' ORDER BY created_at`, [a.live.rid]);
    assert.equal(rows.length, 2);
    assert.equal(JSON.parse(rows[1]!.manifest).edited_from, r1.artifact_version_id);
    assert.ok(rows[0]!.lineage, "有版本链");
    assert.equal(rows[0]!.lineage, rows[1]!.lineage, `同一任务同名成果串成一条版本链：${rows.map((r) => r.lineage).join(" / ")}`);

    // 导出（律师下载）：真名还原、修改已写入、无修订痕迹、插入的款在原位置之后
    const dl = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: r2.artifact_version_id })).data_base64, "base64");
    const text = extractParagraphs(dl).map((x) => x.text);
    const all = text.join("\n");
    assert.ok(all.includes("转让方一：周牧之（以下简称“转让方一”），身份证件号码【待填】"), "代号还原真名、修改写入");
    assert.ok(all.includes("转让方一个人名下") && !all.includes("personal"));
    assert.ok(all.includes("逾期支付") && !all.includes("迟延"));
    assert.ok(text.indexOf("3.2 仲裁裁决是终局的，对各方均有约束力。") === text.indexOf("3.1 因本协议发生的争议，提交上海仲裁委员会仲裁。") + 1, "插入的款紧接锚点段落");
    assert.equal(/<w:ins\b|<w:del\b/.test(dl.toString("latin1")), false, "草稿是助手自己的文字，不留修订痕迹");

    // 再改一次用新编号；用旧编号也可以（旧版本保留），但结果是又一个新版本
    const r3 = await a.call("docx.edit_draft", { artifact_version_id: r2.artifact_version_id, patches: [{ anchor: "上海仲裁委员会", proposed_text: "上海国际仲裁中心" }] });
    assert.equal(r3.status, "applied");

    // 律师上传的材料不能用本工具（用 docx.revise 出修订稿）
    const up = await a.raw("docx.edit_draft", { artifact_version_id: doc.document_version_id, patches: [{ anchor: "转让方一", proposed_text: "转让方甲" }] });
    assert.equal(up.result?.isError, true);

    // 到工作时限时主交付物已交出：给出“已交出、收尾没完成”的说明（第 35 批 N1）
    const d = deliveredBeforeDeadline(tk.kernel.db, a.live.rid, "合同草稿.docx");
    assert.ok(d && d.files.includes("股权转让协议.docx"), JSON.stringify(d));
    assert.match(d!.note, /已交出《股权转让协议》.*没有收尾/);
    assert.match(deliveredBeforeDeadline(tk.kernel.db, a.live.rid, "合同草稿.docx", 10 * 60_000)!.note, /在 10 分钟工作时限内/, "写本次实际下发的时限");
  } finally {
    await a.close();
  }
});

test("改后检查的节结构按文书引擎的标题样式还原（条款编号与互引检查照常生效）", () => {
  const buf = createStyledDocx([
    { kind: "title", text: "设备买卖合同" },
    { kind: "p", runs: [{ text: "甲方：某某公司" }] },
    { kind: "h1", text: "第一条 标的" },
    { kind: "p", runs: [{ text: "1.1 设备见附件。" }] },
    { kind: "h1", text: "第三条 付款" },
    { kind: "p", runs: [{ text: "3.1 按第五条付款。" }] },
  ]);
  const s = sectionsOfDocx(buf);
  assert.equal(s.title, "设备买卖合同");
  assert.deepEqual(s.sections.map((x) => x.heading), ["", "第一条 标的", "第三条 付款"]);
  assert.deepEqual(s.sections[2]!.paragraphs, ["3.1 按第五条付款。"]);
});

test("到工作时限时没有交出主交付物：照常记超时（不把只交了表格的起草任务记成部分完成）", async () => {
  const { matter } = await tk.inv("matters.create", { title: "未交文书", stance: "原告", consent_status: "agreed" });
  const live = liveTaskIdentity(tk, matter.matter_id, "none");
  assert.equal(deliveredBeforeDeadline(tk.kernel.db, live.rid, "合同草稿.docx"), null);
  tk.kernel.db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by)
     SELECT 'artv_sheet_only', tenant_id, matter_id, run_id, 'agent_table', 1, 'internal', 'draft', '起草说明.xlsx', 'x', 'blob://x', '[]', '{}', created_by FROM runs WHERE run_id = ?`,
    [live.rid],
  );
  assert.equal(deliveredBeforeDeadline(tk.kernel.db, live.rid, "合同草稿.docx"), null, "Word 主交付物没出，只有表格");
  assert.ok(deliveredBeforeDeadline(tk.kernel.db, live.rid, null), "没有指定主交付物时有表格即算交出");
});
