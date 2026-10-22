/**
 * v9.4 第 21 批（主文 §3.2“节假日表随法规库签名分发”）：
 * - 随包法规库里有节假日表，与内核内置表逐年一致；它有单独签名（复核 Q3-02：不进法规内容摘要，旧客户端照常验签加载新包）——
 *   被改或缺签名只是不用这张表，法规内容照常可用；增量包合并后保留底包的表；
 * - 内核打开法规库时装入；同一年以包里的为准，包里多出的年份（例如次年安排发布后经内容更新补上）期限计算即可用；
 * - 形状不合格的年份不用。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeContentSha256, openLawdb } from "@zr-legal/lawdb";
import { CN_HOLIDAYS, holidaySource, holidayYear, useSignedHolidays } from "../src/tools/tools/cn-holidays.ts";
import { calcDeadline } from "../src/tools/tools/deadline.ts";
import { LawdbHolder } from "../src/services/content-updates.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const PUB = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const BASE = repo("content/lawdb/dist/lawdb.sqlite");
const INCR = repo("content/lawdb/dist/incr/lawdb-incr-arbitration.sqlite");
const copyPair = (src: string) => {
  const dst = join(mkdtempSync(join(tmpdir(), "kwl-hol-")), "copy.sqlite");
  copyFileSync(src, dst);
  copyFileSync(src.replace(/\.sqlite$/, ".manifest.json"), dst.replace(/\.sqlite$/, ".manifest.json"));
  return dst;
};

after(() => {
  useSignedHolidays([], "");
});

test("随包节假日表与内置表逐年一致；单独签名：被改即不用（法规内容照常可用）", () => {
  const l = openLawdb(BASE, { expectedSignerPubPem: PUB });
  assert.deepEqual(l.holidays(), JSON.parse(JSON.stringify(CN_HOLIDAYS)));
  l.close();
  const t = copyPair(BASE);
  const raw = new Database(t);
  const doc = JSON.parse((raw.prepare(`SELECT doc FROM holidays WHERE year = 2026`).get() as { doc: string }).doc);
  doc.off[0].to = "2026-01-05";
  raw.prepare(`UPDATE holidays SET doc = ? WHERE year = 2026`).run(JSON.stringify(doc));
  raw.close();
  const tampered = openLawdb(t, { expectedSignerPubPem: PUB });
  assert.deepEqual(tampered.holidays(), [], "被改的节假日表不用");
  assert.equal(tampered.status().laws_count, 3, "法规内容照常验签加载");
  tampered.close();
  // 清单里去掉单独签名（旧构建）：同样不用
  const t2 = copyPair(BASE);
  const mf = t2.replace(/\.sqlite$/, ".manifest.json");
  const m = JSON.parse(readFileSync(mf, "utf8"));
  delete m.holidays_signature;
  writeFileSync(mf, JSON.stringify(m));
  const nosig = openLawdb(t2, { expectedSignerPubPem: PUB });
  assert.deepEqual(nosig.holidays(), []);
  nosig.close();
});

test("旧客户端看新包（复核 Q3-02）：节假日表不进法规内容摘要——去掉这张表摘要不变，旧版内核照常验签", () => {
  const t = copyPair(BASE);
  const raw = new Database(t);
  const before = computeContentSha256(raw);
  raw.exec(`DROP TABLE holidays`);
  const after = computeContentSha256(raw);
  raw.close();
  assert.equal(before, after);
  assert.equal(before, JSON.parse(readFileSync(BASE.replace(/\.sqlite$/, ".manifest.json"), "utf8")).content_sha256);
});

test("增量包合并后保留底包的节假日表与单独签名", () => {
  const w = openLawdb(copyPair(BASE), { expectedSignerPubPem: PUB, writable: true });
  w.applyIncremental(INCR, { expectedSignerPubPem: PUB });
  assert.equal(w.holidays().length, 3);
  w.close();
});

test("内核装入：法规库打开即用包里的表；包里多出的年份可用；不合格的年份不用", () => {
  const holder = new LawdbHolder(openLawdb(BASE, { expectedSignerPubPem: PUB }));
  assert.match(holidaySource().table, /随法规库包 g0\..+ 签名分发/);
  assert.deepEqual(holidaySource().years_covered, [2024, 2025, 2026]);
  holder.current.close();

  // 模拟内容更新补上 2027 年（示例数据，只用于测机制）：期限计算即按它顺延
  const y2027 = { year: 2027, title: "示例：2027 年安排", doc_no: "示例", published: "2026-11-01", url: "https://example.invalid/2027", verified_on: "2026-11-02", verified_how: "测试", off: [{ name: "元旦", from: "2027-01-01", to: "2027-01-03" }], workdays: [] };
  const bad = { ...y2027, year: 2028, off: [{ name: "x", from: "2030-01-01", to: "2030-01-02" }] };
  const r = useSignedHolidays([...CN_HOLIDAYS, y2027, bad], "test-pkg");
  assert.deepEqual(r, { used: [2024, 2025, 2026, 2027], rejected: 1 });
  assert.equal(holidayYear(2027)?.title, "示例：2027 年安排");
  assert.equal(holidayYear(2028), undefined, "不合格的年份不用");
  const d = calcDeadline({ start: "2026-12-17", period: { unit: "day", n: 15 }, rule: "civil" });
  assert.equal(d.deadline, "2027-01-04", "1 月 1 日至 3 日放假，届满日顺延到 1 月 4 日");
  assert.equal(d.holiday_source.years_used.find((u) => u.year === 2027)?.status, "verified");
  assert.match(d.holiday_source.table, /test-pkg/);
  // 清空后回到内置表：2027 年未收录，给警告
  useSignedHolidays([], "");
  const e = calcDeadline({ start: "2026-12-17", period: { unit: "day", n: 15 }, rule: "civil" });
  assert.equal(e.holiday_source.years_used.find((u) => u.year === 2027)?.status, "not_collected");
  assert.ok(e.warnings.length > 0);
});
