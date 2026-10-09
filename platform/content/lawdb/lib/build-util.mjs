/**
 * lawdb 构建共享工具（build-lawdb.mjs 与 build-increment-sample.mjs 共用）。
 * 生产采集契约：sources/*.json 即人工采集形态（每条 law_version 带公报期号/页码/采集日期）；
 * 不自动化抓取国家法律法规数据库（第 5 篇 §2.1 红线）。
 */
import Database from "better-sqlite3-multiple-ciphers";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { signBytes, sha256B64 } from "@zr-legal/keys";
import { LAWDB_SCHEMA_SQL, CONTENT_TABLES, computeContentSha256, signerKeyId } from "@zr-legal/lawdb";

export function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 开发内容签名密钥（G0 开发形态；生产私钥在硬件模块/云签名，公钥随包内置）。 */
export function ensureContentSigningKey(keysDir) {
  mkdirSync(keysDir, { recursive: true });
  const privFile = join(keysDir, "content-signing-dev.json");
  const pubFile = join(keysDir, "content-signing-dev.pub.json");
  if (existsSync(privFile)) {
    const raw = loadJson(privFile);
    return { publicKeyPem: raw.publicKeyPem, privateKeyPem: raw.privateKeyPem, pubFile };
  }
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(
    privFile,
    JSON.stringify(
      {
        _comment: "G0 开发形态内容签名私钥（0600）：法规库包构建签名用；生产私钥在硬件模块/云签名，不入仓不入包。",
        publicKeyPem,
        privateKeyPem,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  writeFileSync(pubFile, JSON.stringify({ _comment: "内容签名公钥（随客户端内置，内核验签法规库包用）", publicKeyPem }, null, 2));
  return { publicKeyPem, privateKeyPem, pubFile };
}

export function createPackageDb(file) {
  rmSync(file, { force: true });
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(LAWDB_SCHEMA_SQL);
  return db;
}

export function insertRegistry(db, rows) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO source_registry (source_license_id, source_type, licensor, acquired_via, contract_ref, valid_until,
      allowed_actions_json, region, firm_limit, concurrency_limit, citation_requirement, deletion_obligation, acquired_at, reliability, withdrawn_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.source_license_id,
      r.source_type,
      r.licensor ?? "",
      r.acquired_via ?? "",
      r.contract_ref ?? null,
      r.valid_until ?? null,
      JSON.stringify(r.allowed_actions ?? []),
      r.region ?? "",
      r.firm_limit ?? null,
      r.concurrency_limit ?? null,
      r.citation_requirement ?? null,
      r.deletion_obligation ?? null,
      r.acquired_at,
      r.reliability ?? "",
      r.withdrawn_reason ?? null,
    );
  }
}

export function insertLaw(db, law) {
  db.prepare(`INSERT OR REPLACE INTO laws (law_id, law_name, aliases_json, level, region) VALUES (?,?,?,?,?)`).run(
    law.law_id,
    law.law_name,
    JSON.stringify(law.aliases ?? []),
    law.level ?? "",
    law.region ?? "",
  );
  const vStmt = db.prepare(
    `INSERT OR REPLACE INTO law_versions (lsv_id, law_id, promulgated, effective, superseded, effectiveness, total_articles,
      gazette_issue, gazette_page, collected_at, official_url, source_license_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const aStmt = db.prepare(`INSERT OR REPLACE INTO articles (lsv_id, article_no, text) VALUES (?,?,?)`);
  const tStmt = db.prepare(`INSERT OR REPLACE INTO article_topics (lsv_id, topic, article_no) VALUES (?,?,?)`);
  const rStmt = db.prepare(`INSERT OR REPLACE INTO renumbering (law_id, from_lsv_id, to_lsv_id, topic, from_article, to_article) VALUES (?,?,?,?,?,?)`);
  for (const v of law.versions ?? []) {
    vStmt.run(
      v.lsv_id,
      law.law_id,
      v.promulgated,
      v.effective,
      v.superseded ?? null,
      v.effectiveness,
      v.total_articles,
      v.gazette_issue ?? "",
      v.gazette_page ?? "",
      v.collected_at,
      v.official_url ?? "",
      v.source_license_id,
    );
    for (const a of v.articles ?? []) aStmt.run(v.lsv_id, a.no, a.text);
    for (const [topic, no] of Object.entries(v.topics ?? {})) tStmt.run(v.lsv_id, topic, no);
  }
  for (const r of law.renumbering ?? []) rStmt.run(law.law_id, r.from_lsv_id, r.to_lsv_id, r.topic, r.from_article, r.to_article);
}

export function setPackageMeta(db, packageVersion, builtAt, extra = {}) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO package_meta (key, value) VALUES (?, ?)`);
  stmt.run("package_version", packageVersion);
  stmt.run("built_at", builtAt);
  for (const [k, v] of Object.entries(extra)) stmt.run(k, String(v));
}

export function manifestPathFor(file) {
  return file.endsWith(".sqlite") ? `${file.slice(0, -".sqlite".length)}.manifest.json` : `${file}.manifest.json`;
}

/**
 * 计算内容 hash 并写 sidecar manifest（Ed25519 签名）。
 * package_version 取内容 hash 前缀（同源重复构建同版本同 hash，确定性可复现；built_at 在签名内容之外）。
 */
export function signAndWriteManifest(db, file, { kind, baseVersion, builtAt, privateKeyPem, publicKeyPem }) {
  const contentSha256 = computeContentSha256(db);
  const packageVersion = `g0.${contentSha256.slice(0, 12)}`;
  setPackageMeta(db, packageVersion, builtAt, baseVersion ? { base_version: baseVersion } : {});
  const manifest = {
    kind,
    package_version: packageVersion,
    ...(baseVersion ? { base_version: baseVersion } : {}),
    built_at: builtAt,
    content_sha256: contentSha256,
    signature: signBytes(privateKeyPem, new TextEncoder().encode(contentSha256)),
    signer_key_id: signerKeyId(publicKeyPem),
  };
  writeFileSync(manifestPathFor(file), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** 内容表行数摘要（构建日志用）。 */
export function contentSummary(db) {
  const out = {};
  for (const t of CONTENT_TABLES) out[t.name] = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get().n;
  return out;
}

export { sha256B64 };
