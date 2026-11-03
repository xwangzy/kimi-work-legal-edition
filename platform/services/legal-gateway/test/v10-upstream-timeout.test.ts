/**
 * V10 第 36 批真实走查 V17：中软 MaaS 一次请求 965 秒无响应，Agent 等到 40 分钟工作时限用完，律师只看到“已超时”。
 * 网关原先只在客户端断开时中止上游；现在收到响应头前与流式两块之间各有超时，到时中止上游、返回 504 或断开流，不按预占扣点。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createLegalGateway, DEFAULT_ROUTES, fileMeter, MockProvider } from "../src/index.ts";
import type { ChatProvider } from "../src/providers.ts";

const waitAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });

/** 按模式模拟上游：hang = 不给响应头；stall = 给一块后不再有数据；normal = 照常。 */
class FlakyProvider implements ChatProvider {
  readonly name = "flaky";
  mode: "hang" | "stall" | "normal" = "normal";
  private readonly ok = new MockProvider();
  async chat(body: Record<string, unknown>, o: { requestId: string; signal: AbortSignal }) {
    if (this.mode === "hang") return waitAbort(o.signal);
    if (this.mode === "stall") {
      const signal = o.signal;
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
          await waitAbort(signal);
        })(),
      };
    }
    return this.ok.chat(body);
  }
}

describe("上游超时", () => {
  const { privateKey, publicKey } = devSeatKeyPair();
  const keys = new Map([["k1", publicKey]]);
  const token = issueSeatToken({ tid: "t1", uid: "u1", sid: "s-t1", dev: "d1", kid: "k1" }, privateKey);
  const provider = new FlakyProvider();
  const budgets = new Map<string, number>([["t1", 1_000_000]]);
  let server: ReturnType<typeof createLegalGateway>;
  let base: string;
  let meterPath: string;
  before(async () => {
    meterPath = join(realpathSync(mkdtempSync(join(tmpdir(), "kwl-gw-to-"))), "meter.jsonl");
    server = createLegalGateway({ keys, revokedDevices: new Set(), provider, routes: DEFAULT_ROUTES, meter: fileMeter(meterPath), budgets, tenantConcurrency: 2, queueTimeoutMs: 400, upstreamHeaderTimeoutMs: 300, upstreamIdleTimeoutMs: 300 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
  });
  const chat = (stream: boolean) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-kwl-anon-matter": "anon-1", "x-kwl-data-level": "L2" },
      body: JSON.stringify({ model: "legal/k3", stream, messages: [{ role: "user", content: "测试" }] }),
    });
  const lastSettle = () => readFileSync(meterPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "settle").at(-1);

  test("收不到响应头：到时返回 504 upstream_timeout，计量记原因，不扣点", async () => {
    provider.mode = "hang";
    const before = budgets.get("t1");
    const t0 = Date.now();
    const r = await chat(true);
    assert.equal(r.status, 504);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, "upstream_timeout");
    assert.ok(Date.now() - t0 < 5_000, "不等到天荒地老");
    assert.equal(lastSettle().reason, "upstream_header_timeout");
    assert.equal(budgets.get("t1"), before, "服务方没响应，不扣点");
  });

  test("流到一半没有新数据：到时断开，计量记原因，不按预占扣点", async () => {
    provider.mode = "stall";
    const before = budgets.get("t1");
    const r = await chat(true);
    assert.equal(r.status, 200);
    await assert.rejects(r.text(), "流被断开，客户端读到中断而不是挂住");
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(lastSettle().reason, "upstream_idle_timeout");
    assert.equal(budgets.get("t1"), before);
  });

  test("正常上游不受影响", async () => {
    provider.mode = "normal";
    const r = await chat(true);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /\[DONE\]|usage/);
    assert.equal(lastSettle().reason, null);
  });
});
