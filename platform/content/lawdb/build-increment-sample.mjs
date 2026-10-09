/**
 * 增量包构建演示（方案 §9「每日签名增量包」的格式 + 验证 + apply 演示；不做真实每日构建）：
 * 以 dist/lawdb.sqlite 为 base，构造「新增一部种子法」的增量包（dist/incr/），
 * manifest 签名内容为「合并后全量内容 hash」，随后用可写副本走一遍真实 apply 自检。
 * 用法：node content/lawdb/build-increment-sample.mjs（须先 npm run build:lawdb）。
 */
import Database from "better-sqlite3-multiple-ciphers";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signBytes } from "@zr-legal/keys";
import { computeContentSha256, openLawdb, signerKeyId } from "@zr-legal/lawdb";
import { contentSummary, createPackageDb, ensureContentSigningKey, insertLaw, insertRegistry, loadJson, manifestPathFor } from "./lib/build-util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const baseFile = join(here, "dist", "lawdb.sqlite");
if (!existsSync(baseFile)) throw new Error("先运行 npm run build:lawdb 构建基础包");

const key = ensureContentSigningKey(join(root, "content", "keys"));
const baseManifest = JSON.parse(readFileSync(manifestPathFor(baseFile), "utf8"));

// 增量内容（演示种子，如实标注）：新增《中华人民共和国仲裁法》（演示形态，非采集产物）
const DELTA_LAW = {
  law_id: "law_arbitration",
  law_name: "中华人民共和国仲裁法",
  aliases: ["仲裁法"],
  level: "法律",
  region: "全国",
  versions: [
    {
      lsv_id: "lsv_arbitration_2017",
      promulgated: "2017-09-01",
      effective: "2018-01-01",
      superseded: null,
      effectiveness: "valid",
      total_articles: 80,
      gazette_issue: "示例期号（增量演示，非真实采集）",
      gazette_page: "0",
      collected_at: "2026-10-02",
      official_url: "https://flk.npc.gov.cn/",
      source_license_id: "official-gazette-selfbuilt",
      topics: { 自愿仲裁: 4 },
      articles: [{ no: 4, text: "当事人采用仲裁方式解决纠纷，应当双方自愿，达成仲裁协议。没有仲裁协议，一方申请仲裁的，仲裁委员会不予受理。" }],
    },
  ],
  renumbering: [],
};

// 1. 合并副本：复制 base → 可写打开 → 注入增量 → 算合并后全量 hash
const tmp = mkdtempSync(join(tmpdir(), "kwl-lawdb-incr-"));
const mergedFile = join(tmp, "merged.sqlite");
copyFileSync(baseFile, mergedFile);
const merged = new Database(mergedFile);
merged.transaction(() => insertLaw(merged, DELTA_LAW))();
const mergedSha = computeContentSha256(merged);
merged.close();

// 2. 增量包：只含 delta 行；manifest 声明 base_version 与合并后全量 hash
const incrDir = join(here, "dist", "incr");
mkdirSync(incrDir, { recursive: true });
const incrFile = join(incrDir, "lawdb-incr-arbitration.sqlite");
const incrDb = createPackageDb(incrFile);
incrDb.transaction(() => {
  // 外键引用须随增量同行（registry 许可变化本就随内容更新下发，§2.2）
  insertRegistry(incrDb, loadJson(join(here, "sources", "source_registry.json")));
  insertLaw(incrDb, DELTA_LAW);
})();
incrDb.close();
const manifest = {
  kind: "incremental",
  package_version: `g0.${mergedSha.slice(0, 12)}`,
  base_version: baseManifest.package_version,
  built_at: new Date().toISOString(),
  content_sha256: mergedSha,
  signature: signBytes(key.privateKeyPem, new TextEncoder().encode(mergedSha)),
  signer_key_id: signerKeyId(key.publicKeyPem),
};
writeFileSync(manifestPathFor(incrFile), JSON.stringify(manifest, null, 2) + "\n");

// 3. 自检：复制 base 文件对 → 可写打开 → applyIncremental → 校验新版本与新内容
const applyCopy = join(tmp, "apply-copy.sqlite");
copyFileSync(baseFile, applyCopy);
copyFileSync(manifestPathFor(baseFile), manifestPathFor(applyCopy));
const w = openLawdb(applyCopy, { expectedSignerPubPem: key.publicKeyPem, writable: true });
const r = w.applyIncremental(incrFile, { expectedSignerPubPem: key.publicKeyPem });
const after = w.status();
const found = w.findLawVersions("仲裁法").length;
w.close();

console.log(`[build:lawdb:incr] 增量包: ${incrFile}（+ manifest）`);
console.log(`[build:lawdb:incr] apply 自检: ${r.from_version} → ${r.to_version}；仲裁法命中 ${found} 部；合并后 ${JSON.stringify({ laws: after.laws_count, versions: after.versions_count, articles: after.articles_count })}`);
console.log(`[build:lawdb:incr] base 包内容摘要（不变）: ${JSON.stringify(contentSummary(new Database(baseFile, { readonly: true })))}`);
