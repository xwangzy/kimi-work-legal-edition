/**
 * 离线法规版本库（方案 v5.0 第 4 篇 §9、第 5 篇 §2）：随客户端分发的签名只读 SQLite 包。
 *
 * - 内容：法规、条文、公布/施行/修改/失效日期、效力状态、修订沿革（renumbering）、官方链接；
 *   每条 law_versions 记录保存公报期号、页码与采集日期（§2.1 人工采集契约）。
 * - 签名：manifest 以 sidecar 文件（<包名>.manifest.json）随包分发，而非 meta 表——
 *   数据库文件字节与签名分离，content_sha256 只覆盖内容表（package_meta 的 built_at 等
 *   易变字段不进签名，同源重复构建同 hash）；更新流程「复制→apply→校验→原子替换」
 *   以文件对为单位原子换入，验签失败拒绝加载（lawdb_invalid，不静默降级到任何种子）。
 * - Source Registry（§2.2）随包签名分发：运行时每次检索/展示/导出由本机内核按
 *   source_license_id + allowed_action + valid_until 强制校验；权限不足停止相应动作。
 * - 增量包：同 schema 子集 + manifest(kind='incremental', base_version, 合并后全量 hash)；
 *   apply 只作用于可写副本（只读库拒绝），事务内 upsert 后重算全量 hash 与 manifest 不符即回滚。
 */
import Database from "better-sqlite3-multiple-ciphers";
import { readFileSync, writeFileSync } from "node:fs";
import { DomainError } from "@zr-legal/domain";
import { canonicalJson, sha256B64, verifyBytes } from "@zr-legal/keys";

// ─── schema 与签名内容口径（构建脚本与运行时共用，单点定义） ───

/**
 * 全国法定节假日与调休安排（v9.4 第 21 批；V9.4 主文 §3.2“节假日表随法规库签名分发”）：每年一行，doc 为该年国办通知的结构化录入
 * （来源 URL、发文字号、放假区间、调休上班日）。**不进法规内容摘要**（复核 Q3-02：否则第 21 批以前的客户端算出的摘要与清单不符，
 * 会把新包当“被改动”拒收）——另由清单里的 holidays_sha256 + holidays_signature 单独签名（签“摘要 + \nholidays”）。
 * 验不过（被改、缺签名、换了签名密钥）只是不用这张表，期限计算退回程序内置的表；法规内容照常可用。
 */
export const HOLIDAYS_DDL = "CREATE TABLE IF NOT EXISTS holidays (year integer PRIMARY KEY, doc text NOT NULL);";

export const LAWDB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS laws (
  law_id text PRIMARY KEY,
  law_name text NOT NULL,
  aliases_json text NOT NULL DEFAULT '[]',
  level text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS law_versions (
  lsv_id text PRIMARY KEY,
  law_id text NOT NULL REFERENCES laws(law_id),
  promulgated text NOT NULL,
  effective text NOT NULL,
  superseded text,
  effectiveness text NOT NULL,
  total_articles integer NOT NULL,
  gazette_issue text NOT NULL DEFAULT '',
  gazette_page text NOT NULL DEFAULT '',
  collected_at text NOT NULL,
  official_url text NOT NULL DEFAULT '',
  source_license_id text NOT NULL REFERENCES source_registry(source_license_id)
);
CREATE TABLE IF NOT EXISTS articles (
  lsv_id text NOT NULL REFERENCES law_versions(lsv_id),
  article_no integer NOT NULL,
  text text NOT NULL,
  PRIMARY KEY (lsv_id, article_no)
);
CREATE TABLE IF NOT EXISTS article_topics (
  lsv_id text NOT NULL REFERENCES law_versions(lsv_id),
  topic text NOT NULL,
  article_no integer NOT NULL,
  PRIMARY KEY (lsv_id, topic)
);
CREATE TABLE IF NOT EXISTS renumbering (
  law_id text NOT NULL REFERENCES laws(law_id),
  from_lsv_id text NOT NULL,
  to_lsv_id text NOT NULL,
  topic text NOT NULL,
  from_article integer NOT NULL,
  to_article integer NOT NULL
);
CREATE TABLE IF NOT EXISTS source_registry (
  source_license_id text PRIMARY KEY,
  source_type text NOT NULL,
  licensor text NOT NULL DEFAULT '',
  acquired_via text NOT NULL DEFAULT '',
  contract_ref text,
  valid_until text,
  allowed_actions_json text NOT NULL DEFAULT '[]',
  region text NOT NULL DEFAULT '',
  firm_limit text,
  concurrency_limit text,
  citation_requirement text,
  deletion_obligation text,
  acquired_at text NOT NULL,
  reliability text NOT NULL DEFAULT '',
  withdrawn_reason text
);
CREATE TABLE IF NOT EXISTS package_meta (key text PRIMARY KEY, value text NOT NULL);
${HOLIDAYS_DDL}
`;

/** 签名内容表（按此顺序逐行 canonicalJson 连接；package_meta 等易变内容不在其列）。 */
export const CONTENT_TABLES: readonly { name: string; orderBy: string }[] = [
  { name: "laws", orderBy: "law_id" },
  { name: "law_versions", orderBy: "lsv_id" },
  { name: "articles", orderBy: "lsv_id, article_no" },
  { name: "article_topics", orderBy: "lsv_id, topic" },
  { name: "renumbering", orderBy: "law_id, from_lsv_id, to_lsv_id, topic" },
  { name: "source_registry", orderBy: "source_license_id" },
];

/** 节假日表的摘要（与内容摘要同一写法；没有这张表或没有行时为 null）。 */
export function computeHolidaysSha256(db: Db): string | null {
  if (!hasTable(db, "holidays")) return null;
  const rows = db.prepare(`SELECT * FROM holidays ORDER BY year`).all() as Record<string, unknown>[];
  if (rows.length === 0) return null;
  return sha256B64(rows.map((r) => `holidays:${canonicalJson(r)}`).join("\n"));
}

export interface LawdbManifest {
  kind: "full" | "incremental";
  package_version: string;
  base_version?: string;
  built_at: string;
  content_sha256: string;
  signature: string;
  signer_key_id: string;
  /** 测试夹具（v9.4 第 20 批，复核 Q2-19）：签名覆盖“内容摘要 + 用途”；运行时默认拒绝加载。 */
  purpose?: "test_fixture";
  /** 节假日表的单独签名（v9.4 第 21 批，复核 Q3-02）：旧客户端不认这两个字段，照常按内容摘要验签。 */
  holidays_sha256?: string;
  holidays_signature?: string;
}

export function signerKeyId(publicKeyPem: string): string {
  return sha256B64(publicKeyPem).slice(0, 16);
}

type Db = InstanceType<typeof Database>;

/** 内容哈希：内容表按表名序、行按主键序逐行 canonicalJson，以「表名：行」连接后 sha256。 */
export function computeContentSha256(db: Db): string {
  const lines: string[] = [];
  for (const t of CONTENT_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t.name} ORDER BY ${t.orderBy}`).all() as Record<string, unknown>[];
    for (const row of rows) lines.push(`${t.name}:${canonicalJson(row)}`);
  }
  return sha256B64(lines.join("\n"));
}

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function manifestPathFor(file: string): string {
  return file.endsWith(".sqlite") ? `${file.slice(0, -".sqlite".length)}.manifest.json` : `${file}.manifest.json`;
}

function readManifest(path: string): LawdbManifest {
  let m: LawdbManifest;
  try {
    m = JSON.parse(readFileSync(path, "utf8")) as LawdbManifest;
  } catch (e) {
    throw new DomainError("lawdb_invalid", `法规库 manifest 缺失或不可解析（${path}）：${(e as Error)?.message ?? e}。请先运行 npm run build:lawdb 构建法规库包`, 422);
  }
  if (typeof m?.package_version !== "string" || typeof m?.content_sha256 !== "string" || typeof m?.signature !== "string" || typeof m?.signer_key_id !== "string") {
    throw new DomainError("lawdb_invalid", "法规库 manifest 字段不全（需要 package_version/content_sha256/signature/signer_key_id）", 422);
  }
  return m;
}

function verifyAgainstManifest(db: Db, manifest: LawdbManifest, expectedSignerPubPem: string): void {
  if (manifest.signer_key_id !== signerKeyId(expectedSignerPubPem)) {
    throw new DomainError("lawdb_invalid", `法规库签名者指纹（${manifest.signer_key_id}）与预期内容签名公钥不符，拒绝加载`, 422);
  }
  const signed = manifest.purpose ? `${manifest.content_sha256}\n${manifest.purpose}` : manifest.content_sha256;
  if (!verifyBytes(expectedSignerPubPem, new TextEncoder().encode(signed), manifest.signature)) {
    throw new DomainError("lawdb_invalid", "法规库签名验签失败（manifest 签名与内容签名公钥不符），拒绝加载", 422);
  }
  const actual = computeContentSha256(db);
  if (actual !== manifest.content_sha256) {
    throw new DomainError("lawdb_invalid", "法规库内容哈希与签名 manifest 不符（内容被改动），拒绝加载", 422);
  }
}

// ─── 行类型 ───

export interface LawVersionRow {
  lsv_id: string;
  law_id: string;
  law_name: string;
  aliases: string[];
  /** 法规层级与适用地域（laws 表；“全国”或省市名，v9.4 S-08 按事项地域核对地方性法规）。 */
  law_level?: string;
  law_region?: string;
  promulgated: string;
  effective: string;
  superseded: string | null;
  effectiveness: string;
  total_articles: number;
  gazette_issue: string;
  gazette_page: string;
  collected_at: string;
  official_url: string;
  source_license_id: string;
}

export interface SourceRegistryRow {
  source_license_id: string;
  source_type: string;
  licensor: string;
  acquired_via: string;
  contract_ref: string | null;
  valid_until: string | null;
  allowed_actions_json: string;
  region: string;
  firm_limit: string | null;
  concurrency_limit: string | null;
  citation_requirement: string | null;
  deletion_obligation: string | null;
  acquired_at: string;
  reliability: string;
  withdrawn_reason: string | null;
}

export interface RenumberingRow {
  law_id: string;
  from_lsv_id: string;
  to_lsv_id: string;
  topic: string;
  from_article: number;
  to_article: number;
}

/** 名称归一：去书名号《》与全部空白，全角英数字转半角（大小写不敏感）。 */
export function normalizeLawName(name: string): string {
  let s = name.replace(/[《》\s]/g, "");
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  return s.toLowerCase();
}

/** 适用时点取版本：施行 ≤ asOf < 失效（失效为空则现行）。 */
export function versionAt<T extends { effective: string; superseded: string | null }>(rows: T[], asOf: string): T | null {
  for (const r of rows) {
    if (r.effective <= asOf && (r.superseded === null || asOf < r.superseded)) return r;
  }
  return null;
}

export interface LawdbStatus {
  package_version: string;
  built_at: string;
  laws_count: number;
  versions_count: number;
  articles_count: number;
  signer_key_id: string;
  signature_valid: true;
  source_coverage_note: string;
}

export class Lawdb {
  private readonly db: Db;
  private readonly manifest: LawdbManifest;
  private readonly writable: boolean;
  private readonly filePath: string;

  /** 勿直接构造——经 openLawdb（验签 + 哈希校验）获得实例。 */
  constructor(db: Db, manifest: LawdbManifest, writable: boolean, filePath: string) {
    this.db = db;
    this.manifest = manifest;
    this.writable = writable;
    this.filePath = filePath;
  }

  get packageVersion(): string {
    return this.manifest.package_version;
  }

  /** 内容摘要（签名覆盖的对象；判断“内容是否相同”用它，不用不在签名内的版本号）。 */
  get contentSha256(): string {
    return this.manifest.content_sha256;
  }

  /** 节假日表的单独签名验过了（openLawdb 设）；没验过的不交出去。 */
  holidaysVerified = false;

  /** 随包签名的节假日表（每年一份结构化录入；包里没有这张表、或单独签名验不过时为空）。 */
  holidays(): unknown[] {
    if (!this.holidaysVerified || !hasTable(this.db, "holidays")) return [];
    return (this.db.prepare(`SELECT doc FROM holidays ORDER BY year`).all() as { doc: string }[]).flatMap((r) => {
      try {
        return [JSON.parse(r.doc)];
      } catch {
        return [];
      }
    });
  }

  close(): void {
    this.db.close();
  }

  status(): LawdbStatus {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    const laws = count(`SELECT COUNT(*) AS n FROM laws`);
    const versions = count(`SELECT COUNT(*) AS n FROM law_versions`);
    const articles = count(`SELECT COUNT(*) AS n FROM articles`);
    const renumbering = count(`SELECT COUNT(*) AS n FROM renumbering`);
    return {
      package_version: this.manifest.package_version,
      built_at: this.manifest.built_at,
      laws_count: laws,
      versions_count: versions,
      articles_count: articles,
      signer_key_id: this.manifest.signer_key_id,
      signature_valid: true, // 加载即验签，能构造即有效
      // 按实际内容动态生成（增量 apply 后随之正确）：不静态声称覆盖数
      source_coverage_note: `当前包覆盖 ${laws} 部法律法规 / ${versions} 个版本 / 已采集正文 ${articles} 条 / 条号迁移 ${renumbering} 组（G0 演示种子；正文按渐进采集，条号存在 ≠ 正文已采集；首批官方公报人工采集为法律工程任务，商业源未签约不入库）`,
    };
  }

  /** 归一名称 → 版本行（包只读，首次查询时建一次；复核 R15B-16：收录上百部法规后不再每次全表解析别名）。 */
  private nameIndex: Map<string, LawVersionRow[]> | null = null;

  /** 名称归一后按法名/别名匹配全部版本（施行日升序）。 */
  findLawVersions(nameOrAlias: string): LawVersionRow[] {
    const n = normalizeLawName(nameOrAlias);
    if (!n) return [];
    if (!this.nameIndex) {
      const idx = new Map<string, LawVersionRow[]>();
      const rows = this.db
        .prepare(
          `SELECT v.*, l.law_name, l.aliases_json, l.level AS law_level, l.region AS law_region FROM law_versions v JOIN laws l ON l.law_id = v.law_id
            ORDER BY v.effective`,
        )
        .all() as any[];
      for (const r of rows) {
        const aliases: string[] = JSON.parse(r.aliases_json ?? "[]");
        const row = { ...r, aliases } as LawVersionRow;
        for (const key of new Set([normalizeLawName(r.law_name), ...aliases.map((a) => normalizeLawName(a))])) idx.set(key, [...(idx.get(key) ?? []), row]);
      }
      this.nameIndex = idx;
    }
    return (this.nameIndex.get(n) ?? []).map((r) => ({ ...r }));
  }

  /** 注册库内名称检索（法名/别名包含即命中；现行优先）。 */
  searchLaws(query: string): { law_name: string; lsv_id: string; effectiveness: string; effective: string }[] {
    const n = normalizeLawName(query);
    if (!n) return [];
    const rows = this.db.prepare(`SELECT v.lsv_id, v.effectiveness, v.effective, l.law_name, l.aliases_json FROM law_versions v JOIN laws l ON l.law_id = v.law_id`).all() as any[];
    const hits = new Map<string, { law_name: string; lsv_id: string; effectiveness: string; effective: string }>();
    for (const r of rows) {
      const aliases: string[] = JSON.parse(r.aliases_json ?? "[]");
      const names = [r.law_name, ...aliases].map((x) => normalizeLawName(x));
      if (names.some((x) => x.includes(n))) hits.set(r.lsv_id, { law_name: r.law_name, lsv_id: r.lsv_id, effectiveness: r.effectiveness, effective: r.effective });
    }
    return [...hits.values()];
  }

  topicArticle(lsvId: string, topic: string): number | null {
    const r = this.db.prepare(`SELECT article_no FROM article_topics WHERE lsv_id = ? AND topic = ?`).get(lsvId, topic) as { article_no: number } | undefined;
    return r?.article_no ?? null;
  }

  /** 同一法规某主题在其它版本中对应的条号（改引核验的 historical_note 用）。 */
  topicArticleInOtherVersion(lawId: string, excludeLsvId: string, topic: string, articleNo: number): { lsv_id: string; effective: string; effectiveness: string } | null {
    const r = this.db
      .prepare(
        `SELECT v.lsv_id, v.effective, v.effectiveness FROM article_topics t JOIN law_versions v ON v.lsv_id = t.lsv_id
          WHERE v.law_id = ? AND t.lsv_id != ? AND t.topic = ? AND t.article_no = ? LIMIT 1`,
      )
      .get(lawId, excludeLsvId, topic, articleNo) as { lsv_id: string; effective: string; effectiveness: string } | undefined;
    return r ?? null;
  }

  getRenumbering(lawId: string, fromLsvId: string, toLsvId: string, topic?: string): RenumberingRow[] {
    if (topic !== undefined) {
      return this.db.prepare(`SELECT * FROM renumbering WHERE law_id = ? AND from_lsv_id = ? AND to_lsv_id = ? AND topic = ?`).all(lawId, fromLsvId, toLsvId, topic) as RenumberingRow[];
    }
    return this.db.prepare(`SELECT * FROM renumbering WHERE law_id = ? AND from_lsv_id = ? AND to_lsv_id = ?`).all(lawId, fromLsvId, toLsvId) as RenumberingRow[];
  }

  /**
   * 条文正文；未采集返回 null（条号存在性以 total_articles 为准——如实区分「条号存在」与「正文已采集」）。
   * 任何把法条正文送入模型上下文的路径必须先 assertAction(source, 'model')。现有调用面：法律工具 law.get_article
   * （kernel tools/law.ts 的 lawGetArticle，返回正文前先后检查 quote 与 model）；新增路径时同样强制（Source Registry §2.2：不让模型补全未获授权的全文）。
   */
  getArticle(lsvId: string, articleNo: number): string | null {
    const r = this.db.prepare(`SELECT text FROM articles WHERE lsv_id = ? AND article_no = ?`).get(lsvId, articleNo) as { text: string } | undefined;
    return r?.text ?? null;
  }

  getSource(sourceLicenseId: string): SourceRegistryRow | null {
    return (this.db.prepare(`SELECT * FROM source_registry WHERE source_license_id = ?`).get(sourceLicenseId) as SourceRegistryRow | undefined) ?? null;
  }

  /** 版本 → 来源（导出/展示动作校验用）。 */
  sourceOfVersion(lsvId: string): string | null {
    const r = this.db.prepare(`SELECT source_license_id FROM law_versions WHERE lsv_id = ?`).get(lsvId) as { source_license_id: string } | undefined;
    return r?.source_license_id ?? null;
  }

  /** 引用核验等路径取来源许可说明（citation_requirement 或类型/可靠性描述）。 */
  licenseNoteOf(sourceLicenseId: string): string {
    const s = this.getSource(sourceLicenseId);
    if (!s) return `来源 ${sourceLicenseId} 未登记`;
    return s.citation_requirement ?? `${s.source_type}（${s.licensor || s.acquired_via || "渠道未登记"}；reliability=${s.reliability || "未标注"}）`;
  }

  /**
   * Source Registry 运行时强制（§2.2）：allowed_actions 含 action 且（valid_until 为空或未过）；
   * 不足抛 source_action_denied（403），说明哪个来源哪个动作——权限不足时停止相应动作。
   */
  assertAction(sourceLicenseId: string, action: string, asOf: string = new Date().toISOString().slice(0, 10)): void {
    const s = this.getSource(sourceLicenseId);
    if (!s) {
      throw new DomainError("source_action_denied", `来源 ${sourceLicenseId} 未在 Source Registry 登记，动作 ${action} 被拒绝（未登记即无授权）`, 403);
    }
    let actions: string[] = [];
    try {
      actions = JSON.parse(s.allowed_actions_json) as string[];
    } catch {
      actions = [];
    }
    if (!actions.includes(action)) {
      throw new DomainError("source_action_denied", `来源 ${sourceLicenseId}（${s.source_type}）未授权动作「${action}」（许可动作：${actions.join("/") || "无"}），已停止相应动作`, 403, {
        source_license_id: sourceLicenseId,
        action,
        allowed_actions: actions,
      });
    }
    if (s.valid_until && s.valid_until < asOf) {
      throw new DomainError("source_action_denied", `来源 ${sourceLicenseId}（${s.source_type}）许可已于 ${s.valid_until} 到期，动作「${action}」被拒绝`, 403, {
        source_license_id: sourceLicenseId,
        action,
        valid_until: s.valid_until,
      });
    }
  }

  /**
   * 应用签名增量包（只读库拒绝——apply 作用于可写副本；更新流程：复制包文件对 →
   * openLawdb(writable) → applyIncremental → close → 原子替换原文件对）。
   * 事务内 upsert 后重算全量 hash，与增量 manifest 声明的合并后 hash 不符即回滚。
   */
  applyIncremental(incrFile: string, opts: { expectedSignerPubPem: string; manifestPath?: string }): { from_version: string; to_version: string } {
    if (!this.writable) throw new DomainError("lawdb_invalid", "只读法规库不可 apply 增量（须作用于可写副本）", 422);
    const manifest = readManifest(opts.manifestPath ?? manifestPathFor(incrFile));
    if (manifest.kind !== "incremental") throw new DomainError("lawdb_invalid", "增量包 manifest.kind 须为 incremental", 422);
    if (manifest.signer_key_id !== signerKeyId(opts.expectedSignerPubPem) || !verifyBytes(opts.expectedSignerPubPem, new TextEncoder().encode(manifest.content_sha256), manifest.signature)) {
      throw new DomainError("lawdb_invalid", "增量包签名验签失败，拒绝应用", 422);
    }
    const current = this.manifest.package_version;
    if (manifest.base_version !== current) {
      throw new DomainError("conflict", `增量包 base_version（${manifest.base_version}）与当前包版本（${current}）不符，拒绝应用（须先应用缺失的增量）`, 409);
    }
    const incr = new Database(incrFile, { readonly: true });
    try {
      this.db.transaction(() => {
        // 节假日表不随增量包更新（只随全量包；复核 Q3-02）：增量合并后保留底包的表与单独签名
        for (const t of CONTENT_TABLES) {
          const rows = incr.prepare(`SELECT * FROM ${t.name}`).all() as Record<string, unknown>[];
          for (const row of rows) {
            const cols = Object.keys(row);
            this.db.prepare(`INSERT OR REPLACE INTO ${t.name} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]));
          }
        }
        this.db.prepare(`INSERT OR REPLACE INTO package_meta (key, value) VALUES ('package_version', ?), ('built_at', ?)`).run(manifest.package_version, manifest.built_at);
        const after = computeContentSha256(this.db);
        if (after !== manifest.content_sha256) {
          throw new DomainError("lawdb_invalid", "增量应用后内容哈希与增量 manifest 不符（包内容与声明的合并结果不一致），已回滚", 422);
        }
        this.manifest.package_version = manifest.package_version;
        this.manifest.built_at = manifest.built_at;
        this.manifest.content_sha256 = manifest.content_sha256;
        this.manifest.signature = manifest.signature;
        // 签名与指纹必须成对来自同一份清单（复核 S8A-03：内容签名公钥轮换后，旧钥底包 + 新钥增量合并的 sidecar 曾留着旧指纹，之后永远验不过）
        this.manifest.signer_key_id = manifest.signer_key_id;
      })();
      // 文件对保持一致：sidecar manifest 更新为增量声明（合并后版本），供「校验→原子替换」
      writeFileSync(manifestPathFor(this.filePath), JSON.stringify(this.manifest, null, 2) + "\n");
    } finally {
      incr.close();
    }
    return { from_version: current, to_version: manifest.package_version };
  }
}

export interface OpenLawdbOptions {
  expectedSignerPubPem: string;
  /** manifest 路径（默认 <包名>.manifest.json 同目录 sidecar）。 */
  manifestPath?: string;
  /** 可写打开（仅更新流程的可写副本用；运行时为只读）。 */
  writable?: boolean;
  /** 允许加载测试夹具（只供测试；缺省拒绝）。 */
  allowTestFixture?: boolean;
}

/** 打开并验签法规库包；任何失败抛 lawdb_invalid（不静默降级到任何种子）。 */
export function openLawdb(file: string, opts: OpenLawdbOptions): Lawdb {
  let db: Db;
  try {
    db = new Database(file, opts.writable ? {} : { readonly: true });
  } catch (e) {
    throw new DomainError("lawdb_invalid", `法规库包无法打开（${file}）：${(e as Error)?.message ?? e}。请先运行 npm run build:lawdb 构建法规库包`, 422);
  }
  const manifest = readManifest(opts.manifestPath ?? manifestPathFor(file));
  if (manifest.kind !== "full") {
    db.close();
    throw new DomainError("lawdb_invalid", `法规库包 manifest.kind 须为 full（增量包请走 applyIncremental）`, 422);
  }
  if (manifest.purpose !== undefined && !(manifest.purpose === "test_fixture" && opts.allowTestFixture === true)) {
    db.close();
    throw new DomainError("lawdb_invalid", "这是测试用的法规库夹具（含虚构条文），不能作为正式法规库加载", 422);
  }
  try {
    verifyAgainstManifest(db, manifest, opts.expectedSignerPubPem);
  } catch (e) {
    db.close();
    throw e;
  }
  const l = new Lawdb(db, manifest, opts.writable === true, file);
  // 节假日表单独验签（复核 Q3-02）：验不过只是不用这张表
  const hs = computeHolidaysSha256(db);
  l.holidaysVerified =
    hs !== null &&
    manifest.holidays_sha256 === hs &&
    typeof manifest.holidays_signature === "string" &&
    verifyBytes(opts.expectedSignerPubPem, new TextEncoder().encode(`${hs}\nholidays`), manifest.holidays_signature);
  return l;
}
