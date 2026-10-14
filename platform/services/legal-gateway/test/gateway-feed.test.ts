/**
 * 网关按控制面订阅做二次检查（v9 阶段 6；第 04 篇 §5.2“事项匿名摘要用于二次检查（L3b 拒绝、端点许可、密级）”；收敛偏离 D-20）：
 * - 已知事项：自报级别低于摘要即拒绝；L3b/L4、非标准端点、依据未齐备、律所未放开的 L3a 一律拒绝；自报级别更严时按更严的判；
 * - 摘要尚未到达的事项：按请求头自报检查（控制面不可达时推理照常，第 02 篇 §10），计量记“缺摘要”供事后异常检测；
 * - 订阅的吊销集：设备、席位在线即拒绝；无事项问答路由不受摘要影响。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import type { AnonMatterSummary, GatewayFeedView } from "@zr-legal/firm-trust";
import { createLegalGateway, DEFAULT_ROUTES, memoryMeter, MockProvider, type MeterRecord } from "../src/index.ts";

describe("网关二次检查（控制面订阅）", () => {
  const { privateKey, publicKey } = devSeatKeyPair();
  const keys = new Map([["k1", publicKey]]);
  const seat = (dev = "d1", sid = "s1") => issueSeatToken({ tid: "t1", uid: "u1", sid, dev, kid: "k1" }, privateKey);
  const matters = new Map<string, AnonMatterSummary>();
  let l3a = false;
  let refreshes = 0;
  const feed: GatewayFeedView = {
    ready: () => true,
    revokedDevice: (tid, d) => tid === "t1" && d === "lost-laptop",
    revokedSeat: (s) => s === "s-gone",
    matter: (tid, anon) => (tid === "t1" ? (matters.get(anon) ?? null) : null),
    l3aStandardAllowed: () => l3a,
    refresh: async () => {
      refreshes += 1;
    },
  };
  const sum = (anon: string, o: Partial<AnonMatterSummary> = {}): AnonMatterSummary => ({ anon, level: "L2", endpoint: "standard", basis_complete: true, version: 1, updated_at: new Date().toISOString(), ...o });
  const provider = new MockProvider();
  const meter = memoryMeter();
  const records = (meter as unknown as { records: MeterRecord[] }).records;
  let server: Server;
  let base = "";
  before(async () => {
    server = createLegalGateway({ keys, provider, routes: DEFAULT_ROUTES, meter, budgets: new Map([["t1", 1_000_000]]), feed });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
  });
  const chat = async (anon: string, level: string, token = seat(), path = "/v1/chat/completions") => {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-kwl-anon-matter": anon, "x-kwl-data-level": level },
      body: JSON.stringify({ model: "legal/k3", messages: [{ role: "user", content: "测试" }] }),
    });
    const body = (await r.json()) as { error?: { code: string } };
    return { status: r.status, code: body.error?.code ?? null };
  };

  test("已知事项：按摘要判定——L3b、非标准端点、依据未齐备、律所未放开的 L3a 拒绝；自报级别低于摘要拒绝", async () => {
    matters.set("m-l3b", sum("m-l3b", { level: "L3b", endpoint: "private" }));
    matters.set("m-priv", sum("m-priv", { endpoint: "private" }));
    matters.set("m-basis", sum("m-basis", { basis_complete: false }));
    matters.set("m-l3a", sum("m-l3a", { level: "L3a" }));
    matters.set("m-ok", sum("m-ok"));
    const n = provider.seen.length;
    assert.deepEqual(await chat("m-l3b", "L2"), { status: 403, code: "data_level_mismatch" });
    assert.deepEqual(await chat("m-priv", "L2"), { status: 403, code: "endpoint_not_permitted" });
    assert.deepEqual(await chat("m-basis", "L2"), { status: 403, code: "basis_incomplete" });
    assert.deepEqual(await chat("m-l3a", "L3a"), { status: 403, code: "l3a_not_permitted" });
    assert.deepEqual(await chat("m-l3a", "L2"), { status: 403, code: "data_level_mismatch" });
    assert.equal(provider.seen.length, n, "被拒绝的请求不到达上游");
    l3a = true;
    assert.equal((await chat("m-l3a", "L3a")).status, 200, "律所放开后 L3a 经标准端点可用");
    l3a = false;
    assert.equal((await chat("m-ok", "L2")).status, 200);
    assert.equal(records.filter((r) => r.kind === "reserve").at(-1)?.reason, null);
    // 自报更严（摘要尚未更新到新的更严级别）：按更严的判
    assert.deepEqual(await chat("m-ok", "L3a"), { status: 403, code: "l3a_not_permitted" });
  });

  test("摘要尚未到达：按请求头自报检查并记“缺摘要”；未知事项先按需刷新一次；律所未放开时自报 L3a 照常拒绝（复核 S6-A07）", async () => {
    const r0 = refreshes;
    assert.equal((await chat("m-unknown", "L2")).status, 200);
    assert.ok(refreshes > r0, "未知事项先刷新订阅");
    assert.equal(records.filter((r) => r.kind === "reserve").at(-1)?.reason, "summary_missing_header_checked");
    assert.deepEqual(await chat("m-unknown", "L3b"), { status: 403, code: "data_level_not_allowed" });
    l3a = false;
    assert.deepEqual(await chat("m-unknown", "L3a"), { status: 403, code: "l3a_not_permitted" });
  });

  test("摘要的级别不认识即拒绝（纵深防御，复核 S6-B19）", async () => {
    matters.set("m-bad", { ...sum("m-bad"), level: "L9" as never });
    assert.deepEqual(await chat("m-bad", "L2"), { status: 403, code: "summary_invalid" });
  });

  test("订阅的吊销集按租户区分：设备、席位在线即拒绝；无事项问答路由不看事项摘要", async () => {
    assert.deepEqual(await chat("m-ok", "L2", seat("lost-laptop")), { status: 401, code: "seat_device_revoked" });
    const other = issueSeatToken({ tid: "t2", uid: "u2", sid: "s-t2", dev: "lost-laptop", kid: "k1" }, privateKey);
    assert.notEqual((await chat("m-ok", "L2", other)).code, "seat_device_revoked", "他所同编号设备不受本所吊销影响（复核 S6-A08）");
    assert.deepEqual(await chat("m-ok", "L2", seat("d1", "s-gone")), { status: 401, code: "seat_seat_revoked" });
    assert.equal((await chat("qa", "L1", seat(), "/v1/qa/chat/completions")).status, 200);
  });
});
