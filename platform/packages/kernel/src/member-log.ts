/**
 * 带因果链的成员日志（第 12 批；设计见 docs/第12批-成员日志设计.md）。
 *
 * 每个团队事项一条成员事件的有向无环图：事件由作者设备签名、引用作者写它时本机的链头（前序事件编号）、带按事项合并的逻辑时钟。
 * 接收方存下签名与证书核验通过的全部事件，每次变化后确定性地重算“有效集”（与到达顺序无关）：
 * - 起点（genesis / anchor）每个事项只有一个，本机已有起点时不切换到别的起点（防抢占）；
 * - 作者资格按该事件的**因果过去**投影判断（是未移出的负责人）；
 * - 吊销按链上位置：作者设备已吊销时，只有被在用设备写的有效事件引用过（是其祖先）的才有效；已有吊销标记（mark）之后其余的拒收；
 * - 成员关系 = 有效集的投影（每人取“最新的并发集合”，并发时移出优先）；`matter_members` 只是投影；
 * - 纪元由链上事件声明（纪元号 + 签发者 + 密钥指纹 + 各包裹摘要），同号分叉按 (lamport, 事件编号) 最小者胜出；包裹按声明的摘要落库。
 * 本模块只读写本机库，不碰介质；介质收发见 sync-engine.ts。
 */
import { createHash } from "node:crypto";
import { canonicalJson, generateMatterKey, signSyncWith, unwrapMatterKey, verifyBytes, wrapMatterKey, type DeviceCertificate } from "@zr-legal/keys";
import type { KernelDb } from "./db.ts";
import type { KernelKeyContext } from "./devices.ts";
import { deviceTombstoned, verifyCertSignature } from "./ledger-signer.ts";

export interface ChainDeps {
  db: KernelDb;
  keyctx: KernelKeyContext;
  tenantId: string;
}

export const MEMBER_EVENT_V = "kwl-member-event/1";
export const MEMBER_EVENTS_TABLE = "member_events";
const ROLES = new Set(["owner", "editor", "reviewer", "issuer", "viewer"]);
const ID_RE = /^[0-9a-f]{64}$/;
const NAME_RE = /^[A-Za-z0-9_.:@-]{1,200}$/;
/** 一个事件最多引用的前序（链头）个数。 */
const MAX_PREV = 64;
/** 一个事件最多声明的包裹个数（设备 + 恢复托管）。 */
const MAX_WRAPS = 512;

export type EventKind = "genesis" | "anchor" | "member" | "rekey" | "wrap" | "mark" | "control";

/** 新纪元声明：纪元号、密钥指纹、各包裹密文的摘要（设备编号或 recovery → 摘要）。 */
export interface KeyDecl {
  epoch: number;
  fp: string | null;
  wraps: Record<string, string>;
}

export interface MemberEventPayload {
  v: typeof MEMBER_EVENT_V;
  tenant: string;
  matter_id: string;
  kind: EventKind;
  prev: string[];
  lamport: number;
  author_device: string;
  at: string;
  body: Record<string, unknown>;
}

export interface StoredEvent {
  id: string;
  p: MemberEventPayload;
  sig: string;
  certJson: string;
  member: string;
  /** 本机收下（或写下）的时刻：吊销标记只固定在设备被吊销之前收下的事件。 */
  received: string;
}

/** 同步段里的一行（段体内，随事项密钥加密）。 */
export interface MemberEventRow {
  event_id: string;
  payload: string;
  sig: string;
  author_cert: string;
}

function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 事项密钥指纹（域分隔；只用来核对“这把密钥是不是链上声明的那把”）。 */
export function keyFingerprint(key: Uint8Array): string {
  return createHash("sha256").update("kwl-matter-key-fp/1").update(key).digest("hex").slice(0, 32);
}

/** 包裹密文的摘要（链上声明的就是它）。 */
export function wrapDigest(wrapped: string): string {
  return sha256Hex(`kwl-matter-wrap/1\n${wrapped}`);
}

function eventIdOf(p: MemberEventPayload): string {
  return sha256Hex(canonicalJson(p));
}

function sigBytes(id: string): Uint8Array {
  return new TextEncoder().encode(`${MEMBER_EVENT_V}\n${id}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── 存储 ───

export function hasChain(db: KernelDb, matterId: string): boolean {
  return !!db.get(`SELECT 1 AS x FROM member_chain WHERE matter_id = ? AND root_id IS NOT NULL`, [matterId]);
}

/** 本机被要求重新引导该事项（下一次收到的链按首同步规则采用）。 */
export function rebootstrapPending(db: KernelDb, matterId: string): boolean {
  return !!db.get(`SELECT 1 AS x FROM member_chain WHERE matter_id = ? AND root_id IS NULL`, [matterId]);
}

function loadEvents(db: KernelDb, matterId: string): StoredEvent[] {
  return db
    .all<{ event_id: string; payload: string; sig: string; author_cert: string; author_member: string; received_at: string }>(
      `SELECT event_id, payload, sig, author_cert, author_member, received_at FROM member_events WHERE matter_id = ?`,
      [matterId],
    )
    .map((r) => ({ id: r.event_id, p: JSON.parse(r.payload) as MemberEventPayload, sig: r.sig, certJson: r.author_cert, member: r.author_member, received: r.received_at }));
}

/** 段里的成员事件行导出形态：链上拒收的事件不转发（复核 S12A-05：否则所内任意设备塞进来的事件被全员无限转发）；有效与待定的照发。 */
export function exportEventRows(deps: ChainDeps, matterId: string): MemberEventRow[] {
  const rows = deps.db.all<MemberEventRow>(`SELECT event_id, payload, sig, author_cert FROM member_events WHERE matter_id = ? ORDER BY lamport, event_id`, [matterId]);
  if (rows.length === 0 || !hasChain(deps.db, matterId)) return rows;
  const v = chainView(deps, matterId);
  return rows.filter((r) => v.status.get(r.event_id)?.s !== "rejected");
}

function insertEvent(db: KernelDb, e: StoredEvent, viaMember: string | null): boolean {
  const r = db.run(
    `INSERT OR IGNORE INTO member_events (event_id, matter_id, lamport, kind, author_device, author_member, payload, sig, author_cert, via_member, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [e.id, e.p.matter_id, e.p.lamport, e.p.kind, e.p.author_device, e.member, canonicalJson(e.p), e.sig, e.certJson, viaMember, e.received],
  );
  return r.changes > 0;
}

// ─── 核验（形状、编号、证书、签名） ───

function isKeyDecl(x: unknown, allowNullFp: boolean): x is KeyDecl {
  const k = x as KeyDecl;
  if (!k || typeof k !== "object" || !Number.isSafeInteger(k.epoch) || k.epoch < 1) return false;
  if (!(typeof k.fp === "string" ? /^[0-9a-f]{32}$/.test(k.fp) : allowNullFp && k.fp === null)) return false;
  return isWraps(k.wraps);
}

function isWraps(w: unknown): w is Record<string, string> {
  if (!w || typeof w !== "object" || Array.isArray(w)) return false;
  const ents = Object.entries(w as Record<string, unknown>);
  return ents.length <= MAX_WRAPS && ents.every(([d, h]) => NAME_RE.test(d) && typeof h === "string" && ID_RE.test(h));
}

function bodyShapeOk(p: MemberEventPayload): boolean {
  const b = p.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const members = (x: unknown, allowRemoved: boolean) =>
    Array.isArray(x) &&
    x.length >= 1 &&
    x.length <= 2048 &&
    x.every((m) => m && typeof m === "object" && NAME_RE.test(String((m as any).user)) && ROLES.has(String((m as any).role)) && (allowRemoved ? typeof (m as any).removed === "boolean" : (m as any).removed === undefined)) &&
    new Set(x.map((m) => (m as any).user)).size === x.length;
  switch (p.kind) {
    case "genesis":
      return NAME_RE.test(String(b.creator)) && members(b.members, false) && (b.members as any[]).every((m) => m.role === "owner") && isKeyDecl(b.key, false) && (b.key as KeyDecl).epoch === 1;
    case "anchor":
      return (
        members(b.members, true) &&
        isKeyDecl(b.key, false) &&
        (b.legacy === undefined || (Array.isArray(b.legacy) && b.legacy.length <= 1024 && b.legacy.every((k) => isKeyDecl(k, true) && k.epoch < (b.key as KeyDecl).epoch)))
      );
    case "member":
      return (
        NAME_RE.test(String(b.user)) &&
        (b.role === null || ROLES.has(String(b.role))) &&
        (b.key === undefined || isKeyDecl(b.key, false)) &&
        (b.wraps === undefined || (!!b.wraps && typeof b.wraps === "object" && Number.isSafeInteger((b.wraps as any).epoch) && isWraps((b.wraps as any).wraps)))
      );
    case "rekey":
      return isKeyDecl(b.key, false) && typeof b.reason === "string" && b.reason.length <= 300;
    case "wrap":
      return !!b.wraps && typeof b.wraps === "object" && Number.isSafeInteger((b.wraps as any).epoch) && isWraps((b.wraps as any).wraps);
    case "mark":
      return NAME_RE.test(String(b.device));
    case "control":
      return NAME_RE.test(String(b.to));
    default:
      return false;
  }
}

/**
 * 段里收到的一行成员事件：形状、编号（= 载荷摘要）、作者证书（律所根签发、设备编号对得上）、签名都对才返回。
 * 只说明“这条事件确由所内这台设备签发”；它在链上是否有效由 chainView 判断。
 */
export function verifyEventRow(deps: ChainDeps, matterId: string, raw: unknown): StoredEvent | null {
  const r = raw as MemberEventRow;
  if (!r || typeof r.event_id !== "string" || typeof r.payload !== "string" || typeof r.sig !== "string" || typeof r.author_cert !== "string") return null;
  if (r.payload.length > 256 * 1024 || r.author_cert.length > 16 * 1024) return null;
  let p: MemberEventPayload;
  let cert: DeviceCertificate;
  try {
    p = JSON.parse(r.payload) as MemberEventPayload;
    cert = JSON.parse(r.author_cert) as DeviceCertificate;
  } catch {
    return null;
  }
  if (!p || p.v !== MEMBER_EVENT_V || p.tenant !== deps.tenantId || p.matter_id !== matterId) return null;
  if (!["genesis", "anchor", "member", "rekey", "wrap", "mark", "control"].includes(p.kind)) return null;
  if (!Array.isArray(p.prev) || p.prev.length > MAX_PREV || p.prev.some((x) => typeof x !== "string" || !ID_RE.test(x))) return null;
  if (new Set(p.prev).size !== p.prev.length || [...p.prev].sort().join() !== p.prev.join()) return null;
  if (!Number.isSafeInteger(p.lamport) || p.lamport < 1 || typeof p.at !== "string" || typeof p.author_device !== "string") return null;
  if (!bodyShapeOk(p)) return null;
  if (eventIdOf(p) !== r.event_id) return null;
  if (!cert || cert.deviceId !== p.author_device || !verifyCertSignature(cert, deps.keyctx.firm.rootPublicKeyPem)) return null;
  if (!verifyBytes(cert.signPublicKeyPem, sigBytes(r.event_id), r.sig)) return null;
  return { id: r.event_id, p, sig: r.sig, certJson: r.author_cert, member: cert.memberId, received: nowIso() };
}

/** 收到的成员事件行入库（核验通过的；已有的忽略）。返回新存下的条数。 */
export function storeIncomingEvents(deps: ChainDeps, matterId: string, rows: unknown[], viaMember: string): { stored: number; bad: number } {
  let stored = 0;
  let bad = 0;
  for (const raw of rows) {
    const e = verifyEventRow(deps, matterId, raw);
    if (!e) {
      bad += 1;
      continue;
    }
    if (insertEvent(deps.db, e, viaMember)) stored += 1;
  }
  return { stored, bad };
}

// ─── 有效集与投影 ───

export type EventStatus = { s: "valid" } | { s: "pending"; why: "missing_parents" | "revoked_unvouched" | "parent_pending" } | { s: "rejected"; why: string };

export interface MemberState {
  role: string | null;
  decider: StoredEvent;
  /** 链上给过他的最后一个角色（按先后；已移出时作投影行的角色，确定、与本机旧行无关）。 */
  lastRole: string;
}

export interface EpochInfo {
  winner: StoredEvent;
  decl: KeyDecl;
  losers: StoredEvent[];
  /** 该纪元落库认可的包裹：设备（或 recovery）→ 包裹摘要的集合。 */
  wraps: Map<string, Set<string>>;
}

export interface ChainView {
  root: StoredEvent | null;
  events: Map<string, StoredEvent>;
  status: Map<string, EventStatus>;
  anc: Map<string, Set<string>>;
  /** 有效事件，按 (lamport, 编号) 先后。 */
  valid: StoredEvent[];
  heads: string[];
  members: Map<string, MemberState>;
  epochs: Map<number, EpochInfo>;
  maxEpoch: number;
  /** 链上最近一次控制成员移交的接收者（只作显示；中继是准绳）。 */
  controlTo: string | null;
  foreignRoots: StoredEvent[];
}

const order = (a: StoredEvent, b: StoredEvent) => a.p.lamport - b.p.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function isRootKind(k: EventKind): boolean {
  return k === "genesis" || k === "anchor";
}

/** 有效事件集合（按先后）的成员投影：每人取最新的并发集合，其中有移出即已移出，否则取最晚者的角色。 */
function project(evs: StoredEvent[], anc: Map<string, Set<string>>): Map<string, MemberState> {
  const about = new Map<string, { e: StoredEvent; role: string | null }[]>();
  const push = (u: string, e: StoredEvent, role: string | null) => {
    const l = about.get(u) ?? [];
    l.push({ e, role });
    about.set(u, l);
  };
  for (const e of evs) {
    if (isRootKind(e.p.kind)) for (const m of e.p.body.members as { user: string; role: string; removed?: boolean }[]) push(m.user, e, m.removed ? null : m.role);
    else if (e.p.kind === "member") push(String(e.p.body.user), e, (e.p.body.role as string | null) ?? null);
  }
  const out = new Map<string, MemberState>();
  for (const [u, items] of about) {
    const maximal = items.filter((x) => !items.some((y) => y.e.id !== x.e.id && anc.get(y.e.id)?.has(x.e.id)));
    const roled = items.filter((x) => x.role !== null).sort((a, b) => order(a.e, b.e));
    const lastRole = roled.length > 0 ? roled[roled.length - 1]!.role! : "viewer";
    const removal = maximal.filter((x) => x.role === null).sort((a, b) => order(a.e, b.e));
    if (removal.length > 0) {
      out.set(u, { role: null, decider: removal[removal.length - 1]!.e, lastRole });
      continue;
    }
    const last = maximal.sort((a, b) => order(a.e, b.e))[maximal.length - 1]!;
    out.set(u, { role: last.role, decider: last.e, lastRole });
  }
  return out;
}

function deviceRevoked(db: KernelDb, deviceId: string): boolean {
  return !!db.get(`SELECT 1 AS x FROM devices WHERE device_id = ? AND status = 'revoked'`, [deviceId]) || deviceTombstoned(db, deviceId);
}

/** 设备被吊销的时刻（本机吊销记录与控制面墓碑取较早者；不知道时为 null）。 */
export function revokedAtOf(db: KernelDb, deviceId: string): string | null {
  const a = db.get<{ t: string | null }>(`SELECT revoked_at AS t FROM devices WHERE device_id = ? AND status = 'revoked'`, [deviceId])?.t ?? null;
  const b = db.get<{ t: string | null }>(`SELECT MIN(revoked_at) AS t FROM cp_revoked_devices WHERE device_id = ?`, [deviceId])?.t ?? null;
  return [a, b].filter((x): x is string => !!x).sort()[0] ?? null;
}

/**
 * 重算有效集（确定性）。`liveBefore`：设备 → 时刻，该设备写的、本机在此时刻之前收下的事件按“未吊销”对待
 * （负责人写吊销标记时用：把本机在设备被吊销之前收下的事件固定下来）。
 */
export function chainView(deps: ChainDeps, matterId: string, opts: { liveBefore?: Map<string, string> } = {}): ChainView {
  const { db } = deps;
  // 缓存（导出每 5 秒对每个团队事项都要看链）：链、起点与吊销状态都没变时复用；带 liveBefore 的不缓存
  if (!opts.liveBefore) {
    const key = viewKey(db, matterId);
    let per = viewCache.get(db);
    if (!per) viewCache.set(db, (per = new Map()));
    const hit = per.get(matterId);
    if (hit && hit.key === key) return hit.view;
    const view = computeView(deps, matterId, opts);
    per.set(matterId, { key, view });
    return view;
  }
  return computeView(deps, matterId, opts);
}

/** 链视图缓存（按库、按事项）。视图只读，调用方不改。 */
const viewCache = new WeakMap<KernelDb, Map<string, { key: string; view: ChainView }>>();

function viewKey(db: KernelDb, matterId: string): string {
  const ev = db.get<{ n: number; r: string | null }>(`SELECT COUNT(*) AS n, MAX(received_at || event_id) AS r FROM member_events WHERE matter_id = ?`, [matterId]);
  const root = db.get<{ root_id: string | null }>(`SELECT root_id FROM member_chain WHERE matter_id = ?`, [matterId])?.root_id ?? "";
  const rv = db.get<{ a: number; b: number }>(`SELECT (SELECT COUNT(*) FROM devices WHERE status = 'revoked') AS a, (SELECT COUNT(*) FROM cp_revoked_devices) AS b`, []);
  return `${root}|${ev?.n ?? 0}|${ev?.r ?? ""}|${rv?.a ?? 0}|${rv?.b ?? 0}`;
}

function computeView(deps: ChainDeps, matterId: string, opts: { liveBefore?: Map<string, string> }): ChainView {
  const { db } = deps;
  const rootId = db.get<{ root_id: string | null }>(`SELECT root_id FROM member_chain WHERE matter_id = ?`, [matterId])?.root_id ?? null;
  const all = loadEvents(db, matterId).sort(order);
  const events = new Map(all.map((e) => [e.id, e]));
  const status = new Map<string, EventStatus>();
  const anc = new Map<string, Set<string>>();
  const root = rootId ? (events.get(rootId) ?? null) : null;
  const foreignRoots: StoredEvent[] = [];
  const view: ChainView = { root, events, status, anc, valid: [], heads: [], members: new Map(), epochs: new Map(), maxEpoch: 0, controlTo: null, foreignRoots };
  if (!root) {
    for (const e of all) status.set(e.id, { s: "pending", why: "missing_parents" });
    return view;
  }
  // 第一遍：结构、作者资格、纪元号（假定所有设备都在用）
  const tentative: StoredEvent[] = [];
  const projMemo = new Map<string, Map<string, MemberState>>();
  for (const e of all) {
    if (e.id === root.id) {
      status.set(e.id, { s: "valid" });
      anc.set(e.id, new Set());
      tentative.push(e);
      continue;
    }
    if (isRootKind(e.p.kind)) {
      status.set(e.id, { s: "rejected", why: "foreign_root" });
      foreignRoots.push(e);
      continue;
    }
    if (e.p.prev.length === 0) {
      status.set(e.id, { s: "rejected", why: "no_prev" });
      continue;
    }
    let st: EventStatus | null = null;
    let maxL = 0;
    for (const pid of e.p.prev) {
      const pe = events.get(pid);
      if (!pe) {
        st ??= { s: "pending", why: "missing_parents" };
        continue;
      }
      maxL = Math.max(maxL, pe.p.lamport);
      const ps = status.get(pid);
      if (!ps) st = { s: "rejected", why: "bad_lamport" }; // 前序的 lamport 不比它小（排序后尚未处理）
      else if (ps.s === "rejected") st = { s: "rejected", why: "parent_rejected" };
      else if (ps.s === "pending" && st?.s !== "rejected") st = { s: "pending", why: ps.why === "missing_parents" ? "missing_parents" : "parent_pending" };
    }
    if (!st && e.p.lamport !== maxL + 1) st = { s: "rejected", why: "bad_lamport" };
    if (st) {
      status.set(e.id, st);
      continue;
    }
    const a = new Set<string>();
    for (const pid of e.p.prev) {
      a.add(pid);
      for (const x of anc.get(pid)!) a.add(x);
    }
    anc.set(e.id, a);
    const past = tentative.filter((x) => a.has(x.id));
    const key = [...a].sort().join();
    let proj = projMemo.get(key);
    if (!proj) projMemo.set(key, (proj = project(past, anc)));
    if (proj.get(e.member)?.role !== "owner") {
      status.set(e.id, { s: "rejected", why: "author_not_owner" });
      continue;
    }
    // 新纪元须高于因果过去里声明过的全部纪元；追加包裹须落在因果过去里声明过的纪元上
    const pastMax = Math.max(0, ...past.flatMap((x) => declsOf(x).map((d) => d.epoch)));
    const k = e.p.body.key as KeyDecl | undefined;
    if (k && k.epoch <= pastMax) {
      status.set(e.id, { s: "rejected", why: "epoch_not_newer" });
      continue;
    }
    const w = e.p.body.wraps as { epoch: number } | undefined;
    if (w && !past.some((x) => declsOf(x).some((d) => d.epoch === w.epoch))) {
      status.set(e.id, { s: "rejected", why: "wraps_epoch_undeclared" });
      continue;
    }
    status.set(e.id, { s: "valid" });
    tentative.push(e);
  }
  // 第二遍：吊销按链上位置（根事件不受影响——它的有效性在采用时确定）
  const liveMemo = new Map<string, boolean>();
  const devLive = (dev: string) => {
    let v = liveMemo.get(dev);
    if (v === undefined) liveMemo.set(dev, (v = !deviceRevoked(db, dev)));
    return v;
  };
  const isLive = (e: StoredEvent) => {
    if (devLive(e.p.author_device)) return true;
    const before = opts.liveBefore?.get(e.p.author_device);
    return !!before && e.received < before;
  };
  const vouched = new Set<string>();
  for (const v of tentative) if (isLive(v)) for (const x of anc.get(v.id)!) vouched.add(x);
  const marked = new Set(tentative.filter((x) => x.p.kind === "mark" && isLive(x)).map((x) => String(x.p.body.device)));
  const bad = new Map<string, EventStatus>();
  for (const e of tentative) {
    if (e.id === root.id || isLive(e) || vouched.has(e.id)) continue;
    bad.set(e.id, marked.has(e.p.author_device) ? { s: "rejected", why: "revoked_after_mark" } : { s: "pending", why: "revoked_unvouched" });
  }
  // 后代随之（按先后，祖先先处理）
  for (const e of tentative) {
    if (bad.has(e.id)) continue;
    for (const x of anc.get(e.id) ?? []) {
      const b = bad.get(x);
      if (b) {
        bad.set(e.id, b.s === "rejected" ? { s: "rejected", why: "parent_rejected" } : { s: "pending", why: "parent_pending" });
        break;
      }
    }
  }
  // 第三遍：被降级或移出者的并发操作不算（移出优先于被移出者的并发操作）——最终不是负责人的成员，他写的、与降级或移出他的事件并发
  // （互不为祖先）的事件拒收，后代随之。例外：降级或移出“降级他的那个人”的事件不拒收——互相降级时两条都成立（失败即关闭，复核 S12A-02：
  // 原先两条都不成立，被移出者只要在旧链头上对移出者做一次降级，就能撤销自己的移出）。只按第二遍之后的投影判一次
  const pass2 = tentative.filter((e) => !bad.has(e.id));
  const p1 = project(pass2, anc);
  const demotions = new Map<string, StoredEvent[]>();
  for (const e of pass2) {
    if (e.p.kind !== "member") continue;
    const u = String(e.p.body.user);
    if (e.p.body.role === "owner" || p1.get(u)?.role === "owner") continue;
    const l = demotions.get(u) ?? [];
    l.push(e);
    demotions.set(u, l);
  }
  for (const e of pass2) {
    if (e.id === root.id || bad.has(e.id)) continue;
    const ds = demotions.get(e.member);
    const retaliation = (d: StoredEvent) => e.p.kind === "member" && e.p.body.role !== "owner" && String(e.p.body.user) === d.member;
    if (ds?.some((d) => d.id !== e.id && !anc.get(e.id)!.has(d.id) && !anc.get(d.id)!.has(e.id) && !retaliation(d))) bad.set(e.id, { s: "rejected", why: "author_demoted_concurrently" });
  }
  for (const e of tentative) {
    if (bad.has(e.id)) continue;
    for (const x of anc.get(e.id) ?? []) {
      const b = bad.get(x);
      if (b) {
        bad.set(e.id, b.s === "rejected" ? { s: "rejected", why: "parent_rejected" } : { s: "pending", why: "parent_pending" });
        break;
      }
    }
  }
  for (const [id, st] of bad) status.set(id, st);
  view.valid = tentative.filter((e) => !bad.has(e.id));
  const covered = new Set<string>();
  for (const e of view.valid) for (const x of anc.get(e.id)!) covered.add(x);
  view.heads = view.valid.filter((e) => !covered.has(e.id)).map((e) => e.id).sort();
  view.members = project(view.valid, anc);
  // 纪元：胜者 = 同号声明里，作者此刻仍是在册负责人的优先，再按 (lamport, 编号) 最小者（被移出的共同负责人并发轮换出的同号纪元落选）；
  // 包裹 = 胜者声明 + 因果过去含胜者的追加
  const ownerNow = (m: string) => view.members.get(m)?.role === "owner";
  const decls: { e: StoredEvent; d: KeyDecl }[] = [];
  for (const e of view.valid) for (const d of declsOf(e)) decls.push({ e, d });
  decls.sort((a, b) => Number(ownerNow(b.e.member)) - Number(ownerNow(a.e.member)) || order(a.e, b.e));
  for (const { e, d } of decls) {
    const cur = view.epochs.get(d.epoch);
    if (!cur) {
      view.epochs.set(d.epoch, { winner: e, decl: d, losers: [], wraps: new Map(Object.entries(d.wraps).map(([k, v]) => [k, new Set([v])])) });
    } else if (cur.winner.id !== e.id) cur.losers.push(e);
    view.maxEpoch = Math.max(view.maxEpoch, d.epoch);
  }
  for (const e of view.valid) {
    const w = e.p.body.wraps as { epoch: number; wraps: Record<string, string> } | undefined;
    if (!w) continue;
    const ep = view.epochs.get(w.epoch);
    if (!ep || !(anc.get(e.id)!.has(ep.winner.id) || ep.winner.id === e.id)) continue;
    for (const [dev, h] of Object.entries(w.wraps)) {
      const s = ep.wraps.get(dev) ?? new Set<string>();
      s.add(h);
      ep.wraps.set(dev, s);
    }
  }
  const ctl = view.valid.filter((e) => e.p.kind === "control");
  view.controlTo = ctl.length > 0 ? String(ctl[ctl.length - 1]!.p.body.to) : null;
  return view;
}

/** 一个事件声明的纪元（新纪元；锚定事件另带升级前的旧纪元）。 */
function declsOf(e: StoredEvent): KeyDecl[] {
  const out: KeyDecl[] = [];
  const k = e.p.body.key as KeyDecl | undefined;
  if (k) out.push(k);
  if (e.p.kind === "anchor" && Array.isArray(e.p.body.legacy)) out.push(...(e.p.body.legacy as KeyDecl[]));
  return out;
}

/** 链上声明认可这一包裹（纪元胜者的声明或其后的追加里有这台设备的这一摘要）。 */
export function wrapDeclared(view: ChainView, epoch: number, wrappedFor: string, wrapped: string): boolean {
  return !!view.epochs.get(epoch)?.wraps.get(wrappedFor)?.has(wrapDigest(wrapped));
}

// ─── 投影写回 ───

/** 把链的投影写回 matter_members（链模式下它只是投影；作者签名列置空）。不在投影里的本机行标为已移出。 */
export function applyProjection(deps: ChainDeps, matterId: string, view: ChainView): void {
  const { db, tenantId } = deps;
  if (!view.root) return;
  for (const [user, st] of view.members) {
    const d = st.decider;
    db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?,?,?)`, [user, tenantId, user]);
    const local = db.get<{ matter_role: string; removed_at: string | null; author_device: string; row_lamport: number }>(
      `SELECT matter_role, removed_at, author_device, row_lamport FROM matter_members WHERE matter_id = ? AND user_id = ?`,
      [matterId, user],
    );
    const role = st.role ?? st.lastRole;
    const removedAt = st.role === null ? (local?.removed_at ?? d.p.at) : null;
    const removedL = st.role === null ? d.p.lamport : null;
    if (local && local.matter_role === role && (local.removed_at === null) === (removedAt === null) && local.author_device === d.p.author_device && local.row_lamport === d.p.lamport) continue;
    if (local) {
      db.run(
        `UPDATE matter_members SET matter_role = ?, added_by = ?, removed_at = ?, removed_lamport = ?, author_device = ?, row_lamport = ?, author_sig = NULL, author_cert = NULL,
           added_at = CASE WHEN removed_at IS NOT NULL AND ? IS NULL THEN ? ELSE added_at END
         WHERE matter_id = ? AND user_id = ?`,
        [role, d.member, removedAt, removedL, d.p.author_device, d.p.lamport, removedAt, nowIso(), matterId, user],
      );
    } else {
      db.run(
        `INSERT INTO matter_members (matter_id, user_id, matter_role, added_by, removed_at, removed_lamport, author_device, row_lamport) VALUES (?,?,?,?,?,?,?,?)`,
        [matterId, user, role, d.member, removedAt, removedL, d.p.author_device, d.p.lamport],
      );
    }
  }
  // 起点没有列出、链上也从未出现的本机行：按已移出处理（锚定者的成员关系为准）
  for (const r of db.all<{ user_id: string }>(`SELECT user_id FROM matter_members WHERE matter_id = ? AND removed_at IS NULL`, [matterId])) {
    if (view.members.has(r.user_id)) continue;
    db.run(`UPDATE matter_members SET removed_at = ?, removed_lamport = ?, author_sig = NULL, author_cert = NULL WHERE matter_id = ? AND user_id = ?`, [nowIso(), view.root.p.lamport, matterId, r.user_id]);
  }
}

// ─── 起点 ───

/**
 * 采用起点（本机还没有起点时）。本机已有起点时**一律不切换**（复核 S12A-01：同一作者编号更小的起点也不换——被移出的创建者可以再签一个）。
 * `bootstrap`：本机还没有这个事项（不看本机成员行）；否则（含“本机重新引导”，复核 S12A-03）作者须是本机成员行里在册的负责人。
 * `candidates`：只考虑这些事件（本段带来的起点——首同步与重新引导时不从以前存下的、可能是伪造的起点里挑）。
 * - genesis：作者成员 = creator，本机有事项行时另须 = 事项行的创建者；
 * - anchor：作者在锚定里列为在册负责人。
 */
export function adoptRoot(deps: ChainDeps, matterId: string, bootstrap: boolean, candidates?: Set<string>): StoredEvent | null {
  const { db } = deps;
  const current = db.get<{ root_id: string | null }>(`SELECT root_id FROM member_chain WHERE matter_id = ?`, [matterId]);
  if (current?.root_id) return loadEvents(db, matterId).find((e) => e.id === current.root_id) ?? null;
  const rows = loadEvents(db, matterId)
    .filter((e) => isRootKind(e.p.kind) && e.p.prev.length === 0 && e.p.lamport === 1 && (!candidates || candidates.has(e.id)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const e of rows) {
    if (!rootAcceptable(deps, matterId, e, bootstrap)) continue;
    db.run(`INSERT INTO member_chain (matter_id, root_id, adopted_at) VALUES (?,?,?) ON CONFLICT(matter_id) DO UPDATE SET root_id = excluded.root_id, adopted_at = excluded.adopted_at`, [matterId, e.id, nowIso()]);
    return e;
  }
  return null;
}

function rootAcceptable(deps: ChainDeps, matterId: string, e: StoredEvent, bootstrap: boolean): boolean {
  const { db } = deps;
  const b = e.p.body as { creator?: string; members: { user: string; role: string; removed?: boolean }[] };
  if (e.p.kind === "genesis") {
    if (e.member !== b.creator) return false;
    const createdBy = db.get<{ created_by: string }>(`SELECT created_by FROM matters WHERE matter_id = ?`, [matterId])?.created_by;
    if (createdBy && createdBy !== b.creator) return false;
  }
  else if (!b.members.some((m) => m.user === e.member && m.role === "owner" && !m.removed)) return false;
  if (bootstrap) return true;
  return !!db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND matter_role = 'owner' AND removed_at IS NULL`, [matterId, e.member]);
}

// ─── 写事件（本机） ───

/** 本机写一条事件（引用当前链头）。调用方须已确认本机成员是负责人（链会再按因果过去核一次）。 */
export function writeEvent(deps: ChainDeps, matterId: string, kind: EventKind, body: Record<string, unknown>, view?: ChainView): StoredEvent {
  const { db, keyctx, tenantId } = deps;
  const v = view ?? chainView(deps, matterId);
  const prev = isRootKind(kind) ? [] : [...v.heads].sort();
  if (!isRootKind(kind) && prev.length === 0) throw new Error(`事项 ${matterId} 的成员链没有可引用的链头`);
  const lamport = isRootKind(kind) ? 1 : Math.max(...prev.map((id) => v.events.get(id)!.p.lamport)) + 1;
  const p: MemberEventPayload = { v: MEMBER_EVENT_V, tenant: tenantId, matter_id: matterId, kind, prev, lamport, author_device: keyctx.device.deviceId, at: nowIso(), body };
  const id = eventIdOf(p);
  const e: StoredEvent = { id, p, sig: signSyncWith(keyctx.device.signer, sigBytes(id)), certJson: JSON.stringify(keyctx.device.cert), member: keyctx.device.cert.memberId, received: nowIso() };
  insertEvent(db, e, null);
  if (isRootKind(kind)) {
    db.run(`INSERT INTO member_chain (matter_id, root_id, adopted_at) VALUES (?,?,?) ON CONFLICT(matter_id) DO UPDATE SET root_id = excluded.root_id, adopted_at = excluded.adopted_at`, [matterId, id, nowIso()]);
  }
  return e;
}

/** 本机库里该事项某纪元全部包裹的摘要（设备或 recovery → 摘要）。 */
function localWraps(db: KernelDb, matterId: string, epoch: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.all<{ wrapped_for: string; wrapped_key: string }>(`SELECT wrapped_for, wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ?`, [matterId, epoch])) {
    out[r.wrapped_for] = wrapDigest(r.wrapped_key);
  }
  return out;
}

function ownKey(deps: ChainDeps, matterId: string, epoch: number): Uint8Array | null {
  const row = deps.db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [matterId, epoch, deps.keyctx.device.deviceId]);
  if (!row) return null;
  try {
    return unwrapMatterKey(row.wrapped_key, deps.keyctx.device.keys.encPrivateKeyPem);
  } catch {
    return null;
  }
}

/** 新建团队事项时的起点（纪元 1 的包裹已写入本机库）。 */
export function writeGenesis(deps: ChainDeps, matterId: string, creator: string, matterKey: Uint8Array): StoredEvent {
  const e = writeEvent(deps, matterId, "genesis", { creator, members: [{ user: creator, role: "owner" }], key: { epoch: 1, fp: keyFingerprint(matterKey), wraps: localWraps(deps.db, matterId, 1) } });
  applyProjection(deps, matterId, chainView(deps, matterId));
  return e;
}

/**
 * 存量事项锚定：本机在册负责人把现有成员关系（含已移出的）与当前纪元（及本机持有的旧纪元）重新签署一次，作为链的起点。
 * 本机没有当前纪元的密钥时不锚定（返回 null）。
 */
export function writeAnchor(deps: ChainDeps, matterId: string): StoredEvent | null {
  const { db } = deps;
  const members = db.all<{ user_id: string; matter_role: string; removed_at: string | null }>(`SELECT user_id, matter_role, removed_at FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [matterId]);
  if (!members.some((m) => m.user_id === deps.keyctx.device.cert.memberId && m.matter_role === "owner" && !m.removed_at)) return null;
  const epoch = db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [matterId, deps.keyctx.device.deviceId])?.e ?? null;
  if (!epoch) return null;
  const key = ownKey(deps, matterId, epoch);
  if (!key) return null;
  const legacy: KeyDecl[] = [];
  for (const r of db.all<{ epoch: number }>(`SELECT DISTINCT epoch FROM matter_keys WHERE matter_id = ? AND epoch < ? ORDER BY epoch`, [matterId, epoch])) {
    const k = ownKey(deps, matterId, r.epoch);
    legacy.push({ epoch: r.epoch, fp: k ? keyFingerprint(k) : null, wraps: localWraps(db, matterId, r.epoch) });
  }
  const e = writeEvent(deps, matterId, "anchor", {
    members: members.map((m) => ({ user: m.user_id, role: m.matter_role, removed: !!m.removed_at })),
    key: { epoch, fp: keyFingerprint(key), wraps: localWraps(db, matterId, epoch) },
    ...(legacy.length > 0 ? { legacy } : {}),
  });
  applyProjection(deps, matterId, chainView(deps, matterId));
  return e;
}

/** 链模式下当前纪元（链上声明的最高纪元；本机持有面向自己包裹的最高纪元另见 sync-engine）。 */
export function chainEpoch(view: ChainView): number {
  return view.maxEpoch;
}

/** 在用、未吊销的设备（成员 → 设备编号与加密公钥）。 */
function liveDevicesOf(db: KernelDb, tenantId: string, users: string[]): { device_id: string; enc_pub_pem: string; member_id: string }[] {
  if (users.length === 0) return [];
  return db
    .all<{ device_id: string; enc_pub_pem: string; member_id: string }>(
      `SELECT device_id, enc_pub_pem, member_id FROM devices WHERE tenant_id = ? AND status = 'active' AND member_id IN (${users.map(() => "?").join(",")})`,
      [tenantId, ...users],
    )
    .filter((d) => !deviceTombstoned(db, d.device_id));
}

/**
 * 轮换到新纪元（链模式）：新密钥只包裹给投影里未移出成员的在用设备（减去 exclude）+ 恢复托管；新纪元号高于链上与本机见过的全部纪元。
 * `memberChange` 给出时与成员变更写在同一事件里（移出即轮换）。在调用方的事务里执行。
 */
export function rotateChainKey(
  deps: ChainDeps,
  matterId: string,
  o: { reason: string; exclude?: Set<string>; memberChange?: { user: string; role: string | null } },
): { epoch: number; wrapped: number; event: StoredEvent } {
  const { db, keyctx, tenantId } = deps;
  writeDueMarks(deps, matterId);
  const view = chainView(deps, matterId);
  const localMax = db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ?`, [matterId])?.e ?? 0;
  const epoch = Math.max(view.maxEpoch, localMax) + 1;
  const members = new Map([...view.members].map(([u, s]) => [u, s.role]));
  if (o.memberChange) members.set(o.memberChange.user, o.memberChange.role);
  const users = [...members].filter(([, r]) => r !== null).map(([u]) => u);
  const devices = liveDevicesOf(db, tenantId, users).filter((d) => !o.exclude?.has(d.device_id));
  const key = generateMatterKey();
  for (const d of devices) db.run(`INSERT OR REPLACE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [matterId, epoch, d.device_id, wrapMatterKey(key, d.enc_pub_pem)]);
  db.run(`INSERT OR REPLACE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,'recovery',?)`, [matterId, epoch, wrapMatterKey(key, keyctx.firm.recoveryPublicKeyPem)]);
  db.run(`INSERT OR IGNORE INTO key_epochs (scope, scope_id, epoch, reason) VALUES ('matter', ?, ?, ?)`, [matterId, epoch, o.reason.slice(0, 300)]);
  const decl: KeyDecl = { epoch, fp: keyFingerprint(key), wraps: localWraps(db, matterId, epoch) };
  const event = o.memberChange
    ? writeEvent(deps, matterId, "member", { user: o.memberChange.user, role: o.memberChange.role, key: decl }, view)
    : writeEvent(deps, matterId, "rekey", { key: decl, reason: o.reason.slice(0, 300) }, view);
  // 轮换出新纪元：本机的纪元告警随之解除（并发轮换的出路，沿用第七轮 S11B-55）
  db.run(`DELETE FROM sync_alerts WHERE matter_id = ? AND kind IN ('epoch_conflict', 'epoch_superseded', 'rekey_needed')`, [matterId]);
  applyProjection(deps, matterId, chainView(deps, matterId));
  return { epoch, wrapped: devices.length, event };
}

/**
 * 加人或改角色（链模式）：成员事件带对方在用设备在当前纪元的包裹（本机须持有当前纪元密钥）。在调用方的事务里执行。
 */
export function addOrUpdateMember(deps: ChainDeps, matterId: string, user: string, role: string, extraDevices: { device_id: string; enc_pub_pem: string }[] = []): { epoch: number; wrapped: number } {
  const { db, keyctx, tenantId } = deps;
  writeDueMarks(deps, matterId);
  const view = chainView(deps, matterId);
  const epoch = ownEpoch(db, matterId, keyctx.device.deviceId);
  const key = ownKey(deps, matterId, epoch);
  const devs = [...new Map([...liveDevicesOf(db, tenantId, [user]), ...extraDevices].map((d) => [d.device_id, d])).values()];
  const wraps: Record<string, string> = {};
  if (key) {
    for (const d of devs) {
      const existing = db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [matterId, epoch, d.device_id]);
      const w = existing && wrapDeclared(view, epoch, d.device_id, existing.wrapped_key) ? existing.wrapped_key : wrapMatterKey(key, d.enc_pub_pem);
      db.run(`INSERT OR REPLACE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [matterId, epoch, d.device_id, w]);
      if (!wrapDeclared(view, epoch, d.device_id, w)) wraps[d.device_id] = wrapDigest(w);
    }
  }
  writeEvent(deps, matterId, "member", { user, role, ...(Object.keys(wraps).length > 0 ? { wraps: { epoch, wraps } } : {}) }, view);
  applyProjection(deps, matterId, chainView(deps, matterId));
  return { epoch, wrapped: key ? devs.length : 0 };
}

/** 本机持有面向自己包裹的最高纪元。 */
function ownEpoch(db: KernelDb, matterId: string, deviceId: string): number {
  return db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [matterId, deviceId])?.e ?? 1;
}

// ─── 收包裹 ───

/**
 * 链模式下段里的包裹行落库：链上声明认可的才收；面向本机的另须解开后指纹 = 该纪元胜出声明的指纹（旧纪元没有指纹的只看摘要）。
 * 本机已有该纪元的另一把（分叉的输家）且收到胜者的 → 替换，返回 replacedSelf（调用方据此重发本机写的内容）。
 */
export function acceptKeyRows(
  deps: ChainDeps,
  matterId: string,
  view: ChainView,
  keyRows: { matter_id: string; epoch: number; wrapped_for: string; wrapped_key: string; created_at?: string }[],
): { stored: number; replacedSelf: number[] } {
  const { db, keyctx } = deps;
  const me = keyctx.device.deviceId;
  let stored = 0;
  const replacedSelf: number[] = [];
  for (const kr of keyRows) {
    if (kr.matter_id !== matterId || !Number.isSafeInteger(kr.epoch) || kr.epoch < 1 || typeof kr.wrapped_key !== "string") continue;
    if (!wrapDeclared(view, kr.epoch, kr.wrapped_for, kr.wrapped_key)) continue;
    const fp = view.epochs.get(kr.epoch)!.decl.fp;
    if (kr.wrapped_for === me && fp) {
      let k: Uint8Array | null = null;
      try {
        k = unwrapMatterKey(kr.wrapped_key, keyctx.device.keys.encPrivateKeyPem);
      } catch {
        k = null;
      }
      if (!k || keyFingerprint(k) !== fp) continue;
    }
    const had = db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [matterId, kr.epoch, kr.wrapped_for]);
    if (had?.wrapped_key === kr.wrapped_key) continue;
    if (had) {
      // 本机已有的那一行：链上认可（面向本机的另核指纹）就不换
      if (kr.wrapped_for === me) {
        const k = ownKey(deps, matterId, kr.epoch);
        if (k && (!fp || keyFingerprint(k) === fp)) continue;
      } else if (wrapDeclared(view, kr.epoch, kr.wrapped_for, had.wrapped_key)) continue;
      db.run(`UPDATE matter_keys SET wrapped_key = ? WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [kr.wrapped_key, matterId, kr.epoch, kr.wrapped_for]);
      if (kr.wrapped_for === me) replacedSelf.push(kr.epoch);
      stored += 1;
      continue;
    }
    db.run(`INSERT INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key, created_at) VALUES (?,?,?,?,?)`, [matterId, kr.epoch, kr.wrapped_for, kr.wrapped_key, kr.created_at ?? nowIso()]);
    stored += 1;
  }
  return { stored, replacedSelf };
}

/** 段解密用的、来自段里的面向本机包裹，链上是否认可（含指纹）。 */
export function segmentKeyDeclared(deps: ChainDeps, view: ChainView, epoch: number, wrapped: string, key: Uint8Array): boolean {
  if (!wrapDeclared(view, epoch, deps.keyctx.device.deviceId, wrapped)) return false;
  const fp = view.epochs.get(epoch)!.decl.fp;
  return !fp || keyFingerprint(key) === fp;
}

/** 本机该纪元的密钥是不是链上的胜者（没有声明或没有指纹时视为是）。 */
export function ownKeyIsWinner(deps: ChainDeps, matterId: string, view: ChainView, epoch: number): boolean {
  const fp = view.epochs.get(epoch)?.decl.fp;
  if (!fp) return true;
  const k = ownKey(deps, matterId, epoch);
  return !k || keyFingerprint(k) === fp;
}

/** 这台设备是不是某纪元分叉的输家（它的段用输家的密钥加密，胜者的密钥解不开——静默略过，不记告警）。 */
export function deviceLostEpoch(view: ChainView, epoch: number, deviceId: string): boolean {
  return !!view.epochs.get(epoch)?.losers.some((e) => e.p.author_device === deviceId);
}

// ─── 告警与自动处置 ───

export type ChainAlertKind = "chain_pending" | "rekey_needed" | "epoch_superseded" | "root_conflict";

export interface ChainHealth {
  pendingRevoked: StoredEvent[];
  pendingMissing: StoredEvent[];
  rekeyNeeded: boolean;
  superseded: boolean;
  rootConflict: StoredEvent | null;
}

/** 判断该事项链的健康状况（不写库）。 */
export function chainHealth(deps: ChainDeps, matterId: string, view: ChainView): ChainHealth {
  const { db, keyctx } = deps;
  const h: ChainHealth = { pendingRevoked: [], pendingMissing: [], rekeyNeeded: false, superseded: false, rootConflict: null };
  if (!view.root) return h;
  const effectiveMembers = new Set([...view.members].filter(([, s]) => s.role !== null).map(([u]) => u));
  for (const e of view.events.values()) {
    const st = view.status.get(e.id);
    if (st?.s !== "pending") continue;
    if (st.why === "revoked_unvouched" || (st.why === "parent_pending" && [...(view.anc.get(e.id) ?? [])].some((x) => (view.status.get(x) as any)?.why === "revoked_unvouched"))) h.pendingRevoked.push(e);
    else {
      // 缺前序：只有作者是本链在册负责人、且经本链在册成员转发来的才算——成员或所内任意设备伪造缺前序的事件不能让全员停发
      const via = db.get<{ via_member: string | null }>(`SELECT via_member FROM member_events WHERE event_id = ?`, [e.id])?.via_member;
      if (via && effectiveMembers.has(via) && view.members.get(e.member)?.role === "owner") h.pendingMissing.push(e);
    }
  }
  // 起点冲突：别的起点本身按起点规则可以采用（创建者的创世、在册负责人的锚定）——成员伪造的起点只计不停
  // 同一作者的另一个起点也算（同一人两台设备各自锚定；不自动切换，复核 S12A-01）；按本机投影作者须是在册负责人——被移出的创建者再签的创世只计不停
  h.rootConflict = view.foreignRoots.find((r) => rootAcceptable(deps, matterId, r, false)) ?? null;
  // 当前最高纪元的包裹里还有已移出成员（或不再是成员）的设备
  const top = view.epochs.get(view.maxEpoch);
  if (top) {
    for (const dev of top.wraps.keys()) {
      if (dev === "recovery") continue;
      const m = db.get<{ member_id: string }>(`SELECT member_id FROM devices WHERE device_id = ?`, [dev])?.member_id;
      if (m && !effectiveMembers.has(m)) {
        h.rekeyNeeded = true;
        break;
      }
    }
  }
  // 本机持有的最高纪元的密钥是分叉的输家
  const mine = db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [matterId, keyctx.device.deviceId])?.e ?? 0;
  if (mine > 0 && !ownKeyIsWinner(deps, matterId, view, mine)) h.superseded = true;
  return h;
}

/** 按链的健康状况重写该事项的链告警（sync_alerts；有告警即暂停发出，沿用第六轮的失败即关闭）。 */
export function refreshChainAlerts(deps: ChainDeps, matterId: string, h: ChainHealth): void {
  const { db } = deps;
  const want = new Map<ChainAlertKind, { detail: string; peerDevice: string | null; peerMember: string | null }>();
  if (h.pendingRevoked.length > 0) {
    const e = h.pendingRevoked[0]!;
    want.set("chain_pending", { detail: `已停用设备 ${e.p.author_device} 写的 ${h.pendingRevoked.length} 条成员事件还没有在用的负责人设备确认`, peerDevice: e.p.author_device, peerMember: e.member });
  } else if (h.pendingMissing.length > 0) {
    const e = h.pendingMissing[0]!;
    want.set("chain_pending", { detail: `${h.pendingMissing.length} 条成员事件缺少前序事件，等待其余同步段`, peerDevice: e.p.author_device, peerMember: e.member });
  }
  if (h.rekeyNeeded) want.set("rekey_needed", { detail: "当前纪元的密钥包裹里仍有已移出成员的设备，等待负责人轮换", peerDevice: null, peerMember: null });
  if (h.superseded) want.set("epoch_superseded", { detail: "本机当前纪元的密钥在并发轮换中落选，等待采用胜出的密钥或再次轮换", peerDevice: null, peerMember: null });
  if (h.rootConflict) want.set("root_conflict", { detail: `收到与本机不同的成员链起点（作者 ${h.rootConflict.member}）`, peerDevice: h.rootConflict.p.author_device, peerMember: h.rootConflict.member });
  const kinds: ChainAlertKind[] = ["chain_pending", "rekey_needed", "epoch_superseded", "root_conflict"];
  const at = nowIso();
  for (const k of kinds) {
    const w = want.get(k);
    if (!w) {
      db.run(`DELETE FROM sync_alerts WHERE matter_id = ? AND kind = ?`, [matterId, k]);
      continue;
    }
    db.run(
      `INSERT INTO sync_alerts (matter_id, kind, epoch, detail, first_at, last_at, hits, peer_device, peer_member) VALUES (?,?,0,?,?,?,1,?,?)
       ON CONFLICT(matter_id, kind, epoch) DO UPDATE SET detail = excluded.detail, last_at = excluded.last_at, peer_device = excluded.peer_device, peer_member = excluded.peer_member`,
      [matterId, k, w.detail.slice(0, 300), at, at, w.peerDevice, w.peerMember],
    );
  }
  // 链模式下不再用第 11 批的两种告警（由链判断）
  db.run(`DELETE FROM sync_alerts WHERE matter_id = ? AND kind IN ('epoch_conflict', 'owner_unverifiable')`, [matterId]);
}

/**
 * 吊销标记（本机是在用的负责人设备时）：给链上写过事件、已被吊销、还没有在用设备给它写过标记的设备各写一条。
 * 被吊销设备在吊销时刻之前本机收下的事件按在用对待、取此刻的链头——这些事件由标记固定下来；吊销之后才收到的不固定。
 * 本机任何成员链写入之前都先调用（否则本机得知吊销后写的事件不再引用这些事件，本机的负责人身份可能随之不成立）。返回是否写了。
 */
export function writeDueMarks(deps: ChainDeps, matterId: string): boolean {
  const { db, keyctx } = deps;
  if (!hasChain(db, matterId) || deviceRevoked(db, keyctx.device.deviceId)) return false;
  const view = chainView(deps, matterId);
  const markedBy = new Set(view.valid.filter((e) => e.p.kind === "mark" && !deviceRevoked(db, e.p.author_device)).map((e) => String(e.p.body.device)));
  const authors = new Set([...view.events.values()].filter((e) => view.status.get(e.id)?.s !== "rejected").map((e) => e.p.author_device));
  const due = [...authors].sort().filter((d) => d !== keyctx.device.deviceId && !markedBy.has(d) && deviceRevoked(db, d));
  if (due.length === 0) return false;
  const liveBefore = new Map<string, string>();
  for (const d of due) {
    const t = revokedAtOf(db, d);
    if (t) liveBefore.set(d, t);
  }
  // 本机是否负责人按“吊销之前收下的事件仍有效”判断（交接给本机的那条事件可能正是被吊销设备写的）
  const optimistic = chainView(deps, matterId, { liveBefore });
  if (optimistic.members.get(keyctx.device.cert.memberId)?.role !== "owner") return false;
  db.tx(() => {
    for (const d of due) writeEvent(deps, matterId, "mark", { device: d }, chainView(deps, matterId, { liveBefore }));
    applyProjection(deps, matterId, chainView(deps, matterId));
  });
  return true;
}

/**
 * 本机成员操作之前：补写到期的吊销标记并刷新投影（权限检查读的是投影）。
 */
export function refreshChain(deps: ChainDeps, matterId: string): void {
  if (!hasChain(deps.db, matterId)) return;
  if (!writeDueMarks(deps, matterId)) applyProjection(deps, matterId, chainView(deps, matterId));
}

/**
 * 链的自动处置（导出前、摄取后调用）：
 * - 本机是在用的负责人设备：给链上写过事件、已被吊销、还没有标记的设备写吊销标记（引用本机得知吊销之前收下的事件）；
 * - 当前纪元仍包裹给已移出成员、或本机当前纪元的密钥落选：本机可以轮换（`mayRotate`：中继事项须是控制成员）即轮换；
 * - 最后按健康状况重写告警。
 * 返回本机是否写了新事件（调用方据此决定是否需要重发）。
 */
export function maintainChain(deps: ChainDeps, matterId: string, o: { mayRotate: boolean; rotator?: string | null }): { wrote: boolean; rotated: boolean } {
  const { db, keyctx, tenantId } = deps;
  let wrote = false;
  let rotated = false;
  if (!hasChain(db, matterId)) return { wrote, rotated };
  if (writeDueMarks(deps, matterId)) wrote = true;
  let view = chainView(deps, matterId);
  let h = chainHealth(deps, matterId, view);
  const me = keyctx.device.cert.memberId;
  // 自动处置只由一位成员做（否则几位负责人同时补轮换又分叉）：中继事项为控制成员，否则为当前纪元胜出声明的作者（仍是负责人时），再否则成员编号最小的负责人
  const rotator = o.rotator ?? defaultRotator(view);
  const iRotate = rotator === me && view.members.get(me)?.role === "owner" && o.mayRotate && !deviceRevoked(db, keyctx.device.deviceId) && h.pendingRevoked.length === 0 && h.pendingMissing.length === 0;
  if (h.rekeyNeeded && iRotate) {
    db.tx(() => rotateChainKey(deps, matterId, { reason: "member_log.rekey_removed" }));
    wrote = true;
    rotated = true;
    view = chainView(deps, matterId);
    h = chainHealth(deps, matterId, view);
  } else if (iRotate && !h.superseded) {
    // 在册成员的在用设备在当前纪元没有包裹（并发加人与轮换、成员后登记的新设备）：补包裹
    const top = view.epochs.get(view.maxEpoch);
    const key = top ? ownKey(deps, matterId, view.maxEpoch) : null;
    if (top && key && ownKeyIsWinner(deps, matterId, view, view.maxEpoch)) {
      const users = [...view.members].filter(([, s]) => s.role !== null).map(([u]) => u);
      const missing = liveDevicesOf(db, tenantId, users).filter((d) => !top.wraps.has(d.device_id));
      if (missing.length > 0) {
        db.tx(() => {
          const wraps: Record<string, string> = {};
          for (const d of missing) {
            const w = wrapMatterKey(key, d.enc_pub_pem);
            db.run(`INSERT OR REPLACE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [matterId, view.maxEpoch, d.device_id, w]);
            wraps[d.device_id] = wrapDigest(w);
          }
          writeEvent(deps, matterId, "wrap", { wraps: { epoch: view.maxEpoch, wraps } }, view);
        });
        wrote = true;
        view = chainView(deps, matterId);
        h = chainHealth(deps, matterId, view);
      }
    }
  }
  refreshChainAlerts(deps, matterId, h);
  return { wrote, rotated };
}

/** 缺省的自动处置者：当前纪元胜出声明的作者（仍是负责人时），否则成员编号最小的负责人。 */
function defaultRotator(view: ChainView): string | null {
  const top = view.epochs.get(view.maxEpoch);
  if (top && view.members.get(top.winner.member)?.role === "owner") return top.winner.member;
  return [...view.members].filter(([, s]) => s.role === "owner").map(([u]) => u).sort()[0] ?? null;
}

/**
 * 本机重新引导该事项（人工）：清掉本机的成员链与已摄取标记，下次收到时按首同步规则重新采用起点（中继仍只从控制成员签发的段引导）。
 * 成员投影保留为当前视图直到新起点被采用；内容与密钥不动。
 */
export function rebootstrapMatter(db: KernelDb, matterId: string): void {
  db.tx(() => {
    db.run(`DELETE FROM member_events WHERE matter_id = ?`, [matterId]);
    db.run(`INSERT INTO member_chain (matter_id, root_id, adopted_at) VALUES (?, NULL, ?) ON CONFLICT(matter_id) DO UPDATE SET root_id = NULL, adopted_at = excluded.adopted_at`, [matterId, nowIso()]);
    db.run(`DELETE FROM sync_segments_seen WHERE matter_id = ?`, [matterId]);
    db.run(`DELETE FROM sync_alerts WHERE matter_id = ?`, [matterId]);
    // 重新采用起点之前暂停发出该事项（复核 S12A-04：原先清掉告警即解除暂停，被移出者能读到这期间的内容）；采用起点后由链的告警重算清除
    const at = nowIso();
    db.run(`INSERT INTO sync_alerts (matter_id, kind, epoch, detail, first_at, last_at, hits) VALUES (?, 'chain_pending', 0, ?, ?, ?, 1)`, [matterId, "本机正在重新引导该事项，收到负责人的成员链之前暂停发出", at, at]);
  });
}

/** 界面与状态用：该事项链的概况。 */
export function chainSummary(deps: ChainDeps, matterId: string): { anchored: boolean; rebootstrap: boolean; events: number; valid: number; pending: number; epoch: number; control_to: string | null } {
  const { db } = deps;
  if (!hasChain(db, matterId)) return { anchored: false, rebootstrap: rebootstrapPending(db, matterId), events: 0, valid: 0, pending: 0, epoch: 0, control_to: null };
  const v = chainView(deps, matterId);
  return {
    anchored: true,
    rebootstrap: false,
    events: v.events.size,
    valid: v.valid.length,
    pending: [...v.status.values()].filter((s) => s.s === "pending").length,
    epoch: v.maxEpoch,
    control_to: v.controlTo,
  };
}
