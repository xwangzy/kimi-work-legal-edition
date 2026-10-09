/**
 * Source Registry 导出强制端到端（第 5 篇 §2.2）与法规库加载失败口径：
 * - 自建「display only」受限来源的签名测试包，deliveries 导出 → 403 source_action_denied（权限不足停止动作）；
 * - ZR_LAWDB_FILE 指向不存在文件 → createKernel 抛 lawdb_invalid（中文报错，不静默降级、不崩溃）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { signBytes } from "@zr-legal/keys";
import { LAWDB_SCHEMA_SQL, computeContentSha256, signerKeyId } from "@zr-legal/lawdb";
import { makeKernel, runScenario, importText, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "lawdb-export-test-secret-0123456";

/** 造一个签名合法的测试包：1 部律师法（38→41 迁移），来源 restricted-demo 只允许 search/display（无 export）。 */
function buildRestrictedPackage(): { file: string; pub: string } {
  const dir = mkdtempSync(join(tmpdir(), "kwl-lawdb-restricted-"));
  const file = join(dir, "lawdb.sqlite");
  const devKey = JSON.parse(readFileSync(repo("content/keys/content-signing-dev.json"), "utf8")) as { publicKeyPem: string; privateKeyPem: string };

  const db = new Database(file);
  db.exec(LAWDB_SCHEMA_SQL);
  db.prepare(
    `INSERT INTO source_registry (source_license_id, source_type, licensor, acquired_via, valid_until, allowed_actions_json, citation_requirement, acquired_at, reliability)
     VALUES ('restricted-demo','official_gazette','（受限演示）','测试构造',NULL,'["search","display"]','受限演示来源：仅 search/display','2026-10-02','demo_seed')`,
  ).run();
  db.prepare(`INSERT INTO laws (law_id, law_name, aliases_json, level, region) VALUES ('law_lawyers','中华人民共和国律师法','["律师法"]','法律','全国')`).run();
  const v = db.prepare(
    `INSERT INTO law_versions (lsv_id, law_id, promulgated, effective, superseded, effectiveness, total_articles, gazette_issue, gazette_page, collected_at, official_url, source_license_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  v.run("lsv_lawyers_2017", "law_lawyers", "2017-09-01", "2018-01-01", "2026-09-01", "amended", 60, "示例", "0", "2026-10-02", "https://flk.npc.gov.cn/", "restricted-demo");
  v.run("lsv_lawyers_2026", "law_lawyers", "2026-06-30", "2026-09-01", null, "valid", 68, "示例", "0", "2026-10-02", "https://flk.npc.gov.cn/", "restricted-demo");
  const t = db.prepare(`INSERT INTO article_topics (lsv_id, topic, article_no) VALUES (?,?,?)`);
  t.run("lsv_lawyers_2017", "保密义务", 38);
  t.run("lsv_lawyers_2026", "保密义务", 41);
  db.prepare(`INSERT INTO articles (lsv_id, article_no, text) VALUES ('lsv_lawyers_2026',41,'（演示文本）')`).run();
  db.prepare(`INSERT INTO renumbering (law_id, from_lsv_id, to_lsv_id, topic, from_article, to_article) VALUES ('law_lawyers','lsv_lawyers_2017','lsv_lawyers_2026','保密义务',38,41)`).run();

  const contentSha256 = computeContentSha256(db);
  db.prepare(`INSERT INTO package_meta (key, value) VALUES ('package_version', ?), ('built_at', ?)`).run(`g0.${contentSha256.slice(0, 12)}`, new Date().toISOString());
  db.close();
  const manifest = {
    kind: "full",
    package_version: `g0.${contentSha256.slice(0, 12)}`,
    built_at: new Date().toISOString(),
    content_sha256: contentSha256,
    signature: signBytes(devKey.privateKeyPem, new TextEncoder().encode(contentSha256)),
    signer_key_id: signerKeyId(devKey.publicKeyPem),
  };
  writeFileSync(file.replace(/\.sqlite$/, ".manifest.json"), JSON.stringify(manifest, null, 2));
  return { file, pub: devKey.publicKeyPem };
}

let tks: TestKernel[] = [];
after(async () => {
  for (const tk of tks) await tk.kernel.close();
});

test("deliveries 导出：来源未授权 export → 403 source_action_denied 端到端", { timeout: 240_000 }, async () => {
  const { file } = buildRestrictedPackage();
  const tk = await makeKernel({ ZR_LAWDB_FILE: file }, "export-gate-firm");
  tks.push(tk);
  const { inv } = tk;

  const st = await inv("lawdb.status");
  assert.equal(st.laws_count, 1, "受限测试包已加载");

  const { matter } = await inv("matters.create", { title: "导出拒绝测试事项", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  const d = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id], topic_hint: "保密义务" }, 120_000);
  assert.equal(d.run.status, "succeeded");
  const art = d.artifacts.find((a: any) => a.kind === "s1_opinion");
  // 引用核验本身通过（display 允许；38 按迁移被拦截属正常裁决）
  const cit = d.events.find((e: any) => e.type === "citations.verified")!;
  assert.ok(cit.payload.verdicts.some((v: any) => v.lsv_id === "lsv_lawyers_2026"));

  // 导出（download 与 external_send 同属离开平台）→ 来源无 export 授权 → 403
  await assert.rejects(
    () => inv("deliveries.create", { artifact_version_id: art.artifact_version_id, action: "download" }),
    (e: any) => e.code === "source_action_denied" && e.httpStatus === 403 && /restricted-demo/.test(e.message) && /export/.test(e.message),
  );
});

test("ZR_LAWDB_FILE 指向不存在文件：createKernel 抛 lawdb_invalid（中文报错，不静默降级）", async () => {
  await assert.rejects(
    () => makeKernel({ ZR_LAWDB_FILE: join(tmpdir(), "kwl-no-such-lawdb.sqlite") }, "missing-lawdb-firm"),
    (e: any) => e.code === "lawdb_invalid" && /无法打开|manifest|build:lawdb/.test(e.message),
  );
});
