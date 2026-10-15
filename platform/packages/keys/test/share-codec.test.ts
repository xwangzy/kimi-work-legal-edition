/**
 * 律所主秘密分片编码 kwl-share/1（TPM 与根私钥离线分持设计 v1 §3.2、§3.6、§3.8；C6 §7.4 第 3 项）：
 * 编码往返；三片任两片重建、单片失败；任一字符错误被行校验或整体 check 拒绝并指出行；
 * 不同分片集混用、x=0、重复 x 拒绝；团队版恢复码往返；tag 稳定；季度核验只比 tag。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  combineFirmShares,
  decodeFirmShare,
  decodeTeamRecoveryCode,
  encodeFirmShare,
  encodeTeamRecoveryCode,
  shareFromQr,
  shareFromText,
  shareTag,
  shareToQr,
  shareToText,
  splitFirmMasterSecret,
  verifyShareAgainstTags,
} from "../src/index.ts";

const fms = () => new Uint8Array(randomBytes(32));

test("SH-01 2-of-3：三种两片组合都重建出同一主秘密；单片不足即拒绝", () => {
  const secret = fms();
  const set = splitFirmMasterSecret(secret);
  assert.equal(set.shares.length, 3);
  assert.ok(set.shares.every((s) => s.length === 43));
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) assert.deepEqual(combineFirmShares([set.shares[a]!, set.shares[b]!]), secret);
  assert.deepEqual(combineFirmShares([...set.shares]), secret, "三片也可");
  assert.throws(() => combineFirmShares([set.shares[0]!]), (e: any) => e.code === "share_insufficient");
  // 每次分片是新的分片集
  assert.notDeepEqual(splitFirmMasterSecret(secret).setId, set.setId);
});

test("SH-02 文本往返：69 个字符分 3 行、行末校验位；大小写与 O/I/L 容错；二维码只用字母数字模式字符", () => {
  const set = splitFirmMasterSecret(fms());
  const text = shareToText(set.shares[1]!);
  const rows = text.split("\n");
  assert.equal(rows[0], "KWS1");
  assert.equal(rows.length, 4);
  assert.match(rows[1]!, /^([0-9A-Z]{4} ){5}[0-9A-Z]{4} {2}[0-9A-Z]$/);
  assert.deepEqual(shareFromText(text), set.shares[1]);
  assert.deepEqual(shareFromText(text.toLowerCase().replace(/0/g, "o").replace(/1/g, "l")), set.shares[1], "大小写与 O/L 容错");
  assert.deepEqual(shareFromText(text.replace(/ /g, "-")), set.shares[1], "组间连字符");
  const qr = shareToQr(set.shares[2]!);
  assert.match(qr, /^KWS1:[0-9A-Z]{69}$/, "全部在 QR 字母数字模式字符集内");
  assert.deepEqual(shareFromQr(qr), set.shares[2]);
});

test("SH-03 抄错一个字符：指出是哪一行；行校验位本身抄错也指出；两行互换被发现；不做纠错", () => {
  const set = splitFirmMasterSecret(fms());
  const text = shareToText(set.shares[0]!);
  const rows = text.split("\n");
  for (let li = 1; li <= 3; li++) {
    const row = rows[li]!;
    const pos = row.search(/[0-9A-Z]/);
    const bad = row[pos] === "A" ? "B" : "A";
    const mutated = [...rows];
    mutated[li] = row.slice(0, pos) + bad + row.slice(pos + 1);
    assert.throws(() => shareFromText(mutated.join("\n")), (e: any) => e.code === "share_line" && e.line === li, `第 ${li} 行`);
    const badCheck = [...rows];
    const last = row.at(-1)!;
    badCheck[li] = row.slice(0, -1) + (last === "A" ? "B" : "A");
    assert.throws(() => shareFromText(badCheck.join("\n")), (e: any) => e.code === "share_line" && e.line === li);
  }
  // 每个位置的每种单字符抄错都能指出所在行（奇数权重，复核 S7A-04）
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let missed = 0;
  for (let li = 1; li <= 3; li++) {
    const body = rows[li]!.slice(0, -3);
    for (let pos = 0; pos < body.length; pos++) {
      if (body[pos] === " ") continue;
      for (const ch of B32) {
        if (ch === body[pos]) continue;
        const mutated = [...rows];
        mutated[li] = body.slice(0, pos) + ch + body.slice(pos + 1) + rows[li]!.slice(-3);
        try {
          shareFromText(mutated.join("\n"));
          missed++;
        } catch (e: any) {
          if (!(e.code === "share_line" && e.line === li)) missed++;
        }
      }
    }
  }
  assert.equal(missed, 0, "单字符抄错都指出了所在行");
  const swapped = [rows[0]!, rows[2]!, rows[1]!, rows[3]!];
  assert.throws(() => shareFromText(swapped.join("\n")), (e: any) => e.code === "share_line");
  assert.throws(() => shareFromText(rows.slice(0, 3).join("\n")), (e: any) => e.code === "share_rows");
  assert.throws(() => shareFromText(["KWX1", ...rows.slice(1)].join("\n")), (e: any) => e.code === "share_version");
  // 行校验碰巧放过的错误（同一行两处互相抵消）由整体 check 兜底：直接改字节
  const raw = new Uint8Array(set.shares[0]!);
  raw[10]! ^= 0x01;
  assert.throws(() => decodeFirmShare(raw), (e: any) => e.code === "share_check");
});

test("SH-04 分片集与编号：不同分片集混用、门限不一致、编号重复、x=0 一律拒绝", () => {
  const a = splitFirmMasterSecret(fms());
  const b = splitFirmMasterSecret(fms());
  assert.throws(() => combineFirmShares([a.shares[0]!, b.shares[1]!]), (e: any) => e.code === "share_set_mismatch");
  const s0 = decodeFirmShare(a.shares[0]!);
  assert.throws(() => combineFirmShares([a.shares[0]!, encodeFirmShare({ ...s0, threshold: 3 })]), (e: any) => e.code === "share_set_mismatch");
  assert.throws(() => combineFirmShares([a.shares[0]!, a.shares[0]!]), /重复/);
  assert.throws(() => encodeFirmShare({ ...s0, x: 0 }), /编号/);
  // 手工造一个 x=0 的字节串（check 正确）也被拒
  const forged = new Uint8Array(a.shares[0]!);
  forged[6] = 0;
  forged.set(createHash("sha256").update("kwl-share-v1").update(forged.subarray(0, 39)).digest().subarray(0, 4), 39);
  assert.throws(() => decodeFirmShare(forged), (e: any) => e.code === "share_fields");
  // x 大于分片数（x=4、n=3）同样拒（复核 S7A-09）
  const beyond = new Uint8Array(a.shares[0]!);
  beyond[6] = 4;
  beyond.set(createHash("sha256").update("kwl-share-v1").update(beyond.subarray(0, 39)).digest().subarray(0, 4), 39);
  assert.throws(() => decodeFirmShare(beyond), (e: any) => e.code === "share_fields");
  // 二维码只收规范编码：多一个字符、末字符填充位不为 0 都拒
  const qr = shareToQr(a.shares[0]!);
  assert.throws(() => shareFromQr(`${qr}0`), (e: any) => e.code === "share_length");
  const last = qr.at(-1)!;
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bumped = B32[(B32.indexOf(last) ^ 1) % 32]!;
  assert.throws(() => shareFromQr(qr.slice(0, -1) + bumped), (e: any) => e.code === "share_length" || e.code === "share_check");
});

test("SH-05 团队版恢复码往返（KWR1，41 字节、不分片）；律所分片与恢复码互不混用", () => {
  const secret = fms();
  const code = encodeTeamRecoveryCode(secret);
  assert.equal(code.length, 41);
  const text = shareToText(code);
  assert.equal(text.split("\n")[0], "KWR1");
  const back = decodeTeamRecoveryCode(shareFromText(text));
  assert.deepEqual(back.fms, secret);
  assert.deepEqual(decodeTeamRecoveryCode(shareFromQr(shareToQr(code))).fms, secret);
  assert.throws(() => decodeFirmShare(code), (e: any) => e.code === "share_length");
  const set = splitFirmMasterSecret(secret);
  assert.throws(() => decodeTeamRecoveryCode(set.shares[0]!), (e: any) => e.code === "share_length");
});

test("CE-04 tag 稳定、各片不同；季度核验只比 tag：本集的片通过并给出编号，别的集或抄错的片不通过（指出行）", () => {
  const set = splitFirmMasterSecret(fms());
  assert.deepEqual(shareTag(set.shares[0]!), set.tags[0]);
  assert.equal(new Set(set.tags.map((t) => Buffer.from(t).toString("hex"))).size, 3);
  const r = verifyShareAgainstTags({ text: shareToText(set.shares[2]!) }, set.tags);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.x, 3);
  assert.equal(verifyShareAgainstTags({ qr: shareToQr(set.shares[0]!) }, set.tags).ok, true);
  const other = splitFirmMasterSecret(fms());
  assert.deepEqual(verifyShareAgainstTags({ text: shareToText(other.shares[0]!) }, set.tags), { ok: false, code: "share_unknown" });
  const rows = shareToText(set.shares[1]!).split("\n");
  rows[2] = rows[2]!.replace(/^(.)/, (c) => (c === "A" ? "B" : "A"));
  assert.deepEqual(verifyShareAgainstTags({ text: rows.join("\n") }, set.tags), { ok: false, code: "share_line", line: 2 });
  assert.deepEqual(verifyShareAgainstTags({ text: shareToText(encodeTeamRecoveryCode(fms())) }, set.tags), { ok: false, code: "share_version" });
});
