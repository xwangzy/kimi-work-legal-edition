/**
 * KWE1 落盘加密格式：分块整文件（多块、空文件、防截断与重排、换代读取）、追加日志（逐条认证、残尾识别）、
 * 用途隔离、明文长度、密文不含明文片段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AtRestError, CHUNK_BYTES, chunkSpan, deriveZoneKey, HEADER_BYTES, isChunkedHeader, isSealed, MatterKeyRing, plainSizeOf, ZoneCodec } from "../src/index.ts";

const ws = randomBytes(32);
const codec = (gen = 1, keys?: Map<number, Uint8Array>) => new ZoneCodec("work", keys ?? new Map([[gen, deriveZoneKey(ws, "work")]]), gen);

test("分块：往返、长度闭式、多块、空文件；密文里没有明文片段", () => {
  const c = codec();
  for (const n of [0, 1, 100, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES + 77]) {
    const plain = Buffer.alloc(n, "案");
    const disk = c.seal(plain);
    assert.ok(isSealed(disk));
    assert.equal(plainSizeOf(disk.length), n, `n=${n}`);
    assert.equal(c.plainSize(disk), n);
    assert.ok(c.open(disk).equals(plain));
  }
  const secret = Buffer.from("金丝雀KWL-AT-REST-0001 张伟 13800138000".repeat(50), "utf8");
  const disk = c.seal(secret);
  assert.equal(disk.includes(Buffer.from("KWL-AT-REST-0001")), false);
  assert.equal(disk.includes(Buffer.from("张伟")), false);
  // 同一明文两次封装不同（每次换盐与随机数）
  assert.notDeepEqual(c.seal(secret), disk);
});

test("分块：截断、块重排、改字节、用错用途或代都拒绝", () => {
  const c = codec();
  const plain = randomBytes(2 * CHUNK_BYTES + 10);
  const disk = c.seal(plain);
  const step = CHUNK_BYTES + 28;
  // 去掉最后一块（截断成“看起来完整”的两块）
  assert.throws(() => c.open(disk.subarray(0, HEADER_BYTES + 2 * step)), AtRestError);
  // 交换前两块
  const swapped = Buffer.concat([disk.subarray(0, HEADER_BYTES), disk.subarray(HEADER_BYTES + step, HEADER_BYTES + 2 * step), disk.subarray(HEADER_BYTES, HEADER_BYTES + step), disk.subarray(HEADER_BYTES + 2 * step)]);
  assert.throws(() => c.open(swapped), AtRestError);
  const flipped = Buffer.from(disk);
  flipped[HEADER_BYTES + 100]! ^= 1;
  assert.throws(() => c.open(flipped), AtRestError);
  // 别的用途（同一工作区密钥派生）不能解
  const other = new ZoneCodec("materials", new Map([[1, deriveZoneKey(ws, "materials")]]), 1);
  assert.throws(() => other.open(disk), (e: any) => e.code === "wrong_zone");
  // 别的事项（另一把工作区密钥）不能解
  const foreign = new ZoneCodec("work", new Map([[1, deriveZoneKey(randomBytes(32), "work")]]), 1);
  assert.throws(() => foreign.open(disk), (e: any) => e.code === "auth_failed");
  assert.throws(() => c.open(Buffer.from("plain text")), (e: any) => e.code === "not_sealed");
});

test("换代：旧代文件仍可读，新写入用新代；旧代密钥移除后旧文件不可读", () => {
  const k1 = deriveZoneKey(ws, "work");
  const k2 = deriveZoneKey(randomBytes(32), "work");
  const old = codec(1).seal(Buffer.from("旧代内容"));
  const both = new ZoneCodec("work", new Map([[1, k1], [2, k2]]), 2);
  assert.equal(both.open(old).toString(), "旧代内容");
  const fresh = both.seal(Buffer.from("新代内容"));
  assert.equal(fresh.readUInt32LE(8), 2);
  assert.equal(both.isCurrentGen(old), false);
  const onlyNew = new ZoneCodec("work", new Map([[2, k2]]), 2);
  assert.throws(() => onlyNew.open(old), (e: any) => e.code === "unknown_gen");
});

test("追加日志：逐条追加、整体读出、残尾识别后可截断续写；记录不能重排", () => {
  const c = new ZoneCodec("engine_fs", new Map([[1, deriveZoneKey(ws, "engine_fs")]]), 1);
  let disk = c.newLog();
  const lines = ["{\"a\":1}\n", "{\"b\":\"张伟\"}\n", "", "{\"c\":3}\n"];
  lines.forEach((l, i) => {
    disk = Buffer.concat([disk, c.record(disk.subarray(0, HEADER_BYTES), i, Buffer.from(l))]);
  });
  const r = c.readLog(disk);
  assert.equal(r.plain.toString(), lines.join(""));
  assert.equal(r.records, 4);
  assert.equal(r.torn, false);
  assert.equal(c.open(disk).toString(), lines.join(""));
  assert.equal(c.plainSize(disk), Buffer.byteLength(lines.join("")));
  assert.equal(disk.includes(Buffer.from("张伟")), false);
  // 断电：最后一条只写了一半
  const torn = disk.subarray(0, disk.length - 5);
  const t = c.readLog(torn);
  assert.equal(t.torn, true);
  assert.equal(t.records, 3);
  assert.equal(t.plain.toString(), lines.slice(0, 3).join(""));
  const repaired = Buffer.concat([torn.subarray(0, t.validLength), c.record(torn.subarray(0, HEADER_BYTES), t.records, Buffer.from("续写\n"))]);
  assert.equal(c.open(repaired).toString(), `${lines.slice(0, 3).join("")}续写\n`);
  // 记录序号绑定：用错序号写出的记录读不出（从该条起视为残尾）
  const bad = Buffer.concat([disk, c.record(disk.subarray(0, HEADER_BYTES), 99, Buffer.from("x"))]);
  assert.equal(c.readLog(bad).records, 4);
});

test("追加日志中段损坏：报 corrupt，不当残尾截断（复核 B3-A17）", () => {
  const c = new ZoneCodec("engine_journal", new Map([[1, deriveZoneKey(ws, "engine_journal")]]), 1);
  let disk = c.newLog();
  for (let i = 0; i < 5; i++) disk = Buffer.concat([disk, c.record(disk.subarray(0, HEADER_BYTES), i, Buffer.from(`第${i}条\n`))]);
  // 改第 2 条记录密文中的一个字节（长度完整、认证失败、其后还有 3 条）
  const bad = Buffer.from(disk);
  const second = HEADER_BYTES + (4 + 28 + Buffer.byteLength("第0条\n")) + 4 + 3;
  bad[second]! ^= 1;
  assert.throws(() => c.readLog(bad), (e: any) => e.code === "corrupt");
  assert.throws(() => c.open(bad), (e: any) => e.code === "corrupt");
  // 中段某条的长度字段损坏（指向文件尾之外）：其后还有有效记录 → 报 corrupt（复核 C-A17）
  const lenBad = Buffer.from(disk);
  lenBad.writeUInt32LE(0x00ffffff, HEADER_BYTES + (4 + 28 + Buffer.byteLength("第0条\n")));
  assert.throws(() => c.readLog(lenBad), (e: any) => e.code === "corrupt");
  // 末尾那条坏了：仍按残尾处理
  const tailBad = Buffer.from(disk);
  tailBad[tailBad.length - 1]! ^= 1;
  const r = c.readLog(tailBad);
  assert.equal(r.torn, true);
  assert.equal(r.records, 4);
});

test("密钥环：按用途给编解码器；清零后不可用", () => {
  const w = { gen_current: 1, keys: { "1": Object.fromEntries((["work", "materials", "engine_fs", "engine_journal"] as const).map((p) => [p, deriveZoneKey(ws, p).toString("base64")])) } };
  const ring = MatterKeyRing.fromWire(w);
  const disk = ring.zone("engine_journal").seal(Buffer.from("事件"));
  assert.equal(ring.zone("engine_journal").open(disk).toString(), "事件");
  ring.wipe();
  assert.throws(() => ring.zone("work"), AtRestError);
});

test("分块随机读（第 2 步）：任意明文区间只解所需分块，与整文件解封一致；末块标志与序号仍受认证", () => {
  const c = codec();
  for (const n of [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES + 77]) {
    const plain = randomBytes(n);
    const disk = c.seal(plain);
    assert.ok(isChunkedHeader(disk.subarray(0, HEADER_BYTES)));
    for (const [s, e] of [[0, n], [0, 1], [1, 2], [CHUNK_BYTES - 3, CHUNK_BYTES + 5], [n - 1, n + 10], [n, n + 1], [2 * CHUNK_BYTES, 3 * CHUNK_BYTES + 77]] as const) {
      const span = chunkSpan(disk.length, s, e);
      assert.equal(span.plainSize, n);
      const got = span.count === 0 ? Buffer.alloc(0) : c.openChunks(disk.subarray(0, HEADER_BYTES), span.first, span.total, disk.subarray(span.diskStart, span.diskEnd));
      const from = span.first * CHUNK_BYTES;
      const want = plain.subarray(Math.max(0, Math.min(s, n)), Math.max(0, Math.min(e, n)));
      assert.ok(got.subarray(Math.max(0, Math.min(s, n)) - (span.count ? from : 0)).subarray(0, want.length).equals(want), `n=${n} [${s},${e})`);
    }
  }
  // 把中间块当末块读（声称总块数更少）→ 认证失败；块错位 → 认证失败
  const plain = randomBytes(3 * CHUNK_BYTES);
  const disk = c.seal(plain);
  const span = chunkSpan(disk.length, CHUNK_BYTES, CHUNK_BYTES + 1);
  assert.throws(() => c.openChunks(disk.subarray(0, HEADER_BYTES), span.first, 2, disk.subarray(span.diskStart, span.diskEnd)), AtRestError);
  assert.throws(() => c.openChunks(disk.subarray(0, HEADER_BYTES), span.first + 1, span.total, disk.subarray(span.diskStart, span.diskEnd)), AtRestError);
});

test("区密钥跨线程形态：toWire/fromWire 往返可解；未知用途拒绝", () => {
  const c = codec();
  const disk = c.seal(Buffer.from("跨线程"));
  const back = ZoneCodec.fromWire(JSON.parse(JSON.stringify(c.toWire())));
  assert.equal(back.open(disk).toString(), "跨线程");
  assert.throws(() => ZoneCodec.fromWire({ ...c.toWire(), purpose: "nope" as never }), AtRestError);
});

test("分块结构校验（复核 S3B-A03）：k 块 + 1～27 字节残片、只剩文件头、头 + 不足 28 字节都判残缺；末块位置按 total−1 计", async () => {
  const { isValidChunkedSize, lastChunkSpan } = await import("../src/index.ts");
  const step = CHUNK_BYTES + 28;
  assert.equal(isValidChunkedSize(HEADER_BYTES + 28), true, "空文件 = 一个 28 字节空块");
  for (const bad of [HEADER_BYTES, HEADER_BYTES + 10, HEADER_BYTES + 27, HEADER_BYTES + step + 1, HEADER_BYTES + step + 27, HEADER_BYTES + 2 * step + 5]) {
    assert.equal(isValidChunkedSize(bad), false, `${bad}`);
    assert.throws(() => chunkSpan(bad, 0, 10), (e: any) => e.code === "corrupt");
    assert.throws(() => lastChunkSpan(bad), (e: any) => e.code === "corrupt");
  }
  for (const ok of [HEADER_BYTES + step, HEADER_BYTES + step + 28, HEADER_BYTES + step + 29, HEADER_BYTES + 3 * step]) assert.equal(isValidChunkedSize(ok), true, `${ok}`);
  const c = codec();
  const disk = c.seal(randomBytes(2 * CHUNK_BYTES + 100));
  const last = lastChunkSpan(disk.length);
  assert.equal(last.index, 2);
  assert.equal(last.diskEnd, disk.length);
  assert.ok(c.openChunks(disk.subarray(0, HEADER_BYTES), last.index, last.total, disk.subarray(last.diskStart, last.diskEnd)).length === 100);
});
