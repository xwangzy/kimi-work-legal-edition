/**
 * 法规库包构建流水线（方案 v5.0 第 4 篇 §9、第 5 篇 §2）：
 * sources/*.json（人工采集形态种子）→ 签名只读 SQLite 包（dist/lawdb.sqlite + lawdb.manifest.json）。
 * G0 交付的是流水线与结构 + 演示种子（如实标注），不是 100 部真实采集；
 * 不自动化抓取国家法律法规数据库；商业源未签约前不得入库。
 * 用法：npm run build:lawdb（根目录）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { contentSummary, createPackageDb, ensureContentSigningKey, insertLaw, insertRegistry, loadJson, signAndWriteManifest } from "./lib/build-util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const distDir = join(here, "dist");
const outFile = join(distDir, "lawdb.sqlite");

const key = ensureContentSigningKey(join(root, "content", "keys"));
const registry = loadJson(join(here, "sources", "source_registry.json"));
const lawsDoc = loadJson(join(here, "sources", "laws.json"));

const db = createPackageDb(outFile);
db.transaction(() => {
  insertRegistry(db, registry);
  for (const law of lawsDoc.laws) insertLaw(db, law);
})();

const manifest = signAndWriteManifest(db, outFile, { kind: "full", builtAt: new Date().toISOString(), privateKeyPem: key.privateKeyPem, publicKeyPem: key.publicKeyPem });
const summary = contentSummary(db);
db.close();

// 自检：按运行时同一路径加载验签
const check = openLawdb(outFile, { expectedSignerPubPem: key.publicKeyPem });
const st = check.status();
check.close();

console.log(`[build:lawdb] 内容签名公钥指纹: ${manifest.signer_key_id}`);
console.log(`[build:lawdb] 产物: ${outFile}（+ lawdb.manifest.json）`);
console.log(`[build:lawdb] 包版本: ${manifest.package_version} · ${st.laws_count} 部 / ${st.versions_count} 版本 / ${st.articles_count} 条正文`);
console.log(`[build:lawdb] 内容表行数: ${JSON.stringify(summary)}`);
console.log(`[build:lawdb] 注意：G0 示例数据集（《律师法》2026 修正文本为演示演绎，非真实采集；公报期号/页码为示例值）`);
