/**
 * 阶段 1 复审 N-01：令牌活性不能只在收到请求头时检查一次。
 *
 * “预开请求”= 先发请求头、等任务被取消/尝试被取代/任务进入终态之后再送请求体。v9 第 04 篇 §8：失去租约后不得读新材料、
 * 调上游、写产物。修复后：读完请求体、执行之前再复核；在途请求周期复核并在失效时中止上游流；提交点在同一事务内复核尝试与纪元。
 * 另含 N-02（不存在口径）、N-03（令牌声明与任务记录一致）、N-04（/v1/models 活性）。
 */
process.env.ZR_MOCK_SCRIPT = "1";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { __setMockScriptForTests } from "@zr-legal/model-broker";
import { makeKernel, importText, liveTaskIdentity, type TestKernel } from "./helpers.ts";
import { mintTaskToken, taskTokenKey } from "../src/identity.ts";
import { startLocalServer, localServerPort } from "../src/local-server.ts";

let tk: TestKernel;
let port: number;

before(async () => {
  tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock" }, "n01");
  port = tk.kernel.localPort;
});

after(async () => {
  __setMockScriptForTests(null);
  await tk.kernel.close();
});

/** 先发请求头，返回 send()（稍后送请求体）与 done（完整原始响应）。 */
function preopen(path: string, token: string, body: unknown, p = port): { send: () => void; done: Promise<string> } {
  const s = net.connect(p, "127.0.0.1");
  const buf = Buffer.from(JSON.stringify(body));
  let resp = "";
  const done = new Promise<string>((r) => {
    s.on("data", (c) => (resp += c.toString("utf8")));
    s.on("close", () => r(resp));
    s.on("error", (e) => r(`ERR ${e.message}`));
  });
  s.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${buf.length}\r\nConnection: close\r\n\r\n`);
  return { send: () => s.write(buf), done };
}

const statusOf = (raw: string): number => Number(raw.split("\r\n")[0]?.split(" ")[1] ?? 0);
const call = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ownMatter(label: string) {
  const { matter } = await tk.inv("matters.create", { title: `N-01 ${label}`, stance: "受让方", consent_status: "not_required" });
  const doc = await importText(tk.inv, matter.matter_id, "本事项材料.txt", `OWN-MATERIAL-${label} 本事项内容`);
  return { matter, doc };
}

async function routeAlias(): Promise<string> {
  return ((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { routes: string[] }).routes[0]!;
}

test("N-01 取消：取消之前发出请求头、取消之后才送请求体的预开请求一律 401——读不到材料、不调上游", { timeout: 60_000 }, async () => {
  const { matter, doc } = await ownMatter("cancel");
  const live = liveTaskIdentity(tk, matter.matter_id, "pre_cancel");
  const claims = { tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, jti: "agt_pre_cancel" };
  const toolTok = mintTaskToken({ ...claims, scope: ["tool:legal"] }, 600);
  const chatTok = mintTaskToken({ ...claims, scope: ["model:chat"] }, 600);
  const body = call("materials.read_excerpt", { parse_version_id: doc.parse_version_id });
  // 对照：取消前可读
  const ok = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${toolTok}` }, body: JSON.stringify(body) });
  assert.match(await ok.text(), /OWN-MATERIAL-cancel/);
  const route = await routeAlias();
  const pTool = preopen("/mcp", toolTok, body);
  const pChat = preopen("/v1/chat/completions", chatTok, { model: route, messages: [{ role: "user", content: "一加一等于几" }] });
  const pStream = preopen("/v1/chat/completions", chatTok, { model: route, stream: true, messages: [{ role: "user", content: "一加一等于几" }] });
  await sleep(200);
  const sv = tk.kernel.db.get<{ status_version: number }>(`SELECT status_version FROM runs WHERE run_id = ?`, [live.rid])!.status_version;
  await tk.inv("runs.cancel", { run_id: live.rid, expected_version: sv, reason: "N-01 急停" });
  pTool.send();
  pChat.send();
  pStream.send();
  const [rTool, rChat, rStream] = await Promise.all([pTool.done, pChat.done, pStream.done]);
  assert.equal(statusOf(rTool), 401, rTool.slice(0, 200));
  assert.ok(!rTool.includes("OWN-MATERIAL-cancel"), "取消之后读不到新材料");
  assert.equal(statusOf(rChat), 401, rChat.slice(0, 200));
  assert.equal(statusOf(rStream), 401, rStream.slice(0, 200));
  const eg = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM egress_records WHERE run_id = ?`, [live.rid])!;
  assert.equal(eg.n, 0, "取消之后没有任何上游调用（无出网记录）");
});

test("N-01 取代：被新尝试取代的旧尝试，其预开请求在取代之后送体 → 401", { timeout: 60_000 }, async () => {
  const { matter, doc } = await ownMatter("fence");
  const live = liveTaskIdentity(tk, matter.matter_id, "pre_fence");
  const tok = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: 1, scope: ["tool:legal"] }, 600);
  const p = preopen("/mcp", tok, call("materials.read_excerpt", { parse_version_id: doc.parse_version_id }));
  await sleep(200);
  tk.kernel.db.run(`UPDATE attempts SET status = 'interrupted' WHERE attempt_id = ?`, [live.aid]);
  tk.kernel.db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,2,'running',2)`, [`${live.aid}_2`, live.rid]);
  p.send();
  const r = await p.done;
  assert.equal(statusOf(r), 401);
  assert.ok(!r.includes("OWN-MATERIAL-fence"));
});

test("N-01 终态 + 写类工具：任务终止之后才送体的写类调用不执行、不留 outbox 行、不产生副作用", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "n01-"));
  const servers = await startLocalServer({ db: tk.kernel.db, blobs: tk.kernel.blobs, broker: {} as any, lawdb: {} as any, secret: taskTokenKey() }, { port: 0, pipePath: join(dir, "w.sock") });
  const p2 = localServerPort(servers.tcp);
  try {
    const { matter } = await ownMatter("write");
    const live = liveTaskIdentity(tk, matter.matter_id, "pre_write", "a1.drafting");
    const tok = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: 1, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 600);
    const p = preopen("/mcp", tok, call("docx.render_report", { title: "终止后生成", sections: [{ heading: "h", paragraphs: ["p"] }] }), p2);
    await sleep(200);
    tk.kernel.db.run(`UPDATE runs SET status = 'failed' WHERE run_id = ?`, [live.rid]);
    tk.kernel.db.run(`UPDATE attempts SET status = 'failed' WHERE attempt_id = ?`, [live.aid]);
    p.send();
    const r = await p.done;
    assert.equal(statusOf(r), 401, r.slice(0, 200));
    const ops = tk.kernel.db.all(`SELECT status FROM tool_operations WHERE run_id = ?`, [live.rid]);
    assert.deepEqual(ops, [], "终止之后不预留、不执行副作用调用");
  } finally {
    for (const sv of [servers.tcp, servers.pipe]) if (sv) await new Promise<void>((r) => sv.close(() => r()));
  }
});

test("N-01 在途流：取消之后在途模型流在一个复核周期内被中止（不送出结束标记，连接断开）", { timeout: 60_000 }, async () => {
  const { matter } = await ownMatter("stream");
  const live = liveTaskIdentity(tk, matter.matter_id, "inflight");
  const chatTok = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: 1, scope: ["model:chat"] }, 600);
  __setMockScriptForTests(() => ({ content: "长回答".repeat(400), chunkDelayMs: 40 }));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${chatTok}` },
      body: JSON.stringify({ model: await routeAlias(), stream: true, messages: [{ role: "user", content: "请长篇作答" }] }),
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const sv = tk.kernel.db.get<{ status_version: number }>(`SELECT status_version FROM runs WHERE run_id = ?`, [live.rid])!.status_version;
    const t0 = Date.now();
    await tk.inv("runs.cancel", { run_id: live.rid, expected_version: sv, reason: "N-01 在途流" });
    let text = "";
    let broken = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch {
      broken = true; // 连接被服务端断开
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1_500, `在途流在 ${elapsed} ms 内结束`);
    assert.ok(!text.includes("[DONE]"), "被中止的流不送出结束标记（客户端不会当作正常结束）");
    assert.ok(broken || !text.includes("[DONE]"));
  } finally {
    __setMockScriptForTests(null);
  }
});

test("N-03 令牌里的事项、租户必须与任务记录一致；N-04 /v1/models 同样做活性检查", { timeout: 60_000 }, async () => {
  const { matter, doc } = await ownMatter("claims");
  const { matter: victim } = await tk.inv("matters.create", { title: "他事项", stance: "受让方", consent_status: "not_required" });
  const vdoc = await importText(tk.inv, victim.matter_id, "机密.txt", "VICTIM-SECRET-N03");
  const live = liveTaskIdentity(tk, matter.matter_id, "claims");
  const post = async (tok: string, pv: string) =>
    fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify(call("materials.read_excerpt", { parse_version_id: pv })) });
  const forgedMid = mintTaskToken({ tid: live.tid, uid: live.uid, mid: victim.matter_id, rid: live.rid, aid: live.aid, fen: 1, scope: ["tool:legal"] }, 600);
  const r1 = await post(forgedMid, vdoc.parse_version_id);
  assert.equal(r1.status, 401);
  assert.ok(!(await r1.text()).includes("VICTIM-SECRET-N03"));
  const forgedTid = mintTaskToken({ tid: "ten_other", uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: 1, scope: ["tool:legal"] }, 600);
  assert.equal((await post(forgedTid, doc.parse_version_id)).status, 401);
  // N-04
  const chatTok = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: 1, scope: ["model:chat"] }, 600);
  const models = () => fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${chatTok}` } }).then((r) => r.status);
  assert.equal(await models(), 200);
  tk.kernel.db.run(`UPDATE runs SET status = 'failed' WHERE run_id = ?`, [live.rid]);
  assert.equal(await models(), 401, "终态任务的令牌不能再查询模型路由");
});
