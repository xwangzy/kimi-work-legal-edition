/**
 * 法规库包（方案 v5.0 第 4 篇 §9、第 5 篇 §2）：签名验签拒载、名称归一、时点取版本、
 * 条号迁移、Source Registry 动作强制、增量包 apply 与 base 校验、重复构建确定性。
 * 依赖 content/lawdb/dist 产物与 test-fixtures 夹具（npm test 的 pretest 会先行构建）。
 * 随包法规库不含虚构版本（v9.4 第 19 批 S-07）；条号迁移用夹具（随包种子 + 虚构的《律师法》2026 修正本）测。
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
  assert.equal(st.laws_count, 3);
  assert.equal(st.versions_count, 3);
  assert.equal(st.articles_count, 7);
  assert.match(st.package_version, /^g0\./);
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
    assert.equal(db.findLawVersions(q).length, 1, `「${q}」应命中 1 个版本`);
  }
  assert.equal(db.findLawVersions("不存在的法").length, 0);
  db.close();
});

test("S-07 随包法规库不含虚构版本：《律师法》只有 2017 修正本且为现行，没有条号迁移，没有“演示演绎”文本", () => {
  const db = openLawdb(BASE, { expectedSignerPubPem: PUB });
  const rows = db.findLawVersions("律师法");
  assert.deepEqual(rows.map((r) => [r.lsv_id, r.effectiveness, r.superseded]), [["lsv_lawyers_2017", "valid", null]]);
  assert.equal(versionAt(rows, "2026-10-01")!.lsv_id, "lsv_lawyers_2017");
  db.close();
  const raw = new Database(BASE, { readonly: true });
  assert.equal((raw.prepare(`SELECT COUNT(*) AS c FROM renumbering`).get() as { c: number }).c, 0);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS c FROM law_versions WHERE gazette_issue LIKE '%演绎%' OR lsv_id = 'lsv_lawyers_2026'`).get() as { c: number }).c, 0);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS c FROM articles WHERE text LIKE '%演绎%'`).get() as { c: number }).c, 0);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS c FROM source_registry WHERE citation_requirement LIKE '%演绎%'`).get() as { c: number }).c, 0);
  raw.close();
});

test("时点取版本（夹具）：2026-08-31→2017 版；2026-10-01→2026 版；条号迁移查询", () => {
  const db = openLawdb(FIXTURE, { expectedSignerPubPem: PUB });
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
  assert.equal(w.findLawVersions("仲裁法").length, 1);
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
  assert.equal(n(`SELECT COUNT(*) AS c FROM laws`), 3);
  assert.equal(n(`SELECT COUNT(*) AS c FROM law_versions`), 3);
  assert.equal(n(`SELECT COUNT(*) AS c FROM articles`), 7);
  assert.equal(n(`SELECT COUNT(*) AS c FROM article_topics`), 8);
  assert.equal(n(`SELECT COUNT(*) AS c FROM renumbering`), 0);
  assert.equal(n(`SELECT COUNT(*) AS c FROM source_registry`), 2);
  assert.equal(n(`SELECT COUNT(*) AS c FROM laws WHERE law_id = 'law_arbitration'`), 0, "增量行不得残留");
  assert.equal(n(`SELECT COUNT(*) AS c FROM law_versions WHERE lsv_id = 'lsv_arbitration_2017'`), 0);
  assert.equal((raw.prepare(`SELECT value FROM package_meta WHERE key = 'package_version'`).get() as { value: string }).value, before);
  raw.close();
  // 原包仍可验签打开（sidecar 未被写坏）
  const check = openLawdb(copy, { expectedSignerPubPem: PUB });
  assert.equal(check.status().package_version, before);
  check.close();
});
