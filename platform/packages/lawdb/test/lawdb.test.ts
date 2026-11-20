/**
 * 法规库包（方案 v5.0 第 4 篇 §9、第 5 篇 §2）：签名验签拒载、名称归一、时点取版本、
 * 条号迁移、Source Registry 动作强制、增量包 apply 与 base 校验、重复构建确定性。
 * 依赖 content/lawdb/dist 产物与 test-fixtures 夹具（npm test 的 pretest 会先行构建）。
 * 随包法规库不含夹具的演绎文本（v9.4 第 19 批 S-07）；条号迁移用夹具（随包种子 + 夹具演绎的《律师法》“2026 修正本”）测。
 * V23（2026-11-20）：随包种子已含真实的《律师法》2026 修正本（只收第四十一条）与 38→41 迁移，夹具同 lsv_id 版本覆盖它。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { sha256B64, signBytes } from "@zr-legal/keys";
import { computeContentSha256, normalizeLawName, openLawdb, versionAt, type LawdbManifest } from "../src/index.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const PUB = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const BASE = repo("content/lawdb/dist/lawdb.sqlite");
const INCR = repo("content/lawdb/dist/incr/lawdb-incr-arbitration.sqlite");
const FIXTURE = repo("content/lawdb/test-fixtures/lawdb-renumber-demo.sqlite");

function manifestOf(file: string): LawdbManifest {
  return JSON.parse(readFileSync(file.replace(/\.sqlite$/, ".manifest.json"), "utf8")) as LawdbManifest;
}

/** 复制包文件对到临时目录（更新流程的可写副本形态）。 */
function copyPair(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kwl-lawdb-test-"));
  const dst = join(dir, "copy.sqlite");
  copyFileSync(src, dst);
  copyFileSync(src.replace(/\.sqlite$/, ".manifest.json"), dst.replace(/\.sqlite$/, ".manifest.json"));
  return dst;
}

test("加载验签 ok：status 与签名内容一致、重复构建确定", () => {
  const db = openLawdb(BASE, { expectedSignerPubPem: PUB });
  const st = db.status();
  assert.equal(st.signature_valid, true);
  // 第 34 批：9 部 137 条官方发布文本入库（《律师法》第三十八条仍为演示种子）；V10 第 36 批：9 部扩为全文、另收 6 部与 3 部司法解释全文（劳动争议解释（一）第三十二条不入库）；V13 第 38 批：再收专利法、反垄断法、劳动合同法实施条例、反不正当竞争法（2025 修订）、数据安全法 5 部 286 条；V16 第 41 批：第五批 12 部，补收诉讼费用交纳办法 56 条
  assert.equal(st.laws_count, 37);
  // V23（2026-11-20）：+《律师法》2026 修正本（只收第四十一条）、+ 劳动争议解释（一）第三十二条
  assert.equal(st.versions_count, 38);
  assert.equal(st.articles_count, 4019);
  assert.match(st.package_version, /^g0\./);
  // V23（2026-11-20 核验）：覆盖说明按来源登记动态生成——36 部官方发布文本 4,017 条；《律师法》2017 版第三十八条为演示数据，
  // 2026 修正本第四十一条依据修改决定推定；只收了部分条文的版本：律师法 2017（1/60）、律师法 2026（1/65）
  assert.deepEqual(
    st.source_breakdown.map((b) => [b.reliability, b.laws, b.articles]),
    [
      ["official_text_collected", 36, 4017],
      ["demo_seed", 1, 1],
      ["inferred_from_amendment_decision", 1, 1],
    ],
  );
  assert.equal(st.source_breakdown[0]!.collected_until, "2026-11-10");
  assert.equal(st.partial_versions, 2);
  assert.match(st.source_coverage_note, /36 部（4017 条）按官方发布文本采集并与第二官方来源比对（采集截至 2026-11-10），1 部（1 条）为演示数据.*1 部（1 条）依据修改决定推定、修正本逐字全文待采集/);
  assert.match(st.source_coverage_note, /2 个版本只收了部分条文/);
  assert.doesNotMatch(st.source_coverage_note, /G0 演示种子/);
  db.close();
  // content hash 重算 = manifest 声明（确定性：同源同 hash；package_meta 的 built_at 不进签名）
  const raw = new Database(BASE, { readonly: true });
  assert.equal(computeContentSha256(raw), manifestOf(BASE).content_sha256);
  raw.close();
});

test("篡改内容一行 → 哈希不符拒载；错签名公钥 → 拒载；manifest 被改 → 拒载", () => {
  const tampered = copyPair(BASE);
  const raw = new Database(tampered);
  raw.prepare(`UPDATE articles SET text = text || '（篡改）' WHERE lsv_id = 'lsv_lawyers_2017' AND article_no = 38`).run();
  raw.close();
  assert.throws(() => openLawdb(tampered, { expectedSignerPubPem: PUB }), (e: any) => e.code === "lawdb_invalid" && /内容哈希/.test(e.message));

  const other = generateKeyPairSync("ed25519");
  const wrongPub = other.publicKey.export({ format: "pem", type: "spki" }).toString();
  assert.throws(() => openLawdb(BASE, { expectedSignerPubPem: wrongPub }), (e: any) => e.code === "lawdb_invalid" && /指纹/.test(e.message));

  const badManifest = copyPair(BASE);
  const m = manifestOf(badManifest);
  m.package_version = "g0.forged-version";
  writeFileSync(badManifest.replace(/\.sqlite$/, ".manifest.json"), JSON.stringify(m));
  // package_version 不在签名内容内（可改），但内容哈希与签名仍须一致——此处把哈希也伪造掉应被验签拦下
  m.content_sha256 = "forged";
  writeFileSync(badManifest.replace(/\.sqlite$/, ".manifest.json"), JSON.stringify(m));
  assert.throws(() => openLawdb(badManifest, { expectedSignerPubPem: PUB }), (e: any) => e.code === "lawdb_invalid");
});

test("名称归一：书名号/空白/全半角不敏感", () => {
  assert.equal(normalizeLawName("《律师法》"), normalizeLawName("律师法"));
  const db = openLawdb(BASE, { expectedSignerPubPem: PUB });
  for (const q of ["律师法", "《律师法》", " 律师 法 ", "中华人民共和国律师法", "《中华人民共和国律师法》"]) {
    // V23：随包《律师法》有 2017 修正本与 2026 修正本两个版本
    assert.equal(db.findLawVersions(q).length, 2, `「${q}」应命中 2 个版本`);
  }
  assert.equal(db.findLawVersions("不存在的法").length, 0);
  db.close();
});

test("S-07 随包法规库不含夹具的演绎文本；V23：《律师法》2017 修正本已被 2026 修正本取代（2026-09-01 施行），38→41 条号迁移，第四十一条正文同原第三十八条", () => {
  const db = openLawdb(BASE, { expectedSignerPubPem: PUB });
  const rows = db.findLawVersions("律师法");
  assert.deepEqual(rows.map((r) => [r.lsv_id, r.effectiveness, r.superseded, r.total_articles]), [
    ["lsv_lawyers_2017", "amended", "2026-09-01", 60],
    ["lsv_lawyers_2026", "valid", null, 65],
  ]);
  assert.equal(versionAt(rows, "2026-08-31")!.lsv_id, "lsv_lawyers_2017");
  assert.equal(versionAt(rows, "2026-10-01")!.lsv_id, "lsv_lawyers_2026");
  assert.deepEqual(db.getRenumbering("law_lawyers", "lsv_lawyers_2017", "lsv_lawyers_2026", "保密义务").map((r) => [r.from_article, r.to_article]), [[38, 41]]);
  // 修改决定未改原第三十八条：第四十一条正文 = 2017 修正本第三十八条（2012 年修改后的文字，不是夹具里的旧文）
  assert.equal(db.getArticle("lsv_lawyers_2026", 41), db.getArticle("lsv_lawyers_2017", 38));
  assert.match(db.getArticle("lsv_lawyers_2026", 41)!, /不愿泄露的有关情况和信息.*准备或者正在实施危害国家安全、公共安全以及严重危害他人人身安全的犯罪事实和信息除外/s);
  assert.equal(db.getArticle("lsv_lawyers_2026", 38), null, "节选：2026 修正本只收第四十一条");
  assert.equal(db.getSource(rows[1]!.source_license_id)?.reliability, "inferred_from_amendment_decision");
  assert.match(String(db.licenseNoteOf(rows[1]!.source_license_id)), /推定：原第三十八条未修改、条序调整为第四十一条；修正本逐字全文待从国家法律法规数据库采集/);
  db.close();
  const raw = new Database(BASE, { readonly: true });
  assert.equal((raw.prepare(`SELECT COUNT(*) AS c FROM renumbering`).get() as { c: number }).c, 2);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS c FROM law_versions WHERE gazette_issue LIKE '%演绎%' OR total_articles = 68`).get() as { c: number }).c, 0);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS c FROM articles WHERE text LIKE '%演绎%'`).get() as { c: number }).c, 0);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS c FROM source_registry WHERE citation_requirement LIKE '%演绎%'`).get() as { c: number }).c, 0);
  raw.close();
});

test("时点取版本（夹具）：2026-08-31→2017 版；2026-10-01→2026 版；条号迁移查询", () => {
  const db = openLawdb(FIXTURE, { expectedSignerPubPem: PUB, allowTestFixture: true });
  const rows = db.findLawVersions("律师法");
  assert.equal(versionAt(rows, "2026-08-31")!.lsv_id, "lsv_lawyers_2017");
  assert.equal(versionAt(rows, "2026-10-01")!.lsv_id, "lsv_lawyers_2026");
  assert.equal(versionAt(rows, "2010-01-01"), null);
  const rn = db.getRenumbering("law_lawyers", "lsv_lawyers_2017", "lsv_lawyers_2026", "保密义务");
  assert.deepEqual(rn.map((r) => [r.from_article, r.to_article]), [[38, 41]]);
  assert.equal(db.topicArticle("lsv_lawyers_2026", "保密义务"), 41);
  assert.equal(db.topicArticleInOtherVersion("law_lawyers", "lsv_lawyers_2026", "保密义务", 38)!.lsv_id, "lsv_lawyers_2017");
  // 正文覆盖渐进：38 条已采集有正文；第 1 条存在（total_articles 内）但未采集 → null
  assert.match(db.getArticle("lsv_lawyers_2017", 38)!, /保密/);
  assert.equal(db.getArticle("lsv_lawyers_2017", 1), null);
  db.close();
});

test("assertAction：允许/拒绝/过期/未登记", () => {
  const db = openLawdb(BASE, { expectedSignerPubPem: PUB });
  db.assertAction("official-gazette-selfbuilt", "export"); // 全动作
  db.assertAction("official-gazette-selfbuilt", "display");
  db.assertAction("seed-demo", "display");
  assert.throws(() => db.assertAction("seed-demo", "export"), (e: any) => e.code === "source_action_denied" && e.httpStatus === 403 && /seed-demo/.test(e.message));
  assert.throws(() => db.assertAction("seed-demo", "train"), (e: any) => e.code === "source_action_denied");
  assert.throws(() => db.assertAction("ghost-source", "display"), (e: any) => e.code === "source_action_denied" && /未.*登记/.test(e.message));
  db.close();

  // 过期：在可写副本上登记一个已到期来源后断言（只改副本，不动分发包）
  const copy = copyPair(BASE);
  const w = openLawdb(copy, { expectedSignerPubPem: PUB, writable: true });
  const raw = new Database(copy);
  raw
    .prepare(
      `INSERT OR REPLACE INTO source_registry (source_license_id, source_type, licensor, acquired_via, valid_until, allowed_actions_json, acquired_at)
       VALUES ('expired-demo','commercial','某数据商','试用合同','2020-01-01','["display","export"]','2019-01-01')`,
    )
    .run();
  raw.close();
  assert.throws(() => w.assertAction("expired-demo", "display"), (e: any) => e.code === "source_action_denied" && /到期/.test(e.message));
  w.close();
});

test("增量包：apply 后版本与新内容生效；base 不符拒绝；只读库拒绝；签名不符拒绝", () => {
  const baseVer = manifestOf(BASE).package_version;
  const incrVer = manifestOf(INCR).package_version;
  assert.notEqual(incrVer, baseVer);

  // 只读库拒绝
  const ro = openLawdb(BASE, { expectedSignerPubPem: PUB });
  assert.throws(() => ro.applyIncremental(INCR, { expectedSignerPubPem: PUB }), /只读/);
  ro.close();

  // 可写副本 apply 成功
  const copy = copyPair(BASE);
  const w = openLawdb(copy, { expectedSignerPubPem: PUB, writable: true });
  const r = w.applyIncremental(INCR, { expectedSignerPubPem: PUB });
  assert.deepEqual(r, { from_version: baseVer, to_version: incrVer });
  assert.equal(w.status().package_version, incrVer);
  // V10 第 36 批：随包种子已有仲裁法 2025 年修订本，增量补入被它取代的 2017 年修正本
  assert.equal(w.findLawVersions("仲裁法").length, 2);
  assert.match(w.getArticle("lsv_arbitration_2017", 4)!, /自愿/);

  // 再 apply 一次：base_version 已不匹配 → conflict 拒绝
  assert.throws(() => w.applyIncremental(INCR, { expectedSignerPubPem: PUB }), (e: any) => e.code === "conflict" && /base_version/.test(e.message));
  w.close();

  // 重开（只读）：apply 后的副本按新版本验签通过（sidecar 已更新为增量声明的合并哈希与版本）
  const check = openLawdb(copy, { expectedSignerPubPem: PUB });
  assert.equal(check.status().package_version, incrVer);
  check.close();
  const sidecar = manifestOf(copy);
  assert.equal(sidecar.kind, "full", "apply 后 sidecar 应为全量包形态");
  assert.equal(sidecar.package_version, incrVer);
  assert.equal(sidecar.content_sha256, manifestOf(INCR).content_sha256);

  // 签名被篡改的增量 manifest → 拒绝
  const badIncr = copyPair(INCR);
  const bm = manifestOf(badIncr);
  bm.content_sha256 = "forged-merged-hash";
  writeFileSync(badIncr.replace(/\.sqlite$/, ".manifest.json"), JSON.stringify(bm));
  const copy2 = copyPair(BASE);
  const w2 = openLawdb(copy2, { expectedSignerPubPem: PUB, writable: true });
  assert.throws(() => w2.applyIncremental(badIncr, { expectedSignerPubPem: PUB }), (e: any) => e.code === "lawdb_invalid");
  w2.close();
});

test("增量伪造（dev 私钥真签名、声明的合并 hash 与真实合并结果不符）→ 抛错且事务回滚、原库零污染", () => {
  // 构造：真实增量内容 + 合法签名但 content_sha256 是伪造值（验签能过、合并校验必须失败）
  const devPriv = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.json"), "utf8")) as { privateKeyPem: string }).privateKeyPem;
  const badIncr = copyPair(INCR);
  const forged = manifestOf(badIncr);
  forged.content_sha256 = sha256B64("forged-merged-content");
  forged.signature = signBytes(devPriv, new TextEncoder().encode(forged.content_sha256));
  writeFileSync(badIncr.replace(/\.sqlite$/, ".manifest.json"), JSON.stringify(forged));

  const copy = copyPair(BASE);
  const before = manifestOf(copy).package_version;
  const w = openLawdb(copy, { expectedSignerPubPem: PUB, writable: true });
  assert.throws(() => w.applyIncremental(badIncr, { expectedSignerPubPem: PUB }), (e: any) => e.code === "lawdb_invalid" && /回滚/.test(e.message));
  w.close();

  // 回滚断言：逐表行数与关键内容未变、版本未变（用独立只读句柄复核文件真实状态）
  const raw = new Database(copy, { readonly: true });
  const n = (sql: string) => (raw.prepare(sql).get() as { c: number }).c;
  assert.equal(n(`SELECT COUNT(*) AS c FROM laws`), 37);
  assert.equal(n(`SELECT COUNT(*) AS c FROM law_versions`), 38);
  assert.equal(n(`SELECT COUNT(*) AS c FROM articles`), 4019);
  // V23：+《律师法》2026 修正本主题 2 个、合读提示 52 个；+ 38→41 迁移 2 组；+ 来源登记 amendment-decision-inferred-2026-11
  assert.equal(n(`SELECT COUNT(*) AS c FROM article_topics`), 223);
  assert.equal(n(`SELECT COUNT(*) AS c FROM renumbering`), 2);
  assert.equal(n(`SELECT COUNT(*) AS c FROM source_registry`), 6);
  // V10 第 36 批：随包种子已有仲裁法 2025 年修订本（law_arbitration 一行），增量补的 2017 年修正本不得残留
  assert.equal(n(`SELECT COUNT(*) AS c FROM laws WHERE law_id = 'law_arbitration'`), 1, "随包的仲裁法一行照旧");
  assert.equal(n(`SELECT COUNT(*) AS c FROM law_versions WHERE lsv_id = 'lsv_arbitration_2017'`), 0);
  assert.equal((raw.prepare(`SELECT value FROM package_meta WHERE key = 'package_version'`).get() as { value: string }).value, before);
  raw.close();
  // 原包仍可验签打开（sidecar 未被写坏）
  const check = openLawdb(copy, { expectedSignerPubPem: PUB });
  assert.equal(check.status().package_version, before);
  check.close();
});

test("测试夹具（复核 Q2-19）：缺省拒绝加载；去掉用途标记即验签失败；显式允许才可用；随包库不带用途标记", async () => {
  const { readFileSync, writeFileSync, copyFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.throws(() => openLawdb(FIXTURE, { expectedSignerPubPem: PUB }), /测试用的法规库夹具/);
  const ok = openLawdb(FIXTURE, { expectedSignerPubPem: PUB, allowTestFixture: true });
  ok.close();
  const dir = mkdtempSync(join(tmpdir(), "kwl-fixture-"));
  const f = join(dir, "lawdb.sqlite");
  copyFileSync(FIXTURE, f);
  const m = JSON.parse(readFileSync(FIXTURE.replace(/\.sqlite$/, ".manifest.json"), "utf8"));
  assert.equal(m.purpose, "test_fixture");
  delete m.purpose;
  writeFileSync(join(dir, "lawdb.manifest.json"), JSON.stringify(m));
  assert.throws(() => openLawdb(f, { expectedSignerPubPem: PUB }), /验签失败/, "去掉用途标记冒充正式包：签名对不上");
  const shipped = JSON.parse(readFileSync(repo("content/lawdb/dist/lawdb.manifest.json"), "utf8"));
  assert.equal(shipped.purpose, undefined);
});
