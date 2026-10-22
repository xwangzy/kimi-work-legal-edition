/**
 * 法规库包构建流水线（方案 v5.0 第 4 篇 §9、第 5 篇 §2）：
 * sources/*.json（人工采集形态种子）→ 签名只读 SQLite 包（dist/lawdb.sqlite + lawdb.manifest.json）。
 * G0 交付的是流水线与结构 + 演示种子（如实标注），不是 100 部真实采集；
 * 不自动化抓取国家法律法规数据库；商业源未签约前不得入库。
 * 另构建测试夹具包 test-fixtures/lawdb-renumber-demo.sqlite（随包种子 + 虚构的《律师法》2026 修正本与 38→41 条号迁移，
 * 只用于测试改号拦截机制；v9.4 第 19 批 S-07）——安装包与内容分发只取 dist/，夹具不随包。
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
const fixtureFile = join(here, "test-fixtures", "lawdb-renumber-demo.sqlite");

const key = ensureContentSigningKey(join(root, "content", "keys"));
const registry = loadJson(join(here, "sources", "source_registry.json"));
const lawsDoc = loadJson(join(here, "sources", "laws.json"));
// 节假日表随法规库签名分发（v9.4 第 21 批）：每年一行，签名覆盖
const holidaysDoc = loadJson(join(here, "sources", "holidays.json"));

const fixtureDoc = loadJson(join(here, "sources", "test-fixtures", "renumber-demo.json"));

/** 夹具叠加：把被叠加法规的旧版本改为已修改、追加虚构新版本与迁移登记（不改随包种子文件本身）。 */
function withFixture(laws, overlay) {
  const out = structuredClone(laws);
  for (const o of overlay) {
    const law = out.find((l) => l.law_id === o.law_id);
    if (!law) throw new Error(`夹具叠加的法规不在种子里：${o.law_id}`);
    const old = law.versions.find((v) => v.lsv_id === o.supersede.lsv_id);
    if (!old) throw new Error(`夹具叠加的版本不在种子里：${o.supersede.lsv_id}`);
    old.superseded = o.supersede.superseded;
    old.effectiveness = o.supersede.effectiveness;
    law.versions.push(...o.add_versions);
    law.renumbering = [...(law.renumbering ?? []), ...o.renumbering];
  }
  return out;
}

function build(file, laws, purpose) {
  const db = createPackageDb(file);
  db.transaction(() => {
    insertRegistry(db, registry);
    for (const law of laws) insertLaw(db, law);
    for (const y of holidaysDoc.years) db.prepare(`INSERT INTO holidays (year, doc) VALUES (?, ?)`).run(y.year, JSON.stringify(y));
  })();
  const manifest = signAndWriteManifest(db, file, { kind: "full", builtAt: new Date().toISOString(), privateKeyPem: key.privateKeyPem, publicKeyPem: key.publicKeyPem, ...(purpose ? { purpose } : {}) });
  const summary = contentSummary(db);
  db.close();
  return { manifest, summary };
}

const { manifest, summary } = build(outFile, lawsDoc.laws);
const fixture = build(fixtureFile, withFixture(lawsDoc.laws, fixtureDoc.overlay), "test_fixture");

// 自检：按运行时同一路径加载验签
const check = openLawdb(outFile, { expectedSignerPubPem: key.publicKeyPem });
const st = check.status();
check.close();

console.log(`[build:lawdb] 内容签名公钥指纹: ${manifest.signer_key_id}`);
console.log(`[build:lawdb] 产物: ${outFile}（+ lawdb.manifest.json）`);
console.log(`[build:lawdb] 包版本: ${manifest.package_version} · ${st.laws_count} 部 / ${st.versions_count} 版本 / ${st.articles_count} 条正文`);
console.log(`[build:lawdb] 内容表行数: ${JSON.stringify(summary)}`);
console.log(`[build:lawdb] 节假日表: ${holidaysDoc.years.map((y) => y.year).join("、")} 年`);
console.log(`[build:lawdb] 测试夹具（不随包）: ${fixtureFile} · 条号迁移 ${fixture.summary.renumbering ?? "?"} 组`);
console.log(`[build:lawdb] 注意：G0 示例数据集（公报期号/页码为示例值；虚构的《律师法》2026 修正本只在测试夹具里）`);
