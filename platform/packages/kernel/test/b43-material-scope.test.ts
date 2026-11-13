/**
 * V18 第 43 批：勾选的材料就是本任务的边界。
 * 原先不论勾没勾，助手都能按编号读本事项的任何材料（材料目录的说明里写着“其他材料可用 materials.read_excerpt 按 parse_version_id 读取”）；
 * 真实回归里交割清单只勾了签署版，成果却引用了没勾的章程与股东名册，而独立复核只看勾选的材料，两边范围对不上。
 * - 勾了材料的任务：材料目录里没勾的只有文件名（not_provided），没有编号；按编号读取、修订、比对没勾的材料一律拒绝；
 * - 一份都没勾的任务：不设边界，本事项材料都可读（只写一句话就发起的自由描述任务）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { importText, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "material-scope-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function agentFor(matterId: string, label: string, selected: string[]) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ document_version_ids: selected }), live.rid]);
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
  return { call, raw, close: () => agent.close() };
}

async function matterWithThree(title: string) {
  const { matter } = await tk.inv("matters.create", { title, stance: "投资方", consent_status: "agreed" });
  const a = await importText(tk.inv, matter.matter_id, "增资协议（签署版）.txt", "第一条 投资方以5000万元认购新增注册资本。");
  const b = await importText(tk.inv, matter.matter_id, "公司章程.txt", "第十八条 增资须经代表三分之二以上表决权的股东通过。");
  const c = await importText(tk.inv, matter.matter_id, "股东名册.txt", "1 创始人 60% 2 员工持股平台 40%");
  return { matter, a, b, c };
}
const parseOf = (docId: string) => tk.kernel.db.get<{ parse_version_id: string }>(`SELECT parse_version_id FROM parse_versions WHERE document_version_id = ? ORDER BY created_at DESC LIMIT 1`, [docId])!.parse_version_id;

test("勾了一份：目录里另两份只有文件名、没有编号；按编号读没勾的被拒绝，勾了的照常读", async () => {
  const { matter, a, b, c } = await matterWithThree("材料范围·勾一份");
  const ag = await agentFor(matter.matter_id, "scope1", [a.document_version_id]);
  try {
    const list = await ag.call("materials.list", {});
    const byName = new Map<string, any>(list.materials.map((m: any) => [m.filename, m]));
    const signed = byName.get("增资协议（签署版）.txt");
    assert.equal(signed.in_this_task, true);
    assert.equal(signed.snapshot_index, 1);
    assert.ok(signed.parse_version_id);
    for (const name of ["公司章程.txt", "股东名册.txt"]) {
      const m = byName.get(name);
      assert.equal(m.in_this_task, false, name);
      assert.equal(m.not_provided, true, name);
      assert.equal(m.parse_version_id, null, `${name} 不给解析编号`);
      assert.equal(m.document_version_id, null, `${name} 不给材料编号`);
      assert.equal(m.chars, 0);
    }
    assert.match(list.note, /not_provided=true 的材料这次没有勾选给本任务[\s\S]*不能读取[\s\S]*点名提醒律师/);
    // 说明文字经本机端点的代号替换后不能被认出“姓名”（第一版写“本事项里律师”，“项里”被当成姓名换成了代号）
    assert.equal(/〔/.test(list.note), false, list.note);
    assert.equal(/其他材料可用 materials\.read_excerpt/.test(list.note), false, "不再提示可以读其他材料");
    // 勾了的照常读
    const ok = await ag.call("materials.read_excerpt", { parse_version_id: parseOf(a.document_version_id) });
    assert.match(ok.text, /5000万元/);
    // 没勾的：即使助手从别处知道了编号也读不了，错误里说明该怎么办
    for (const d of [b, c]) {
      const r = await ag.raw("materials.read_excerpt", { parse_version_id: parseOf(d.document_version_id) });
      assert.equal(r.result?.isError, true, JSON.stringify(r).slice(0, 300));
      assert.match(JSON.stringify(r), /没有勾选给本次任务，不能读取[\s\S]*请律师在追问时补勾这份材料，或勾选后重新发起任务/);
      assert.equal(/三分之二|员工持股平台/.test(JSON.stringify(r)), false, "拒绝时不带出材料内容");
    }
    // 修订、比对同样只认勾选的（清理元数据、脱敏两个工具不在助手的工具面里，内核入口同样加了把关）
    for (const [name, args] of [
      ["docx.revise", { document_version_id: b.document_version_id, patches: [] }],
      ["docx.compare", { baseline_document_version_id: a.document_version_id, current_document_version_id: b.document_version_id }],
    ] as const) {
      const r = await ag.raw(name, args);
      assert.match(JSON.stringify(r), /没有勾选给本次任务/, `${name}: ${JSON.stringify(r).slice(0, 300)}`);
    }
  } finally {
    await ag.close();
  }
});

test("一份都没勾：不设边界，本事项材料都列出编号、都可读，目录说明写明这一点", async () => {
  const { matter, b } = await matterWithThree("材料范围·没勾");
  const ag = await agentFor(matter.matter_id, "scope0", []);
  try {
    const list = await ag.call("materials.list", {});
    assert.equal(list.materials.length, 3);
    for (const m of list.materials) {
      assert.ok(m.parse_version_id, m.filename);
      assert.equal(m.not_provided, undefined);
    }
    assert.match(list.note, /本任务发起时没有勾选材料：本事项的材料都可用 materials\.read_excerpt/);
    const r = await ag.call("materials.read_excerpt", { parse_version_id: parseOf(b.document_version_id) });
    assert.match(r.text, /三分之二/);
  } finally {
    await ag.close();
  }
});

test("别的事项的材料编号：照旧按“不存在”处理，不因为范围检查泄露它是否存在", async () => {
  const one = await matterWithThree("材料范围·事项甲");
  const two = await matterWithThree("材料范围·事项乙");
  const ag = await agentFor(one.matter.matter_id, "scopex", [one.a.document_version_id]);
  try {
    const r = await ag.raw("materials.read_excerpt", { parse_version_id: parseOf(two.b.document_version_id) });
    assert.equal(r.result?.isError, true);
    assert.equal(/没有勾选给本次任务|公司章程/.test(JSON.stringify(r)), false, JSON.stringify(r).slice(0, 300));
  } finally {
    await ag.close();
  }
});
