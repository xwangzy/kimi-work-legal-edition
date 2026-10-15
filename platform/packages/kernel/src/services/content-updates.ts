/**
 * 在线内容更新（v9.2 §5.1 S6 法规库签名增量包、S7 方法模板分发；Y2 §3.6–3.7）。
 *
 * 内核不联网：通道清单与包经出站闸门的分发通道代取（egress-gate/dist-relay.ts，地址随客户端构建固定、席位令牌由闸门附上）。
 * 本机核验三层，任何一层不过都不落位、不切换：
 *   ① 通道清单签名（内容签名公钥表：随包公钥 + release.json 的 content_keys）、类别与通道相符、未过期；
 *   ② 每个下载文件的大小与摘要等于清单所列；
 *   ③ 包自身的签名与内容摘要（法规库 sidecar 清单 / 方法模板清单），且应用后的内容摘要与版本等于通道清单所写。
 * 先后与防回退：只认通道清单的 seq（包自带版本号不可比较）；本机账本记已装 seq 与见过的最高通道 seq（迁移 0029）。
 * 落位：先写 <工作区>/content/<类别>/<seq>.stage-…，核验通过后改名为 <seq>/，再在同一事务里登记、切换 active 并写签名审计。
 * 法规库即时换用（LawdbHolder）；方法模板包在下次打开时生效（Agent 宿主的可信区随宿主启动固定）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  contentKeyId,
  fileMatches,
  inRollout,
  parseSkillsPack,
  planInstall,
  verifyChannelManifest,
  type ChannelManifest,
  type ContentKind,
  type DistChannel,
  type DistPackage,
} from "@zr-legal/content-dist";
import { openLawdb, type Lawdb } from "@zr-legal/lawdb";
import type { DistRelayResult } from "@zr-legal/egress-gate";
import type { KernelDb } from "../db.ts";
import { verifySkillsSource } from "../skills-bundle.ts";

export type ContentSource = "bundled" | "installed";

export interface ActiveContent {
  source: ContentSource;
  seq: number;
  version: string;
  /** 法规库文件 / 方法模板清单文件。 */
  file: string;
}

/** 内容签名公钥表：kid 一律由公钥算出（不信任外部给的名字）。 */
export function contentKeyTable(pems: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const pem of pems) if (typeof pem === "string" && /-----BEGIN PUBLIC KEY-----/.test(pem) && !/PRIVATE/.test(pem)) out.set(contentKeyId(pem), pem);
  return out;
}

/** ZR_CONTENT_KEYS：公钥 PEM 的 JSON 数组（release.json 的 content_keys 经主进程写入）；解析失败按空表。 */
export function contentKeysFromEnv(v: string | undefined): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const sidecarOf = (file: string): string => `${file.slice(0, -".sqlite".length)}.manifest.json`;

/**
 * 随包内容的 seq：同目录 <kind>.release.json（与通道清单同格式的签名信封，不看有效期）所写的 seq，
 * 且信封里的内容摘要必须等于随包内容的摘要；没有或不符按 0（任何在线安装都比它新）。
 */
export function bundledSeq(kind: ContentKind, releaseFile: string | null, contentSha256: string | null, keys: ReadonlyMap<string, string>): number {
  if (!releaseFile || !contentSha256 || !existsSync(releaseFile)) return 0;
  const v = verifyChannelManifest(readJson(releaseFile), keys, { kind, ignoreExpiry: true });
  return v.ok && v.manifest.content_sha256 === contentSha256 ? v.manifest.seq : 0;
}

export function installedDir(workspaceDir: string, kind: ContentKind, channel: DistChannel, seq: number): string {
  return join(workspaceDir, "content", kind, `${channel}-${seq}`);
}

interface InstallRow {
  kind: string;
  channel: string;
  seq: number;
  version: string;
  content_sha256: string;
  installed_at: string;
  active: number;
  revoked_at: string | null;
  problem: string | null;
}

function activeRow(db: KernelDb, kind: ContentKind, channel: DistChannel): InstallRow | null {
  return db.get<InstallRow>(`SELECT * FROM content_installs WHERE kind = ? AND channel = ? AND active = 1 AND revoked_at IS NULL AND problem IS NULL ORDER BY seq DESC LIMIT 1`, [kind, channel]) ?? null;
}

function markProblem(db: KernelDb, kind: ContentKind, channel: DistChannel, seq: number, problem: string): void {
  db.run(`UPDATE content_installs SET active = 0, problem = ? WHERE kind = ? AND channel = ? AND seq = ?`, [problem.slice(0, 120), kind, channel, seq]);
}

/** 法规库包按其 sidecar 清单的 signer_key_id 取公钥打开（只读、验签与内容摘要）。 */
export function openLawdbWithKeys(file: string, keys: ReadonlyMap<string, string>, o: { writable?: boolean } = {}): Lawdb {
  const kid = String(readJson(sidecarOf(file))?.signer_key_id ?? "");
  const pem = keys.get(kid) ?? [...keys.values()][0] ?? "";
  return openLawdb(file, { expectedSignerPubPem: pem, ...(o.writable ? { writable: true } : {}) });
}

/**
 * 启动时选用法规库：已装（账本 active 行）的 seq 高于随包 seq 且本机核验通过才用；核验失败的已装副本标记问题、回到随包。
 */
export function selectLawdb(o: { db: KernelDb; workspaceDir: string; channel: DistChannel; keys: ReadonlyMap<string, string>; bundledFile: string; bundledReleaseFile: string | null }): { active: ActiveContent; bundled: ActiveContent } {
  const bundledSha = readJson(sidecarOf(o.bundledFile))?.content_sha256 ?? null;
  const bseq = bundledSeq("lawdb", o.bundledReleaseFile, bundledSha, o.keys);
  const bundled: ActiveContent = { source: "bundled", seq: bseq, version: String(readJson(sidecarOf(o.bundledFile))?.package_version ?? ""), file: o.bundledFile };
  const row = activeRow(o.db, "lawdb", o.channel);
  if (!row || row.seq <= bseq) return { active: bundled, bundled };
  const file = join(installedDir(o.workspaceDir, "lawdb", o.channel, row.seq), "lawdb.sqlite");
  try {
    const l = openLawdbWithKeys(file, o.keys);
    const ok = readJson(sidecarOf(file))?.content_sha256 === row.content_sha256 && l.packageVersion === row.version;
    l.close();
    if (!ok) throw new Error("content_mismatch");
    return { active: { source: "installed", seq: row.seq, version: row.version, file }, bundled };
  } catch {
    markProblem(o.db, "lawdb", o.channel, row.seq, "本机核验失败（文件缺失或被改动）");
    return { active: bundled, bundled };
  }
}

/** 启动时选用方法模板包：规则同法规库。 */
export function selectSkills(o: { db: KernelDb; workspaceDir: string; channel: DistChannel; keys: ReadonlyMap<string, string>; bundledManifest: string | null; bundledReleaseFile: string | null }): { active: ActiveContent | null; bundled: ActiveContent | null } {
  const bm = o.bundledManifest ? readJson(o.bundledManifest) : null;
  const bseq = bundledSeq("skills", o.bundledReleaseFile, bm?.content_sha256 ?? null, o.keys);
  const bundled: ActiveContent | null = o.bundledManifest ? { source: "bundled", seq: bseq, version: String(bm?.content_sha256 ?? "").slice(0, 16), file: o.bundledManifest } : null;
  const row = activeRow(o.db, "skills", o.channel);
  if (!row || row.seq <= bseq) return { active: bundled, bundled };
  const file = join(installedDir(o.workspaceDir, "skills", o.channel, row.seq), "skills.manifest.json");
  const v = verifySkillsSource(file, o.keys);
  if (v.ok && v.contentSha256 === row.content_sha256) return { active: { source: "installed", seq: row.seq, version: row.version, file }, bundled };
  markProblem(o.db, "skills", o.channel, row.seq, "本机核验失败（文件缺失或被改动）");
  return { active: bundled, bundled };
}

/** 法规库持有者：内核各处拿到的是同一个代理，换用时只换内部实例（调用都是同步的，换用与关闭旧实例之间不会有查询在途）。 */
export class LawdbHolder {
  private cur: Lawdb;
  readonly proxy: Lawdb;
  constructor(initial: Lawdb) {
    this.cur = initial;
    const self = this;
    this.proxy = new Proxy({} as Lawdb, {
      get(_t, k) {
        const c = self.cur as any;
        const v = c[k];
        return typeof v === "function" ? v.bind(c) : v;
      },
    });
  }
  get current(): Lawdb {
    return this.cur;
  }
  swap(next: Lawdb): void {
    const old = this.cur;
    this.cur = next;
    old.close();
  }
}

export type CheckOutcome =
  | "up_to_date"
  | "installed"
  | "staged_rollout"
  | "not_configured"
  | "unreachable"
  | "rejected"
  | "rollback_ignored"
  | "reverted";

export interface CheckResult {
  kind: ContentKind;
  outcome: CheckOutcome;
  /** 机器原因代码（不含内容）。 */
  reason?: string;
  seq?: number;
  version?: string;
  at: string;
  /** 方法模板包：下次打开 Kimi Work 时生效。 */
  restart_required?: boolean;
}

export interface ContentUpdaterDeps {
  db: KernelDb;
  workspaceDir: string;
  channel: DistChannel;
  keys: ReadonlyMap<string, string>;
  deviceId: string;
  /** 闸门分发通道。 */
  fetch: (path: string) => Promise<DistRelayResult>;
  configured: () => boolean;
  lawdb: LawdbHolder;
  /** 启动时选定的内容（检查时据此判断当前 seq 与版本）。 */
  active: { lawdb: ActiveContent; skills: ActiveContent | null };
  /** 随包内容（撤回已装版本时回退到它）。 */
  bundled: { lawdb: ActiveContent; skills: ActiveContent | null };
  audit: (action: string, objectId: string) => void;
  now?: () => number;
}

class Reject extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class ContentUpdater {
  private readonly last = new Map<ContentKind, CheckResult>();
  private readonly inflight = new Map<ContentKind, Promise<CheckResult>>();
  /** 已装好、下次打开才生效的方法模板 seq。 */
  private skillsPending: ActiveContent | null = null;

  private readonly d: ContentUpdaterDeps;

  constructor(d: ContentUpdaterDeps) {
    this.d = d;
  }

  status(): {
    configured: boolean;
    channel: DistChannel;
    lawdb: { source: ContentSource; seq: number; version: string; last_check: CheckResult | null };
    skills: { source: ContentSource | null; seq: number; version: string | null; pending: { seq: number; version: string } | null; last_check: CheckResult | null };
  } {
    const s = this.d.active.skills;
    return {
      configured: this.d.configured(),
      channel: this.d.channel,
      lawdb: { source: this.d.active.lawdb.source, seq: this.d.active.lawdb.seq, version: this.d.lawdb.current.packageVersion, last_check: this.last.get("lawdb") ?? null },
      skills: {
        source: s?.source ?? null,
        seq: s?.seq ?? 0,
        version: s?.version ?? null,
        pending: this.skillsPending ? { seq: this.skillsPending.seq, version: this.skillsPending.version } : null,
        last_check: this.last.get("skills") ?? null,
      },
    };
  }

  /** 检查并安装（每个类别单飞；不抛异常，结果写进状态）。 */
  check(kind: ContentKind): Promise<CheckResult> {
    const running = this.inflight.get(kind);
    if (running) return running;
    const p = this.run(kind)
      .catch((e): CheckResult => ({ kind, outcome: e instanceof Reject ? "rejected" : "unreachable", reason: e instanceof Reject ? e.code : "internal", at: this.iso() }))
      .then((r) => {
        this.last.set(kind, r);
        this.inflight.delete(kind);
        return r;
      });
    this.inflight.set(kind, p);
    return p;
  }

  private iso(): string {
    return new Date((this.d.now ?? Date.now)()).toISOString();
  }

  private async get(path: string): Promise<Uint8Array> {
    const r = await this.d.fetch(path);
    if (!r.ok) throw r.reason === "dist_not_configured" ? new Reject("not_configured") : Object.assign(new Error(r.reason), { unreachable: r.reason });
    if (r.status !== 200) throw Object.assign(new Error(`http_${r.status}`), { unreachable: `http_${r.status}` });
    return new Uint8Array(Buffer.from(r.body_b64, "base64"));
  }

  private current(kind: ContentKind): { seq: number; version: string | null } {
    if (kind === "lawdb") return { seq: this.d.active.lawdb.seq, version: this.d.lawdb.current.packageVersion };
    const s = this.skillsPending ?? this.d.active.skills;
    return { seq: s?.seq ?? 0, version: s?.version ?? null };
  }

  private async run(kind: ContentKind): Promise<CheckResult> {
    const at = this.iso();
    const { db, channel } = this.d;
    if (!this.d.configured()) return { kind, outcome: "not_configured", at };
    let raw: Uint8Array;
    try {
      raw = await this.get(`/dist/${kind}/${channel}/latest.json`);
    } catch (e) {
      if (e instanceof Reject) return { kind, outcome: "not_configured", at };
      // 本通道还没有发布过这一类内容：不是连不上
      if ((e as any)?.unreachable === "http_404") return { kind, outcome: "up_to_date", reason: "not_published", seq: this.current(kind).seq, at };
      return { kind, outcome: "unreachable", reason: String((e as any)?.unreachable ?? "unreachable"), at };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return { kind, outcome: "rejected", reason: "manifest_json", at };
    }
    const v = verifyChannelManifest(parsed, this.d.keys, { kind, channel, now: (this.d.now ?? Date.now)() });
    if (!v.ok) return { kind, outcome: "rejected", reason: `manifest_${v.reason}`, at };
    const m = v.manifest;
    // 通道清单回退（低于见过的最高 seq）：不采用
    const hw = db.get<{ seq: number }>(`SELECT seq FROM content_channel_hw WHERE kind = ? AND channel = ?`, [kind, channel])?.seq ?? 0;
    if (m.seq < hw) return { kind, outcome: "rollback_ignored", reason: "manifest_seq_below_seen", seq: m.seq, at };
    db.run(`INSERT INTO content_channel_hw (kind, channel, seq, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, channel) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`, [kind, channel, m.seq, at]);

    const cur = this.current(kind);
    // 撤回：当前在用的已装版本被列入 revoked_seqs → 标记撤回；清单有更新的就装新的，否则回到随包内容
    if (cur.seq > 0 && m.revoked_seqs.includes(cur.seq) && this.activeSource(kind) === "installed") {
      db.run(`UPDATE content_installs SET active = 0, revoked_at = ? WHERE kind = ? AND channel = ? AND seq = ?`, [at, kind, channel, cur.seq]);
      this.d.audit("content.revoked", `${kind}:${channel}:${cur.seq}`);
      if (m.seq <= cur.seq || !inRollout(m, this.d.deviceId)) return this.revertToBundled(kind, at);
      // 撤回后从随包版本开始重新规划（增量链以随包版本为起点）
      if (kind === "lawdb") this.revertLawdb();
      else this.skillsPending = null;
    }
    const now = this.current(kind);
    if (m.seq <= now.seq) return { kind, outcome: "up_to_date", seq: now.seq, at };
    if (!inRollout(m, this.d.deviceId)) return { kind, outcome: "staged_rollout", seq: m.seq, at };
    // 内容相同（只是通道 seq 更高，例如随包内容未带信封）：无需安装
    if (now.version === m.version) return { kind, outcome: "up_to_date", seq: now.seq, at };
    const plan = planInstall(m, now.version);
    if (!plan) return { kind, outcome: "rejected", reason: "no_applicable_package", seq: m.seq, at };
    const files = new Map<string, Uint8Array>();
    try {
      for (const p of plan.packages) {
        for (const [name, size, sha] of [[p.file, p.size, p.sha256], ...(p.manifest_file ? [[p.manifest_file, p.manifest_size!, p.manifest_sha256!]] : [])] as [string, number, string][]) {
          const bytes = await this.get(`/dist/${kind}/${channel}/files/${name}`);
          if (!fileMatches(bytes, size, sha)) throw new Reject("file_digest_mismatch");
          files.set(name, bytes);
        }
      }
    } catch (e) {
      if (e instanceof Reject) return { kind, outcome: "rejected", reason: e.code, seq: m.seq, at };
      return { kind, outcome: "unreachable", reason: String((e as any)?.unreachable ?? "unreachable"), seq: m.seq, at };
    }
    const dest = installedDir(this.d.workspaceDir, kind, channel, m.seq);
    const stage = `${dest}.stage-${randomBytes(6).toString("hex")}`;
    try {
      mkdirSync(stage, { recursive: true });
      if (kind === "lawdb") this.stageLawdb(stage, m, plan.packages, files);
      else this.stageSkills(stage, m, plan.packages[0]!, files);
      rmSync(dest, { recursive: true, force: true });
      renameSync(stage, dest);
    } catch (e) {
      rmSync(stage, { recursive: true, force: true });
      return { kind, outcome: "rejected", reason: e instanceof Reject ? e.code : "stage_failed", seq: m.seq, at };
    }
    // 登记与切换（同一事务；签名审计在 audit 内与事件同事务）
    db.tx(() => {
      db.run(`UPDATE content_installs SET active = 0 WHERE kind = ? AND channel = ?`, [kind, channel]);
      db.run(
        `INSERT INTO content_installs (kind, channel, seq, version, content_sha256, installed_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (kind, channel, seq) DO UPDATE SET version = excluded.version, content_sha256 = excluded.content_sha256, installed_at = excluded.installed_at, active = 1, revoked_at = NULL, problem = NULL`,
        [kind, channel, m.seq, m.version, m.content_sha256, at],
      );
      this.d.audit("content.installed", `${kind}:${channel}:${m.seq}`);
    });
    const installed: ActiveContent = { source: "installed", seq: m.seq, version: m.version, file: kind === "lawdb" ? join(dest, "lawdb.sqlite") : join(dest, "skills.manifest.json") };
    if (kind === "lawdb") {
      this.d.lawdb.swap(openLawdbWithKeys(installed.file, this.d.keys));
      this.d.active.lawdb = installed;
      this.d.audit("lawdb.load", m.version);
    } else {
      this.skillsPending = installed;
    }
    this.prune(kind, m.seq);
    return { kind, outcome: "installed", seq: m.seq, version: m.version, at, ...(kind === "skills" ? { restart_required: true } : {}) };
  }

  private activeSource(kind: ContentKind): ContentSource | null {
    if (kind === "lawdb") return this.d.active.lawdb.source;
    return (this.skillsPending ?? this.d.active.skills)?.source ?? null;
  }

  private revertLawdb(): void {
    if (this.d.active.lawdb.source !== "installed") return;
    this.d.lawdb.swap(openLawdbWithKeys(this.d.bundled.lawdb.file, this.d.keys));
    this.d.active.lawdb = this.d.bundled.lawdb;
    this.d.audit("lawdb.load", this.d.lawdb.current.packageVersion);
  }

  private revertToBundled(kind: ContentKind, at: string): CheckResult {
    if (kind === "lawdb") {
      this.revertLawdb();
      return { kind, outcome: "reverted", seq: this.d.bundled.lawdb.seq, at };
    }
    this.skillsPending = null;
    return { kind, outcome: "reverted", seq: this.d.bundled.skills?.seq ?? 0, at, restart_required: true };
  }

  /** 法规库落位：全量包直接核验；增量链从当前在用的包复制出可写副本逐个应用，最后按通道清单核对摘要与版本。 */
  private stageLawdb(stage: string, m: ChannelManifest, pkgs: DistPackage[], files: Map<string, Uint8Array>): void {
    const target = join(stage, "lawdb.sqlite");
    if (pkgs[0]!.type === "full") {
      writeFileSync(target, files.get(pkgs[0]!.file)!);
      writeFileSync(sidecarOf(target), files.get(pkgs[0]!.manifest_file!)!);
    } else {
      const srcFile = this.d.active.lawdb.file;
      copyFileSync(srcFile, target);
      copyFileSync(sidecarOf(srcFile), sidecarOf(target));
      let w: Lawdb;
      try {
        w = openLawdbWithKeys(target, this.d.keys, { writable: true });
      } catch {
        throw new Reject("base_invalid");
      }
      try {
        pkgs.forEach((p, i) => {
          const f = join(stage, `incr-${i}.sqlite`);
          writeFileSync(f, files.get(p.file)!);
          writeFileSync(sidecarOf(f), files.get(p.manifest_file!)!);
          const kid = String(readJson(sidecarOf(f))?.signer_key_id ?? "");
          const pem = this.d.keys.get(kid);
          if (!pem) throw new Reject("package_unknown_key");
          try {
            w.applyIncremental(f, { expectedSignerPubPem: pem });
          } catch (e) {
            throw new Reject((e as any)?.code === "conflict" ? "incremental_base_mismatch" : "incremental_invalid");
          }
        });
      } finally {
        w.close();
      }
      for (const n of readdirSync(stage)) if (n.startsWith("incr-")) rmSync(join(stage, n), { force: true });
      // SQLite 可能留下 -wal/-shm：只保留包文件对
      for (const n of readdirSync(stage)) if (n !== "lawdb.sqlite" && n !== "lawdb.manifest.json") rmSync(join(stage, n), { force: true });
    }
    let l: Lawdb;
    try {
      l = openLawdbWithKeys(target, this.d.keys);
    } catch {
      throw new Reject("package_invalid");
    }
    const ok = l.packageVersion === m.version && readJson(sidecarOf(target))?.content_sha256 === m.content_sha256;
    l.close();
    if (!ok) throw new Reject("content_mismatch");
  }

  /** 方法模板包落位：拆包写文件后按 skills 清单的规则整包核验（签名、逐文件摘要、清单外文件），再核对通道清单所写摘要。 */
  private stageSkills(stage: string, m: ChannelManifest, pkg: DistPackage, files: Map<string, Uint8Array>): void {
    const parsed = parseSkillsPack(files.get(pkg.file)!);
    if (!parsed.ok) throw new Reject(parsed.reason);
    writeFileSync(join(stage, "skills.manifest.json"), parsed.pack.manifest);
    const root = join(stage, "trusted");
    for (const f of parsed.pack.files) {
      const to = join(root, ...f.path.split("/"));
      if (!to.startsWith(root)) throw new Reject("pack_path");
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, Buffer.from(f.data, "base64"));
    }
    const v = verifySkillsSource(join(stage, "skills.manifest.json"), this.d.keys);
    if (!v.ok) throw new Reject("package_invalid");
    if (v.contentSha256 !== m.content_sha256) throw new Reject("content_mismatch");
  }

  /** 只保留在用的与上一个已装版本（回退备用），其余目录删除；账本行保留（防回退依据）。 */
  private prune(kind: ContentKind, keepSeq: number): void {
    const base = join(this.d.workspaceDir, "content", kind);
    const rows = this.d.db.all<{ seq: number }>(`SELECT seq FROM content_installs WHERE kind = ? AND channel = ? AND problem IS NULL AND revoked_at IS NULL ORDER BY seq DESC LIMIT 2`, [kind, this.d.channel]);
    const keep = new Set([keepSeq, ...rows.map((r) => r.seq)].map((s) => `${this.d.channel}-${s}`));
    try {
      for (const n of readdirSync(base)) if (!keep.has(n)) rmSync(join(base, n), { recursive: true, force: true });
    } catch {
      // 目录不存在或删不掉：下次再清
    }
  }
}
