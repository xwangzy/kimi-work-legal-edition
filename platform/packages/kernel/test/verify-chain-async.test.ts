/**
 * 见证链校验分批让出事件循环（第 4 批复核 B4-R12）：同步校验 34 万行会挡住内核主线程 30 秒以上——子进程收不到心跳全部退出、界面请求也卡住。
 * 异步版每 2,000 行让出一次：长链校验期间定时器照常触发，结果与同步版一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKernel } from "./helpers.ts";
import { rowPayloadHash } from "../src/ledger-signer.ts";

test("长链校验：异步版期间定时器照常触发（最长间隔远小于同步耗时），结果与同步版一致", { timeout: 300_000 }, async () => {
  const tk = await makeKernel({}, "chain-async");
  try {
    const db = tk.kernel.db;
    const tenantId = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM devices LIMIT 1`)!.tenant_id;
    db.tx(() => {
      for (let i = 0; i < 12_000; i++) {
        const r = db.run(`INSERT INTO audit_events (tenant_id, actor_id, action, object_kind, object_id, detail_hash) VALUES (?,?,?,?,?,?)`, [tenantId, "u", "probe.event", "probe", String(i), null]);
        const row = db.get<Record<string, unknown>>(`SELECT * FROM audit_events WHERE audit_event_id = ?`, [Number(r.lastInsertRowid)]);
        tk.kernel.signer.append({ kind: "audit_event", refId: String(r.lastInsertRowid), matterId: null, type: "probe.event", payloadHash: rowPayloadHash(row ?? {}) });
      }
    });
    const t0 = Date.now();
    const sync = tk.kernel.signer.verifyChain();
    const syncMs = Date.now() - t0;
    let last = Date.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const asyncResult = await tk.kernel.signer.verifyChainAsync();
    clearInterval(timer);
    assert.deepEqual(asyncResult, sync, "结果一致");
    assert.equal(sync.ok, true);
    assert.ok(sync.checked >= 12_000);
    assert.ok(maxGap < syncMs * 0.5, `异步校验期间定时器最长间隔 ${maxGap} ms，同步耗时 ${syncMs} ms`);
  } finally {
    await tk.kernel.close();
  }
});
