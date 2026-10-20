/** v9.3 第 15 批 B-6：问答回答下的引用核对一行字与语气（核到不等于“内容支持”；对不上标红、法规库外与案号标橙）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { qaCitationLine } from "../src/lib/qa-citations.ts";

const base = { total: 0, verified: 0, wrong: 0, outside: 0, cases: 0, items: [] };

test("B-6 引用核对一行字", () => {
  const ok = qaCitationLine({ ...base, total: 2, verified: 2 });
  assert.equal(ok.tone, "ok");
  assert.match(ok.text, /2 条在本机法规库核到，内容是否支持观点请自行判断/);
  const mixed = qaCitationLine({ ...base, total: 4, verified: 1, wrong: 1, outside: 1, cases: 1 });
  assert.equal(mixed.tone, "bad");
  assert.match(mixed.text, /1 条条号对不上（超出总条数或已改号）；1 条系统没法核对（法规库没有收录，或款项、适用版本对不上），请自行核对；1 个案号离线没法核对/);
  assert.match(qaCitationLine({ ...base, total: 2, verified: 2, partial: 1 }).text, /其中 1 条只核到条号/);
  const un = qaCitationLine({ ...base, total: 0, unrecognized: 2 });
  assert.equal(un.tone, "warn");
  assert.match(un.text, /另有 2 处“第X条”没认出是哪部法/);
  assert.equal(qaCitationLine({ ...base, total: 1, outside: 1 }).tone, "warn");
  assert.match(qaCitationLine({ ...base, unchecked: true }).text, /没有核对成功/);
});
