import { test } from "node:test";
import assert from "node:assert/strict";
import { devSeatKeyPair, issueSeatToken, MIN_SEAT_TTL_SECONDS, SeatTokenError, verifySeatToken } from "../src/index.ts";

test("席位令牌：Ed25519 离线验签；缺省有效期 ≥ 72 小时；过期、篡改、未知密钥、吊销设备/席位一律拒绝；载荷不含事项信息", () => {
  const { privateKey, publicKey } = devSeatKeyPair();
  const keys = new Map([["k1", publicKey]]);
  const tok = issueSeatToken({ tid: "t1", uid: "u1", sid: "s1", dev: "d1", kid: "k1" }, privateKey);
  const c = verifySeatToken(tok, keys);
  assert.equal(c.exp - c.iat, MIN_SEAT_TTL_SECONDS);
  assert.deepEqual(Object.keys(c).sort(), ["dev", "exp", "iat", "kid", "sid", "tid", "uid"]);
  const reason = (fn: () => unknown) => {
    try {
      fn();
      return "ok";
    } catch (e) {
      return e instanceof SeatTokenError ? e.reason : "other";
    }
  };
  assert.equal(reason(() => verifySeatToken(tok, keys, { now: Date.now() + (MIN_SEAT_TTL_SECONDS + 1) * 1000 })), "expired");
  const [p, , s] = [tok.slice(0, 5), 0, tok.split(".")];
  const forged = `${p}${Buffer.from(JSON.stringify({ ...c, tid: "t2" })).toString("base64url")}.${s[2]}`;
  assert.equal(reason(() => verifySeatToken(forged, keys)), "signature");
  assert.equal(reason(() => verifySeatToken(tok, new Map([["k2", publicKey]]))), "unknown_key");
  assert.equal(reason(() => verifySeatToken(tok, keys, { revokedDevices: new Set(["d1"]) })), "device_revoked");
  assert.equal(reason(() => verifySeatToken(tok, keys, { revokedSeats: new Set(["s1"]) })), "seat_revoked");
  assert.equal(reason(() => verifySeatToken("zrt1.x.y", keys)), "format");
  const other = devSeatKeyPair();
  assert.equal(reason(() => verifySeatToken(issueSeatToken({ tid: "t1", uid: "u1", sid: "s1", dev: "d1", kid: "k1" }, other.privateKey), keys)), "signature");
});
