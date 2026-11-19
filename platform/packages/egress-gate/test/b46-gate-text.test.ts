/**
 * 第 46 批（主文 §5-2）：闸门面向律师的拒绝说明去掉研发用语；网关 4xx 错误体的代码以“[kwl:代码]”带给执行器（只改说明文字）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagGatewayError } from "../src/server.ts";

test("网关错误体：说明末尾附错误代码，状态码与其余字段不变；不是这种形状或已附过的原样返回", () => {
  const raw = Buffer.from(JSON.stringify({ error: { code: "quota_burst", message: "本所 5 小时内的用量已达上限，请稍后再试", type: "x" } }));
  const out = JSON.parse(tagGatewayError(raw).toString("utf8"));
  assert.deepEqual(out, { error: { code: "quota_burst", message: "本所 5 小时内的用量已达上限，请稍后再试 [kwl:quota_burst]", type: "x" } });
  const once = tagGatewayError(raw);
  assert.equal(tagGatewayError(once).toString("utf8"), once.toString("utf8"), "不重复附");
  for (const b of ["not json", JSON.stringify({ error: "x" }), JSON.stringify({ error: { code: "Bad Code!", message: "m" } }), JSON.stringify({ ok: true })]) {
    assert.equal(tagGatewayError(Buffer.from(b)).toString("utf8"), b);
  }
});

test("闸门转发：只收齐法律模型网关的 4xx JSON 错误体再改写说明；成功的响应流照旧原样逐块返回", () => {
  const s = readFileSync(join(import.meta.dirname, "../src/server.ts"), "utf8");
  assert.match(s, /let hold = t\.kind === "legal_gateway" && upstreamRes\.status >= 400 && upstreamRes\.status < 500 && \/json\/i\.test/);
  assert.match(s, /tagGatewayError\(Buffer\.concat\(held\)\)/);
});

test("闸门拒绝说明：不再出现“席位令牌、任务令牌、出站闸门拒绝、问答令牌”", () => {
  const s = readFileSync(join(import.meta.dirname, "../src/server.ts"), "utf8");
  const said = [...s.matchAll(/new GateError\(\d+, "[a-z_]+", ("[^"]*"|`[^`]*`)\)|deny\(\d+, "[a-z_]+", ("[^"]*"|`[^`]*`)/g)].map((m) => m[1] ?? m[2] ?? "");
  assert.ok(said.length > 10);
  for (const t of said) assert.doesNotMatch(t, /席位令牌|任务令牌|问答令牌|出站闸门拒绝|令牌与事项/, t);
  assert.match(s, /"seat_unavailable", "这台电脑暂时没有取得 AI 使用授权（还没登录，或联网续期还没完成）：AI 请求没有发出"/);
});
