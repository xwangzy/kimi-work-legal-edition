/**
 * 第 57 批：docx.edit_draft 的四个定位缺陷（真实任务“劳动仲裁应对”取证，模型把 Word 表格里的旧数改成新数）：
 * 1. 冲突序号从 0 起计却没注明：一次交 34 处、9 处歧义，模型按 1 起重交，重交的全是已写入的，真正没写进去的一处没重交；
 * 2. occurrence 只在同一段内计数：“35,162.36”同时在“月均”格与算式格“6×35,162.36×2”里，occurrence 消不了歧义；
 * 3. 全文只剩一处匹配时不看位置提示：锚点 421,948.32 加格子提示，全文只剩口径说明段那一处，工具直接改了那一处；
 * 4. 试写只返回通过数：14 处通过 11 处，看不到是哪 3 处、为什么。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { sectionsOfDocx } from "../src/tools/tools/edit-draft.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b57-edit-anchors-firm");
});
after(async () => {
  await tk.kernel.close();
});

/** 赔偿测算表：35,162.36 既单独在“月均工资”格里，又在“违法解除赔偿金”行的算式格里；421,948.32 既在表里又在口径说明段里。 */
const REPORT = {
  title: "劳动仲裁应对意见",
  sections: [
    { heading: "一、赔偿测算", paragraphs: ["申请人主张的各项金额测算如下："], table: { columns: ["项目", "金额（元）", "计算"], rows: [["月均工资", "35,162.36", "离职前十二个月平均"], ["违法解除赔偿金", "421,948.32", "6×35,162.36×2"], ["未休年休假工资", "9,700.00", "按 2026年3月 口径"]] } },
    { heading: "二、口径说明", paragraphs: ["赔偿金合计421,948.32元按申请人主张的月均工资计算，2026年3月以后的奖金不计入。"] },
  ],
};

async function session(label: string) {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: `定位-${label}`, stance: "用人单位", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-22" } });
  const live = liveTaskIdentity(tk, matter.matter_id, `b57_${label}`);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, JSON.stringify(r).slice(0, 400));
    return r.result.structuredContent;
  };
  const read = async (id: string) => {
    const buf = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: id })).data_base64, "base64");
    const s = sectionsOfDocx(buf).sections;
    return { rows: s.find((x) => x.table)!.table!.rows ?? [], note: s.flatMap((x) => x.paragraphs ?? []).find((t) => t.startsWith("赔偿金合计"))! };
  };
  return { call, read, close: () => agent.close() };
}

test("缺陷 2：occurrence 按全文（含表格格子）先后计数；歧义退回逐处列出位置与上下文，并给出 occurrence 写法", { timeout: 120_000 }, async () => {
  const s = await session("occ");
  try {
    const r1 = await s.call("docx.render_report", REPORT);
    const amb = await s.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "35,162.36", proposed_text: "36,000.00" }] });
    assert.equal(amb.status, "not_applied", JSON.stringify(amb));
    const c = amb.conflicts[0];
    assert.equal(c.reason, "anchor_ambiguous");
    assert.equal(c.matches?.length, 2, JSON.stringify(c));
    assert.match(c.matches[0].where, /第 1 个表格第 2 行第 2 列/);
    assert.match(c.matches[1].where, /第 1 个表格第 3 行第 3 列/);
    assert.match(c.matches[1].context, /6×【35,162\.36】×2/);
    assert.match(c.fix, /occurrence: 2/);
    // 改算式格（全文第 2 处）：occurrence: 2；月均格不动
    const r2 = await s.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "35,162.36", proposed_text: "36,000.00", occurrence: 2 }] });
    assert.equal(r2.status, "applied", JSON.stringify(r2));
    const t = await s.read(r2.artifact_version_id);
    assert.equal(t.rows[0]![1], "35,162.36");
    assert.equal(t.rows[1]![2], "6×36,000.00×2");
    // 旧的从 0 起写法不再静默当“第一处”：退回并说明从 1 起
    const r3 = await s.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "35,162.36", proposed_text: "36,000.00", occurrence: 0 }] });
    assert.equal(r3.status, "not_applied");
    assert.equal(r3.conflicts[0].reason, "occurrence_out_of_range");
    assert.match(r3.conflicts[0].fix, /从 1 起/);
  } finally {
    await s.close();
  }
});

test("缺陷 3：全文只剩一处匹配、但与位置提示不符时不写入，退回说明锚点在哪里", { timeout: 120_000 }, async () => {
  const s = await session("hint");
  try {
    const r1 = await s.call("docx.render_report", REPORT);
    // 先把表里的赔偿金改掉（真实走查里这一格已在前一轮写入）
    const r2 = await s.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "421,948.32", proposed_text: "432,000.00", paragraph_hint: "违法解除赔偿金｜金额（元）" }] });
    assert.equal(r2.status, "applied", JSON.stringify(r2));
    // 再按同一格子提示交一次：全文只剩口径说明段那一处
    const r3 = await s.call("docx.edit_draft", { artifact_version_id: r2.artifact_version_id, patches: [{ anchor: "421,948.32", proposed_text: "432,000.00", paragraph_hint: "违法解除赔偿金｜金额（元）" }] });
    assert.equal(r3.status, "not_applied", JSON.stringify(r3));
    assert.equal(r3.conflicts[0].reason, "hint_mismatch");
    assert.match(r3.conflicts[0].fix, /只在.*正文段落.*出现.*与你给的位置提示/);
    assert.match(r3.conflicts[0].matches[0].context, /赔偿金合计【421,948\.32】元/);
    const t = await s.read(r2.artifact_version_id);
    assert.match(t.note, /赔偿金合计421,948\.32元/, "口径说明段没有被改");
    // 提示与唯一一处相符的照常写入
    const r4 = await s.call("docx.edit_draft", { artifact_version_id: r2.artifact_version_id, patches: [{ anchor: "421,948.32", proposed_text: "432,000.00", paragraph_hint: "赔偿金合计" }] });
    assert.equal(r4.status, "applied", JSON.stringify(r4));
  } finally {
    await s.close();
  }
});

test("缺陷 1：多处修改部分歧义，明细给从 1 起的 patch_no 与 anchor 原文；按明细只重交那几处即全部写入", { timeout: 120_000 }, async () => {
  const s = await session("multi");
  try {
    const r1 = await s.call("docx.render_report", REPORT);
    const patches = [
      { anchor: "离职前十二个月平均", proposed_text: "解除前十二个月平均" },
      { anchor: "35,162.36", proposed_text: "36,000.00" },
      { anchor: "9,700.00", proposed_text: "9,931.03" },
      { anchor: "2026年3月", proposed_text: "2026年4月" },
      { anchor: "按申请人主张的", proposed_text: "按仲裁请求所列的" },
    ];
    const r2 = await s.call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches });
    assert.equal(r2.status, "partial", JSON.stringify(r2));
    assert.deepEqual(r2.conflicts.map((c: any) => [c.patch_no, c.anchor, c.reason]), [[2, "35,162.36", "anchor_ambiguous"], [4, "2026年3月", "anchor_ambiguous"]]);
    assert.deepEqual(r2.applied_patch_nos, [1, 3, 5]);
    assert.match(r2.note, /patch_no/);
    // 按明细重交：两处都要改的，每一处各交一条，occurrence 取明细里的序号
    const again = r2.conflicts.flatMap((c: any) => c.matches.map((m: any) => ({ ...patches[c.patch_no - 1], occurrence: m.occurrence })));
    const r3 = await s.call("docx.edit_draft", { artifact_version_id: r2.artifact_version_id, patches: again });
    assert.equal(r3.status, "applied", JSON.stringify(r3));
    const t = await s.read(r3.artifact_version_id);
    assert.deepEqual(t.rows, [["月均工资", "36,000.00", "解除前十二个月平均"], ["违法解除赔偿金", "421,948.32", "6×36,000.00×2"], ["未休年休假工资", "9,931.03", "按 2026年4月 口径"]]);
    assert.equal(t.note, "赔偿金合计421,948.32元按仲裁请求所列的月均工资计算，2026年4月以后的奖金不计入。");
  } finally {
    await s.close();
  }
});

test("缺陷 4：试写返回逐条明细——通过的是哪几处，歧义、找不到的是哪几处及原因", { timeout: 120_000 }, async () => {
  const s = await session("dry");
  try {
    const r1 = await s.call("docx.render_report", REPORT);
    const r2 = await s.call("docx.edit_draft", {
      artifact_version_id: r1.artifact_version_id,
      dry_run: true,
      patches: [
        { anchor: "9,700.00", proposed_text: "9,931.03" },
        { anchor: "35,162.36", proposed_text: "36,000.00" },
        { anchor: "表里没有的 1,234.56", proposed_text: "1,000.00" },
      ],
    });
    assert.equal(r2.status, "preview", JSON.stringify(r2));
    assert.equal(r2.written, false);
    assert.deepEqual(r2.applied_patch_nos, [1]);
    assert.deepEqual(r2.conflicts.map((c: any) => [c.patch_no, c.reason]), [[2, "anchor_ambiguous"], [3, "anchor_not_found"]]);
    assert.equal(r2.conflicts[0].matches.length, 2);
  } finally {
    await s.close();
  }
});
