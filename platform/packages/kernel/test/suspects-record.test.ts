/**
 * 发送前二次检测的计数进本机去向记录（v9.2 R7）：只有高、中两档的整数计数；没有可疑项时不写该字段；任何值都不进记录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { egressRowFromGate } from "../src/egress/gate-host.ts";

const base = { at: "2026-10-14T00:00:00Z", requestId: "kwlg_x", tenantId: "t", matterId: "m", runId: "r", purpose: "model" as const, destination: "legal_gateway" as const, destinationHost: "gw.example.cn", outcome: "sent" as const, reason: null, chars: 10, segments: 1, tokenized: {}, media: [], policyVersion: 1, upstreamStatus: 200, durationMs: 5 };

test("去向记录：可疑姓名只记计数（规整为非负整数），没有时不写", () => {
  const row = egressRowFromGate({ ...base, suspectedNames: { high: 1, medium: 2 } });
  assert.deepEqual(JSON.parse(String(row.note)).suspected_names, { high: 1, medium: 2 });
  const forged = egressRowFromGate({ ...base, suspectedNames: { high: 1.7, medium: "李华" as unknown as number } });
  assert.deepEqual(JSON.parse(String(forged.note)).suspected_names, { high: 1, medium: 0 }, "非数字不进记录");
  const none = egressRowFromGate({ ...base, suspectedNames: { high: 0, medium: 0 } });
  assert.equal("suspected_names" in JSON.parse(String(none.note)), false);
  assert.equal("suspected_names" in JSON.parse(String(egressRowFromGate(base).note)), false);
});
