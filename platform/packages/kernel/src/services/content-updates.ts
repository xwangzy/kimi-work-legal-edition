/**
 * 在线内容更新（v9.2 §5.1 S6 法规库签名增量包、S7 方法模板分发；Y2 §3.6–3.7）。
 *
 * 内核不联网：通道清单与包经出站闸门的分发通道代取（egress-gate/dist-relay.ts，地址随客户端构建固定、席位令牌由闸门附上）。
 * 本机核验三层，任何一层不过都不落位、不切换：
 *   ① 通道清单签名（内容签名公钥表：随包公钥 + release.json 的 content_keys，减去停用的 kid）、类别与通道相符、未过期；
 *   ② 每个下载文件的大小与摘要等于清单所列；
 *   ③ 包自身的签名与内容摘要（法规库 sidecar 清单 / 方法模板清单），且应用后的内容摘要与版本等于通道清单所写。
 * 先后与防回退：只认通道清单的 seq（包自带版本号不可比较）；本机账本记已装 seq、见过的最高通道 seq 及该 seq 的内容摘要
 * （迁移 0029、0030）——同一 seq 给出不同内容一律拒绝（复核 S8A-04）。随包内容的 seq 由同目录签名信封给出，信封通道须等于本机通道（S8A-01）。
 * 落位：先写 <工作区>/content/<类别>/<通道>-<seq>.stage-…，核验通过后改名，再在同一事务里登记、切换 active 并写签名审计；撤回同样在事务内（S8A-07）。
 * 法规库换用（LawdbHolder）：没有任务在运行时即时换用；有任务时等任务都结束再换（S8A-10：成果清单记录的法规库版本须与核验所用一致）。
 * 方法模板包在下次打开时生效（Agent 宿主的可信区随宿主启动固定，D-76）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import {
  contentKeyId,
  fileMatches,
  inRollout,
  parseSkillsPack,
  planInstall,
  skillsVersionOf,
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
  /** 应用后的内容摘要（判断“内容是否相同”只看它，复核 S8A-09）。 */
  contentSha256: string;
  /** 法规库文件 / 方法模板清单文件。 */
  file: string;
}

/** 内容签名公钥表：kid 一律由公钥算出（不信任外部给的名字）；停用的 kid 不进表（复核 S8A-18）。 */
export function contentKeyTable(pems: readonly string[], revokedKids: readonly string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const pem of pems) {
    if (typeof pem !== "string" || !/-----BEGIN PUBLIC KEY-----/.test(pem) || /PRIVATE/.test(pem)) continue;
    const kid = contentKeyId(pem);
    if (!revokedKids.includes(kid)) out.set(kid, pem);
  }
  return out;
}

/** ZR_CONTENT_KEYS / ZR_CONTENT_KEYS_REVOKED：字符串的 JSON 数组（release.json 经主进程写入）；解析失败按空表。 */
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
 * 随包内容的 seq：同目录 <kind>.release.json（与通道清单同格式的签名信封，不看有效期）所写的 seq；
 * 信封通道须等于本机通道、内容摘要须等于随包内容的摘要，否则按 0（任何在线安装都比它新）。
 */
export function bundledSeq(kind: ContentKind, channel: DistChannel, releaseFile: string | null, contentSha256: string | null, keys: ReadonlyMap<string, string>): number {
  if (!releaseFile || !contentSha256 || !existsSync(releaseFile)) return 0;
  const v = verifyChannelManifest(readJson(releaseFile), keys, { kind, channel, ignoreExpiry: true });
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

export function markProblem(db: KernelDb, kind: ContentKind, channel: DistChannel, seq: number, problem: string): void {
  db.run(`UPDATE content_installs SET active = 0, problem = ? WHERE kind = ? AND channel = ? AND seq = ?`, [problem.slice(0, 120), kind, channel, seq]);
}

/** 法规库包按其 sidecar 清单的 signer_key_id 取公钥打开（只读、验签与内容摘要）。 */
export function openLawdbWithKeys(file: string, keys: ReadonlyMap<string, string>, o: { writable?: boolean } = {}): Lawdb {
  const kid = String(readJson(sidecarOf(file))?.signer_key_id ?? "");
  const pem = keys.get(kid) ?? [...keys.values()][0] ?? "";
  return openLawdb(file, { expectedSignerPubPem: pem, ...(o.writable ? { writable: true } : {}) });
}

/** 有限次退避重试（复核 S8A-12：Windows 上杀软与索引服务常短暂占用新写的文件，改名与删除偶发 EPERM/EBUSY）。 */
function retrySync(fn: () => void, attempts = 5): void {
  for (let i = 1; ; i++) {
    try {
      fn();
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (i >= attempts || !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(String(code))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * i);
    }
  }
}

/**
 * 启动时选用并打开法规库（复核 S8A-11：只核验一次，直接返回已打开实例）：已装（账本 active 行）seq 高于随包 seq 且本机核验通过才用；
 * 核验失败的已装副本标记问题、回到随包。随包也打不开时抛出（与原先“验签不符即拒绝加载”一致）。
 */
export function selectLawdb(o: { db: KernelDb; workspaceDir: string; channel: DistChannel; keys: ReadonlyMap<string, string>; bundledFile: string; bundledReleaseFile: string | null }): {
  active: ActiveContent;
  bundled: ActiveContent;
  lawdb: Lawdb;
  bundledStamped: boolean;
} {
  const bm = readJson(sidecarOf(o.bundledFile));
  const bseq = bundledSeq("lawdb", o.channel, o.bundledReleaseFile, bm?.content_sha256 ?? null, o.keys);
  const bundled: ActiveContent = { source: "bundled", seq: bseq, version: String(bm?.package_version ?? ""), contentSha256: String(bm?.content_sha256 ?? ""), file: o.bundledFile };
  const row = activeRow(o.db, "lawdb", o.channel);
  if (row && row.seq > bseq) {
    const file = join(installedDir(o.workspaceDir, "lawdb", o.channel, row.seq), "lawdb.sqlite");
    try {
      const l = openLawdbWithKeys(file, o.keys);
      if (l.contentSha256 === row.content_sha256 && l.packageVersion === row.version) {
        return { active: { source: "installed", seq: row.seq, version: row.version, contentSha256: row.content_sha256, file }, bundled, lawdb: l, bundledStamped: bseq > 0 };
      }
      l.close();
    } catch {
      // 落到下面：标记问题、回到随包
    }
    markProblem(o.db, "lawdb", o.channel, row.seq, "本机核验失败（文件缺失或被改动）");
  }
  return { active: bundled, bundled, lawdb: openLawdbWithKeys(o.bundledFile, o.keys), bundledStamped: bseq > 0 };
}

/** 启动时选用方法模板包：规则同法规库（物化失败的回退在内核入口，复核 S8A-08）。 */
export function selectSkills(o: { db: KernelDb; workspaceDir: string; channel: DistChannel; keys: ReadonlyMap<string, string>; bundledManifest: string | null; bundledReleaseFile: string | null }): {
  active: ActiveContent | null;
  bundled: ActiveContent | null;
  bundledStamped: boolean;
} {
  const bm = o.bundledManifest ? readJson(o.bundledManifest) : null;
  const bsha = String(bm?.content_sha256 ?? "");
  const bseq = bundledSeq("skills", o.channel, o.bundledReleaseFile, bsha || null, o.keys);
  const bundled: ActiveContent | null = o.bundledManifest ? { source: "bundled", seq: bseq, version: skillsVersionOf(bsha), contentSha256: bsha, file: o.bundledManifest } : null;
  const row = activeRow(o.db, "skills", o.channel);
  if (!row || row.seq <= bseq) return { active: bundled, bundled, bundledStamped: bseq > 0 };
  const file = join(installedDir(o.workspaceDir, "skills", o.channel, row.seq), "skills.manifest.json");
  const v = verifySkillsSource(file, o.keys);
  if (v.ok && v.contentSha256 === row.content_sha256) return { active: { source: "installed", seq: row.seq, version: row.version, contentSha256: row.content_sha256, file }, bundled, bundledStamped: bseq > 0 };
  markProblem(o.db, "skills", o.channel, row.seq, "本机核验失败（文件缺失或被改动）");
  return { active: bundled, bundled, bundledStamped: bseq > 0 };
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
  | "unauthorized"
  | "stale"
  | "rejected"
  | "failed"
  | "rollback_ignored"
  | "reverted"
  | "skipped";

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
  /** 法规库：已装好，等进行中的任务结束后换用。 */
  pending_swap?: boolean;
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
  /** 退出模式（许可到期、设备被吊销）：不检查（复核 S8A-19）。 */
  suspended?: () => boolean;
  /** 有任务在运行或排队：法规库延后换用（S8A-10）。 */
  busy?: () => boolean;
  lawdb: LawdbHolder;
  /** 启动时选定的内容（检查时据此判断当前 seq 与版本）。 */
  active: { lawdb: ActiveContent; skills: ActiveContent | null };
  /** 随包内容（撤回已装版本时回退到它）。 */
  bundled: { lawdb: ActiveContent; skills: ActiveContent | null };
  /** 随包内容是否带了本通道的签名信封（没有时随包 seq 按 0，应用升级后可能仍选用更旧的在线版本，S8A-02）。 */
  bundledStamped?: { lawdb: boolean; skills: boolean };
  audit: (action: string, objectId: string) => void;
  now?: () => number;
}

class Reject extends Error {
  readonly code: string;
  readonly outcome: CheckOutcome;
  constructor(code: string, outcome: CheckOutcome = "rejected") {
    super(code);
    this.code = code;
    this.outcome = outcome;
  }
}

/** 清单核验失败原因 → 结果分类（S8A-13：过期/未生效是“内容可能过时”，不是“包没通过核对”）。 */
function manifestOutcome(reason: string): CheckOutcome {
  return reason === "expired" || reason === "not_yet_valid" ? "stale" : "rejected";
}

/** 分发通道失败原因 → 结果分类（S8A-13：席位缺失或被拒不是“连不上”）。 */
function transportOutcome(reason: string): CheckOutcome {
  if (reason === "dist_seat_unavailable" || reason === "http_401" || reason === "http_403") return "unauthorized";
  return "unreachable";
}

export class ContentUpdater {
  private readonly last = new Map<ContentKind, CheckResult>();
  private readonly lastConfirmed = new Map<ContentKind, string>();
  private readonly inflight = new Map<ContentKind, Promise<CheckResult>>();
  /** 已装好、下次打开才生效的方法模板。 */
  private skillsPending: ActiveContent | null = null;
  /** 本次运行在用的方法模板已被撤回（下次打开时换回随包）。 */
  private skillsRevokedPending = false;
  /** 已装好、等任务结束再换用的法规库。 */
  private lawdbPending: ActiveContent | null = null;
  private swapTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly d: ContentUpdaterDeps;

  constructor(d: ContentUpdaterDeps) {
    this.d = d;
  }

  status(): {
    configured: boolean;
    channel: DistChannel;
    lawdb: { source: ContentSource; seq: number; version: string; pending: { seq: number; version: string } | null; bundled_stamped: boolean; last_check: CheckResult | null; last_confirmed_at: string | null };
    skills: {
      source: ContentSource | null;
      seq: number;
      version: string | null;
      pending: { seq: number; version: string } | null;
      revoked_pending_restart: boolean;
      bundled_stamped: boolean;
      last_check: CheckResult | null;
      last_confirmed_at: string | null;
    };
  } {
    const s = this.d.active.skills;
    return {
      configured: this.d.configured(),
      channel: this.d.channel,
      lawdb: {
        source: this.d.active.lawdb.source,
        seq: this.d.active.lawdb.seq,
        version: this.d.lawdb.current.packageVersion,
        pending: this.lawdbPending ? { seq: this.lawdbPending.seq, version: this.lawdbPending.version } : null,
        bundled_stamped: this.d.bundledStamped?.lawdb ?? false,
        last_check: this.last.get("lawdb") ?? null,
        last_confirmed_at: this.lastConfirmed.get("lawdb") ?? null,
      },
      skills: {
        source: s?.source ?? null,
        seq: s?.seq ?? 0,
        version: s?.version ?? null,
        pending: this.skillsPending ? { seq: this.skillsPending.seq, version: this.skillsPending.version } : null,
        revoked_pending_restart: this.skillsRevokedPending,
        bundled_stamped: this.d.bundledStamped?.skills ?? false,
        last_check: this.last.get("skills") ?? null,
        last_confirmed_at: this.lastConfirmed.get("skills") ?? null,
      },
    };
  }

  /** 首次检查的随机抖动（S8A-19：固定在启动后 2 分钟会向分发方暴露精确的启动时刻）。 */
  static firstDelayMs(): number {
    return 120_000 + randomInt(0, 600_000);
  }

  /** 检查并安装（每个类别单飞；不抛异常，结果写进状态）。 */
  check(kind: ContentKind): Promise<CheckResult> {
    const running = this.inflight.get(kind);
    if (running) return running;
    const p = this.run(kind)
      .catch((e): CheckResult => (e instanceof Reject ? { kind, outcome: e.outcome, reason: e.code, at: this.iso() } : { kind, outcome: "failed", reason: "internal", at: this.iso() }))
      .then((r) => {
        this.last.set(kind, r);
        if (r.outcome === "up_to_date" || r.outcome === "installed") this.lastConfirmed.set(kind, r.at);
        this.inflight.delete(kind);
        return r;
      });
    this.inflight.set(kind, p);
    return p;
  }

  /** 关停：等在途检查结束（S8A-20：不在已关闭的账本上写入、不留下未登记的落位目录）。 */
  async close(): Promise<void> {
    this.closed = true;
    if (this.swapTimer) clearInterval(this.swapTimer);
    await Promise.allSettled([...this.inflight.values()]);
  }

  private iso(): string {
    return new Date((this.d.now ?? Date.now)()).toISOString();
  }

  private async get(path: string): Promise<Uint8Array> {
    const r = await this.d.fetch(path);
    if (!r.ok) throw r.reason === "dist_not_configured" ? new Reject("not_configured", "not_configured") : new Reject(r.reason, transportOutcome(r.reason));
    if (r.status !== 200) throw new Reject(`http_${r.status}`, transportOutcome(`http_${r.status}`));
    return new Uint8Array(Buffer.from(r.body_b64, "base64"));
  }

  private current(kind: ContentKind): { seq: number; version: string | null; contentSha256: string | null } {
    if (kind === "lawdb") {
      const l = this.lawdbPending ?? this.d.active.lawdb;
      return { seq: l.seq, version: this.lawdbPending ? l.version : this.d.lawdb.current.packageVersion, contentSha256: this.lawdbPending ? l.contentSha256 : this.d.lawdb.current.contentSha256 };
    }
    if (this.skillsRevokedPending && !this.skillsPending) {
      const b = this.d.bundled.skills;
      return { seq: b?.seq ?? 0, version: b?.version ?? null, contentSha256: b?.contentSha256 ?? null };
    }
    const s = this.skillsPending ?? this.d.active.skills;
    return { seq: s?.seq ?? 0, version: s?.version ?? null, contentSha256: s?.contentSha256 ?? null };
  }

  /** 当前在用（含待生效）的是否是在线已装版本。 */
  private currentInstalledSeq(kind: ContentKind): number | null {
    if (kind === "lawdb") {
      const l = this.lawdbPending ?? this.d.active.lawdb;
      return l.source === "installed" ? l.seq : null;
    }
    if (this.skillsPending) return this.skillsPending.seq;
    if (this.skillsRevokedPending) return null;
    return this.d.active.skills?.source === "installed" ? this.d.active.skills.seq : null;
  }

  private async run(kind: ContentKind): Promise<CheckResult> {
    const at = this.iso();
    const { db, channel } = this.d;
    if (!this.d.configured()) return { kind, outcome: "not_configured", at };
    if (this.d.suspended?.()) return { kind, outcome: "skipped", reason: "exit_mode", at };
    let raw: Uint8Array;
    try {
      raw = await this.get(`/dist/${kind}/${channel}/latest.json`);
    } catch (e) {
      // 本通道还没有发布过这一类内容：不是连不上
      if (e instanceof Reject && e.code === "http_404") return { kind, outcome: "up_to_date", reason: "not_published", seq: this.current(kind).seq, at };
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return { kind, outcome: "rejected", reason: "manifest_json", at };
    }
    const v = verifyChannelManifest(parsed, this.d.keys, { kind, channel, now: (this.d.now ?? Date.now)() });
    if (!v.ok) return { kind, outcome: manifestOutcome(v.reason), reason: `manifest_${v.reason}`, at };
    const m = v.manifest;
    // 通道清单回退（低于见过的最高 seq）：不采用；同一 seq 给出不同内容：拒绝（S8A-04）
    const hw = db.get<{ seq: number; content_sha256: string | null }>(`SELECT seq, content_sha256 FROM content_channel_hw WHERE kind = ? AND channel = ?`, [kind, channel]);
    if (hw && m.seq < hw.seq) return { kind, outcome: "rollback_ignored", reason: "manifest_seq_below_seen", seq: m.seq, at };
    const sameSeqInstalled = db.get<{ content_sha256: string }>(`SELECT content_sha256 FROM content_installs WHERE kind = ? AND channel = ? AND seq = ?`, [kind, channel, m.seq]);
    if ((hw && m.seq === hw.seq && hw.content_sha256 && hw.content_sha256 !== m.content_sha256) || (sameSeqInstalled && sameSeqInstalled.content_sha256 !== m.content_sha256)) {
      db.tx(() => this.d.audit("content.seq_conflict", `${kind}:${channel}:${m.seq}`));
      return { kind, outcome: "rejected", reason: "seq_content_conflict", seq: m.seq, at };
    }
    db.run(
      `INSERT INTO content_channel_hw (kind, channel, seq, content_sha256, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (kind, channel) DO UPDATE SET seq = excluded.seq, content_sha256 = excluded.content_sha256, updated_at = excluded.updated_at`,
      [kind, channel, m.seq, m.content_sha256, at],
    );

    // 撤回：当前在用（含待生效）的已装版本被列入 revoked_seqs → 同一事务标记撤回并审计（只记一次）；清单有更新的就装新的，否则回到随包内容
    const instSeq = this.currentInstalledSeq(kind);
    if (instSeq !== null && m.revoked_seqs.includes(instSeq)) {
      db.tx(() => {
        const r = db.run(`UPDATE content_installs SET active = 0, revoked_at = ? WHERE kind = ? AND channel = ? AND seq = ? AND revoked_at IS NULL`, [at, kind, channel, instSeq]);
        if (r.changes > 0) this.d.audit("content.revoked", `${kind}:${channel}:${instSeq}`);
      });
      this.revertToBundled(kind);
      if (m.seq <= instSeq || !inRollout(m, this.d.deviceId)) return { kind, outcome: "reverted", seq: this.current(kind).seq, at, ...(kind === "skills" ? { restart_required: true } : {}) };
    }
    const now = this.current(kind);
    if (m.seq <= now.seq) return { kind, outcome: "up_to_date", seq: now.seq, at };
    // 内容相同（只是通道 seq 更高，例如随包内容未带信封）：无需安装
    if (now.contentSha256 && now.contentSha256 === m.content_sha256) return { kind, outcome: "up_to_date", seq: now.seq, at };
    if (!inRollout(m, this.d.deviceId)) return { kind, outcome: "staged_rollout", seq: m.seq, at };
    const plan = planInstall(m, now.version);
    if (!plan) return { kind, outcome: "rejected", reason: "no_applicable_package", seq: m.seq, at };
    const files = new Map<string, Uint8Array>();
    for (const p of plan.packages) {
      for (const [name, size, sha] of [[p.file, p.size, p.sha256], ...(p.manifest_file ? [[p.manifest_file, p.manifest_size!, p.manifest_sha256!]] : [])] as [string, number, string][]) {
        const bytes = await this.get(`/dist/${kind}/${channel}/files/${name}`);
        if (!fileMatches(bytes, size, sha)) throw new Reject("file_digest_mismatch");
        files.set(name, bytes);
      }
    }
    if (this.closed) return { kind, outcome: "skipped", reason: "closing", at };
    const dest = installedDir(this.d.workspaceDir, kind, channel, m.seq);
    const stage = `${dest}.stage-${randomBytes(6).toString("hex")}`;
    try {
      mkdirSync(stage, { recursive: true });
      if (kind === "lawdb") this.stageLawdb(stage, m, plan.packages, files);
      else this.stageSkills(stage, m, plan.packages[0]!, files);
      retrySync(() => rmSync(dest, { recursive: true, force: true }));
      retrySync(() => renameSync(stage, dest));
    } catch (e) {
      try {
        rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // 留给下次 prune
      }
      if (e instanceof Reject) throw new Reject(e.code, e.outcome);
      throw new Reject("stage_failed", "failed");
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
    const installed: ActiveContent = { source: "installed", seq: m.seq, version: m.version, contentSha256: m.content_sha256, file: kind === "lawdb" ? join(dest, "lawdb.sqlite") : join(dest, "skills.manifest.json") };
    let pendingSwap = false;
    if (kind === "lawdb") {
      if (this.d.busy?.()) {
        this.lawdbPending = installed;
        pendingSwap = true;
        this.scheduleSwap();
      } else {
        this.lawdbPending = null;
        this.swapLawdb(installed);
      }
    } else {
      this.skillsPending = installed;
      this.skillsRevokedPending = false;
    }
    this.prune(kind, m.seq);
    return { kind, outcome: "installed", seq: m.seq, version: m.version, at, ...(kind === "skills" ? { restart_required: true } : {}), ...(pendingSwap ? { pending_swap: true } : {}) };
  }

  private swapLawdb(next: ActiveContent): void {
    this.d.lawdb.swap(openLawdbWithKeys(next.file, this.d.keys));
    this.d.active.lawdb = next;
    this.d.audit("lawdb.load", this.d.lawdb.current.packageVersion);
  }

  /** 有任务时延后换用：每 15 秒看一次，空闲即换（S8A-10）。 */
  private scheduleSwap(): void {
    if (this.swapTimer) return;
    this.swapTimer = setInterval(() => {
      if (this.closed || !this.lawdbPending) {
        if (this.swapTimer) clearInterval(this.swapTimer);
        this.swapTimer = null;
        return;
      }
      if (this.d.busy?.()) return;
      const next = this.lawdbPending;
      this.lawdbPending = null;
      try {
        this.swapLawdb(next);
      } catch {
        markProblem(this.d.db, "lawdb", this.d.channel, next.seq, "换用时打开失败");
      }
      if (this.swapTimer) clearInterval(this.swapTimer);
      this.swapTimer = null;
    }, 15_000);
    this.swapTimer.unref();
  }

  /** 回到随包：法规库换回随包（有任务时同样延后）；方法模板下次打开时生效。 */
  private revertToBundled(kind: ContentKind): void {
    if (kind === "lawdb") {
      this.lawdbPending = null;
      if (this.d.active.lawdb.source !== "installed") return;
      if (this.d.busy?.()) {
        this.lawdbPending = this.d.bundled.lawdb;
        this.scheduleSwap();
      } else this.swapLawdb(this.d.bundled.lawdb);
      return;
    }
    this.skillsPending = null;
    this.skillsRevokedPending = this.d.active.skills?.source === "installed";
  }

  /** 法规库落位：全量包直接核验；增量链从当前在用的包复制出可写副本逐个应用，最后按通道清单核对摘要与版本。 */
  private stageLawdb(stage: string, m: ChannelManifest, pkgs: DistPackage[], files: Map<string, Uint8Array>): void {
    const target = join(stage, "lawdb.sqlite");
    if (pkgs[0]!.type === "full") {
      writeFileSync(target, files.get(pkgs[0]!.file)!);
      writeFileSync(sidecarOf(target), files.get(pkgs[0]!.manifest_file!)!);
    } else {
      const srcFile = (this.lawdbPending ?? this.d.active.lawdb).file;
      copyFileSync(srcFile, target);
      copyFileSync(sidecarOf(srcFile), sidecarOf(target));
      let w: Lawdb;
      try {
        w = openLawdbWithKeys(target, this.d.keys, { writable: true });
      } catch {
        throw new Reject("base_invalid", "failed");
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
      // SQLite 可能留下 -wal/-shm：只保留包文件对
      for (const n of readdirSync(stage)) if (n !== "lawdb.sqlite" && n !== "lawdb.manifest.json") rmSync(join(stage, n), { force: true });
    }
    let l: Lawdb;
    try {
      l = openLawdbWithKeys(target, this.d.keys);
    } catch {
      throw new Reject("package_invalid");
    }
    const ok = l.packageVersion === m.version && l.contentSha256 === m.content_sha256;
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

  /** 只保留在用的、待生效的与上一个已装版本（回退备用），其余目录删除；账本行保留（防回退依据）。 */
  private prune(kind: ContentKind, keepSeq: number): void {
    const base = join(this.d.workspaceDir, "content", kind);
    const rows = this.d.db.all<{ seq: number }>(`SELECT seq FROM content_installs WHERE kind = ? AND channel = ? AND problem IS NULL AND revoked_at IS NULL ORDER BY seq DESC LIMIT 2`, [kind, this.d.channel]);
    const inUse = kind === "lawdb" ? this.d.active.lawdb : this.d.active.skills;
    const keep = new Set([keepSeq, ...rows.map((r) => r.seq), ...(inUse?.source === "installed" ? [inUse.seq] : [])].map((s) => `${this.d.channel}-${s}`));
    try {
      for (const n of readdirSync(base)) {
        if (keep.has(n)) continue;
        try {
          rmSync(join(base, n), { recursive: true, force: true, maxRetries: 3 });
        } catch {
          // 删不掉（被占用）：下次再清
        }
      }
    } catch {
      // 目录不存在
    }
  }
}
