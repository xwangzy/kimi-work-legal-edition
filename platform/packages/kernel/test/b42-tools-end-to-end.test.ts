/**
 * 第 42 批（经本机工具端点，与助手调用同一条路）：
 * 1. 出文书、出表格、改草稿时，质量说明由内核直接删掉，工具结果里告诉助手已删；
 * 2. 每次工具操作在账本里多记一份状态摘要（只有状态词与计数），验收脚本据此统计锚点命中、交付前检查问题数。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { extractParagraphs, readCreatedXlsx } from "@zr-legal/docx-engine";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { toolResultSummary, toolResultSummaryJson } from "../src/tools/result-summary.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b42-tools-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("质量说明不进文书与表格；修改草稿想加回去的那一条被退回；账本记下状态摘要", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "质量说明", stance: "买方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-12" } });
  const live = liveTaskIdentity(tk, matter.matter_id, "b42_quality");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, JSON.stringify(r).slice(0, 400));
    return r.result.structuredContent;
  };
  const textOf = async (id: string) => extractParagraphs(Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: id })).data_base64, "base64")).map((x) => x.text).join("\n");
  try {
    // 文书：首段是质量说明，另一段连着“内部工作稿”
    const r1 = await call("docx.render_report", {
      title: "管辖与时效分析备忘录",
      sections: [
        { heading: "一、说明", paragraphs: ["通用辅助 · 未经本所质量验收", "内部工作稿 · 草稿 · 待律师复核", "本备忘录依据委托人提供的合同与往来函件。"] },
        { heading: "二、结论", paragraphs: ["合同约定由买方所在地法院管辖。"] },
      ],
    });
    assert.match(r1.auto_cleaned, /已删去文件里的 2 处质量说明/);
    const t1 = await textOf(r1.artifact_version_id);
    assert.doesNotMatch(t1, /未经本所质量验收|通用辅助|待律师复核/);
    assert.match(t1, /内部工作稿/);
    assert.match(t1, /本备忘录依据委托人提供的合同与往来函件/);

    // 修改草稿：一条只加质量说明（退回），一条正常修改（写入）
    const r2 = await call("docx.edit_draft", {
      artifact_version_id: r1.artifact_version_id,
      patches: [
        { anchor: "内部工作稿", proposed_text: "通用辅助 · 未经本所质量验收", insert_after: true },
        { anchor: "买方所在地法院", proposed_text: "买方住所地人民法院" },
      ],
    });
    assert.equal(r2.status, "partial", JSON.stringify(r2).slice(0, 400));
    assert.deepEqual(r2.conflicts.map((c: any) => [c.index, c.reason]), [[0, "quality_line"]]);
    const t2 = await textOf(r2.artifact_version_id);
    assert.doesNotMatch(t2, /未经本所质量验收/);
    assert.match(t2, /买方住所地人民法院/);

    // 表格：“说明”页两行质量说明整行去掉，核对清单里的一格清空
    const r3 = await call("xlsx.render_table", {
      title: "提交前核对清单-测试",
      sheets: [
        { name: "说明", columns: ["项目", "内容"], rows: [["质量说明", "通用辅助 · 未经本所质量验收"], ["草稿状态", "草稿 · 待律师复核"], ["截止日", "2026-11-12"]] },
        { name: "核对清单", columns: ["序号", "核对项", "状态"], rows: [["1", "管辖条款", "已核"], ["2", "送达地址", "通用辅助 · 未经本所质量验收"]] },
      ],
    });
    assert.match(r3.auto_cleaned, /3 处质量说明/);
    const sheets = readCreatedXlsx(Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: r3.artifact_version_id })).data_base64, "base64"))!;
    assert.deepEqual(sheets[0]!.rows.map((r) => r.map(String)), [["项目", "内容"], ["截止日", "2026-11-12"]]);
    assert.deepEqual(sheets[1]!.rows.map((r) => r.map((c) => String(c ?? ""))), [["序号", "核对项", "状态"], ["1", "管辖条款", "已核"], ["2", "送达地址"]], "清空的格在读回时不占位");

    // 账本：三次写操作各有一份状态摘要
    const ops = tk.kernel.db.all<{ tool: string; status: string; result_summary: string | null }>(`SELECT tool, status, result_summary FROM tool_operations WHERE run_id = ? ORDER BY created_at`, [live.rid]);
    const by = (tool: string) => JSON.parse(ops.find((o) => o.tool === tool)!.result_summary!);
    assert.equal(by("docx.render_report").auto_cleaned, true);
    assert.equal(typeof by("docx.render_report").quality_ok, "boolean");
    assert.deepEqual(by("docx.edit_draft").conflict_reasons, { quality_line: 1 });
    assert.equal(by("docx.edit_draft").status, "partial");
    assert.equal(by("docx.edit_draft").applied, 1);
    assert.equal(by("xlsx.render_table").sheets, 2);
    // 摘要里没有任何正文
    for (const o of ops) assert.doesNotMatch(o.result_summary ?? "", /[一-鿿]/, o.result_summary ?? "");
  } finally {
    await agent.close();
  }
});

test("状态摘要只收状态词、计数与布尔值，不带文字", () => {
  const s = toolResultSummary({
    status: "partial",
    applied: 3,
    filename: "民事起诉状.docx",
    note: "只重交这几处",
    conflicts: [{ index: 1, reason: "anchor_not_found", detail: "张三欠款" }, { index: 2, reason: "anchor_not_found" }, { index: 3, reason: "含中文的原因" }],
    quality_check: { ok: false, issues: [{ kind: "internal_term", text: "未经本所质量验收" }, { kind: "numbering", text: "第三条" }, { kind: "internal_term", text: "fct_12ab" }], note: "发现 3 处" },
    shrink: { previous: 21, current: 10 },
    results: [{ title: "民法典" }, { title: "公司法" }],
  })!;
  assert.deepEqual(s, {
    status: "partial",
    applied: 3,
    n_results: 2,
    n_conflicts: 3,
    conflict_reasons: { anchor_not_found: 2 },
    quality_ok: false,
    quality_issues: 3,
    quality_kinds: { internal_term: 2, numbering: 1 },
    shrink: true,
  });
  assert.doesNotMatch(toolResultSummaryJson({ status: "张三", title: "李四诉王五" }) ?? "", /张三|李四/);
  assert.equal(toolResultSummary("纯文字结果"), null);
  assert.equal(toolResultSummary(null), null);
  assert.deepEqual(toolResultSummary([1, 2, 3]), { n: 3 });
});
