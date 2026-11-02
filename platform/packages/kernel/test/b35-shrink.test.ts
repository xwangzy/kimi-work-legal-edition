/**
 * 第 35 批真实走查 R1：同一任务里重出的同名文书或表格比上一版明显变短时，工具结果带缩水提示（shrink）；
 * 正常变长、小幅变短、第一次生成、别的任务同名成果都不提示。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { cellChars, sectionChars } from "../src/services/version-shrink.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "shrink-firm");
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
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 400)}`);
    return r.result.structuredContent;
  };
  return { call, close: () => agent.close() };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => [`第${i + 1}条`, `写法要点与起草理由第${i + 1}项，说明为什么这样写、对我方的保护与对方可能的修改。`]);

test("表格与文书：同一任务里重出的同名成果比上一版少 20% 以上时提示，其余不提示", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "缩水检查", stance: "受让方", consent_status: "agreed" });
  const a = await agentFor(matter.matter_id, "shrink");
  try {
    const t1 = await a.call("xlsx.render_table", { title: "起草说明", sheets: [{ name: "起草说明", columns: ["条款", "写法要点"], rows: rows(20) }] });
    assert.equal(t1.shrink, undefined, "第一次生成不提示");
    const t2 = await a.call("xlsx.render_table", { title: "起草说明", sheets: [{ name: "起草说明", columns: ["条款", "写法要点"], rows: rows(18) }] });
    assert.equal(t2.shrink, undefined, "少 10%：不提示");
    const t3 = await a.call("xlsx.render_table", { title: "起草说明", sheets: [{ name: "起草说明", columns: ["条款", "写法要点"], rows: rows(9) }] });
    assert.ok(t3.shrink, "比上一版少一半：提示");
    assert.equal(t3.shrink.previous_artifact_version_id, t2.artifact_version_id, "与紧邻的上一版比");
    assert.match(t3.shrink.note, /少了约 5\d%.*保留上一版的全部内容/);
    const t4 = await a.call("xlsx.render_table", { title: "起草说明", sheets: [{ name: "起草说明", columns: ["条款", "写法要点"], rows: rows(22) }] });
    assert.equal(t4.shrink, undefined, "变长不提示");

    const sec = (n: number) => [{ heading: "第一条 定义", paragraphs: Array.from({ length: n }, (_, i) => `1.${i + 1} 定义第${i + 1}项的完整写法，含范围、例外与计算口径。`) }];
    const d1 = await a.call("docx.render_report", { title: "股权转让协议", sections: sec(9) });
    assert.equal(d1.shrink, undefined);
    const d2 = await a.call("docx.render_report", { title: "股权转让协议", sections: sec(6) });
    assert.ok(d2.shrink, "定义从 9 款压成 6 款：提示");
    const other = await a.call("docx.render_report", { title: "另一份文书", sections: sec(2) });
    assert.equal(other.shrink, undefined, "别的文书不比");
  } finally {
    await a.close();
  }
});

test("字数口径：文书含标题、段落与表格格子；表格含全部格子", () => {
  assert.equal(sectionChars([{ heading: "一", paragraphs: ["二三", "四"], table: { columns: ["五"], rows: [["六七", null]] } }]), 7);
  assert.equal(cellChars([["甲", 12], [null, "乙丙"]]), 5);
  assert.equal(sectionChars(null), 0);
});
