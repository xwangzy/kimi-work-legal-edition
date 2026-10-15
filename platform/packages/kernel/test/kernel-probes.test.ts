/**
 * 内核侧探针（自旧 a1-agent.test.ts 保留；K9-1 SDK 宿主退役后与引擎无关的部分）：
 * - 探针 2：本机端点 MCP 面按声明子集收窄（tools/list 精确白名单、白名单外 -32601 并计数）；
 * - 探针 3：材料导入遇符号链接如实拒绝、路径穿越压缩包在解析前拦截。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeKernel, liveTaskIdentity, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "kernel-probes-secret-0123456789abc";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "kernel-probes-firm");
});

after(async () => {
  await tk.kernel.close();
});

test("探针 2：MCP 面按声明子集收窄——tools/list 精确白名单、白名单外调用 -32601 并计数", async () => {
  const { LEGAL_MCP_TOOLS } = await import("@zr-legal/domain");
  const { Agent, fetch } = await import("undici");
  const { matter: pm } = await tk.inv("matters.create", { title: "MCP 面探针", stance: "受让方", consent_status: "not_required" });
  const live = liveTaskIdentity(tk, pm.matter_id, "mcp_surface");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  const call = (method: string, params?: unknown) =>
    fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      dispatcher: agent,
    }).then(async (r) => (await r.json()) as any);

  // tools/list 精确等于白名单（不再返回全部注册工具）
  const list = await call("tools/list");
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, [...LEGAL_MCP_TOOLS].sort(), "tools/list 须精确等于 A1 工具面声明子集");

  // 白名单内调用放行（calc.interest 在 A1 面）
  const okCall = await call("tools/call", { name: "calc.interest", arguments: { principal_yuan: 100, start_date: "2026-01-01", end_date: "2026-01-02", rate: { kind: "fixed", annual_pct: 6 } } });
  assert.equal(okCall.result?.isError, false, `白名单内工具应可用：${JSON.stringify(okCall)}`);

  // 白名单外（已注册但不在 A1 面，如 docx.sanitize）→ -32601 拒绝并计数
  const before = (await tk.inv("kernel.status")).local_server.rejected_tool_calls;
  const denied = await call("tools/call", { name: "docx.sanitize", arguments: {} });
  assert.equal(denied.error?.code, -32601, `白名单外工具须 -32601 拒绝：${JSON.stringify(denied)}`);
  const after = (await tk.inv("kernel.status")).local_server.rejected_tool_calls;
  assert.equal(after, before + 1, "拒绝须计入取证计数器");
  await agent.close();
});

test("探针 3：材料导入遇符号链接如实拒绝（不跟随）", async () => {
  const { symlinkSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "kwl-symlink-"));
  const target = join(dir, "real.txt");
  writeFileSync(target, "真实文件内容");
  const link = join(dir, "link.txt");
  symlinkSync(target, link);
  const { matter } = await tk.inv("matters.create", { title: "符号链接探针", stance: "受让方", consent_status: "not_required" });
  await assert.rejects(
    () => tk.inv("materials.import", { matter_id: matter.matter_id, path: link, filename: "link.txt" }),
    (e: any) => /符号链接/.test(e.message),
  );
  await assert.rejects(
    () => tk.inv("materials.mount", { matter_id: matter.matter_id, path: link, filename: "link.txt" }),
    (e: any) => /符号链接/.test(e.message),
  );
});

test("探针 3：路径穿越压缩包在解析前拦截", async () => {
  // 按 ZIP 结构精确构造含 ../../evil.txt 条目的包（stored），伪装成 docx 导入 → zip.ts 前置拦截
  const name = Buffer.from("../../evil.txt", "utf8");
  const data = Buffer.from("evil", "utf8");
  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    name,
    data,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  ]);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
  const zip = Buffer.concat([local, central, eocd]);
  const { matter } = await tk.inv("matters.create", { title: "压缩包探针", stance: "受让方", consent_status: "not_required" });
  await assert.rejects(
    () => tk.inv("materials.import", { matter_id: matter.matter_id, filename: "恶意.docx", data_base64: zip.toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    (e: any) => /可疑路径|ZIP/.test(e.message),
  );
});
