/**
 * 期限提醒（第 10 批；v9 #51“期限类型、事项代号与文案用接收人设备公钥加密，App/电脑本地解密显示；关机不漏”、K7“期限提醒云端调度、
 * 与 Agent 定时分开”；v9.2 §5.1 S9；调研 Y2 §3.9）。
 *
 * 一条提醒 = 事项 + 期限类型 + 期限日 + 提前几天、几点提醒 + 备注 + 通知谁（只提醒我 / 事项成员）。
 * - **本机**：内核每次巡检把到时的本人提醒放进“收到的提醒”并通知界面——不依赖云端（未配置通知服务、离线、退出模式都照常）；
 * - **云端**（配置了通知服务与控制面时）：把提醒交中软通知服务调度，电脑关机时本人的其他设备与事项成员的设备照常收到。
 *   交给云端的只有触发时刻（到分钟）、接收设备编号与每台设备一份密文：密文 = 发出设备签名的提醒正文，用接收设备的 X25519 公钥加密，
 *   附加数据绑定（租户、提醒编号、版本、接收设备）——云端解不开，也不能把一份密文挪给别的提醒或别的设备；
 *   接收设备核对发出设备的签名（本机目录里在用、未吊销的设备）、编号、版本与触发时刻一致才收下。
 * - 改动 = 版本号 + 1 后整条重新登记（旧版本作废）；撤销与事项删除 = 云端删除（云端留墓碑，旧版本不能复活）。
 * - 两路复核（第 10 批 S10A/S10B）后：本机通知不依赖云端；云端失败按退避重试（撤销与删除永不放弃，直到云端副本自行过期）；
 *   同一版本的密文缓存后原样重发；接收设备或密钥变化即重登；收件核对整体防御、暂时不能判断的请云端暂缓、24 小时后丢弃；明文填充到固定长度。
 * 不做（如实）：手机推送（G2 App）、IM 提醒（G1 端侧）、按工作日顺延与法定期间计算（期限日由律师填写）。
 */
import { createHash, randomBytes } from "node:crypto";
import { canonicalJson, openForDevice, sealForDevice, verifyBytes, type DeviceSyncSigner } from "@zr-legal/keys";
import type { NotifyRelayRequest, NotifyRelayResult } from "@zr-legal/egress-gate";
import { DomainError } from "@zr-legal/domain";
import { errFields, slog } from "@zr-legal/safe-log";
import type { KernelDb } from "../db.ts";
import { nowIso } from "../db.ts";

export const REMINDER_KINDS = ["hearing", "evidence", "appeal", "limitation", "contract", "filing", "other"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
export const REMINDER_NOTE_MAX = 200;
export const REMINDER_DAYS_MAX = 60;
/** 每条提醒至多发给多少台设备（与通知服务一致）。 */
export const REMINDER_MAX_TARGETS = 50;
/** 云端只收最早 1 天前的触发时刻：更早的提醒只在本机响。 */
const CLOUD_PAST_LIMIT_MS = 23 * 3600_000;
const AAD_PREFIX = "kwl-notify/1";
const BODY_FORMAT = "kwl-reminder/1";

export interface ReminderBody {
  f: typeof BODY_FORMAT;
  tid: string;
  rid: string;
  ver: number;
  matter_id: string;
  kind: ReminderKind;
  due_date: string;
  remind_at: string;
  note: string;
  audience: "me" | "team";
  from_dev: string;
  from_member: string;
  issued_at: string;
}

export interface ReminderRow {
  reminder_id: string;
  tenant_id: string;
  matter_id: string;
  created_by: string;
  kind: ReminderKind;
  due_date: string;
  remind_at: string;
  days_before: number;
  remind_time: string;
  note: string;
  audience: "me" | "team";
  version: number;
  status: "active" | "cancelled";
  cloud_state: "local" | "pending" | "synced" | "failed" | "cancel_pending" | "cancelled";
  cloud_error: string | null;
  cloud_targets: number | null;
  created_at: string;
  updated_at: string;
}

export interface ReminderInput {
  matter_id: string;
  kind: ReminderKind;
  due_date: string;
  days_before: number;
  remind_time: string;
  note: string;
  audience: "me" | "team";
}

export interface ReminderServiceDeps {
  db: KernelDb;
  tenantId: string;
  userId: string;
  deviceId: string;
  encPrivateKeyPem: string;
  signer: DeviceSyncSigner;
  /** 通知通道是否已配置（通知服务地址 + 控制面）。 */
  cloudConfigured: () => boolean;
  /** 退出模式等：不做云端操作（本机提醒照常）。 */
  suspended: () => boolean;
  /** 通知专用凭据（控制面签发）。 */
  credential: () => Promise<{ token: string; expiresAt: number }>;
  relay: (req: NotifyRelayRequest) => Promise<NotifyRelayResult>;
  /** 有新的到时提醒（本机或云端）时调用：界面刷新并发系统通知。 */
  onDue: (count: number) => void;
  /** 签名审计（建立、改动、撤销）。 */
  audit: (action: string, reminderId: string, matterId: string) => void;
  now?: () => number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const BJ_OFFSET_MS = 8 * 3600_000;

/** 北京时间的期限日与提醒时刻 → UTC 触发时刻（到分钟）。 */
export function remindAtOf(dueDate: string, daysBefore: number, time: string): string {
  const [y, m, d] = dueDate.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, d - daysBefore, hh, mm) - BJ_OFFSET_MS).toISOString();
}

/** 期限日在北京时间的那一天结束之前都算“未过”。 */
function dueDateEndMs(dueDate: string): number {
  const [y, m, d] = dueDate.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d + 1) - BJ_OFFSET_MS;
}

function cleanNote(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new DomainError("validation", "备注须为文字", 422);
  const s = v.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  if ([...s].length > REMINDER_NOTE_MAX) throw new DomainError("validation", `备注不超过 ${REMINDER_NOTE_MAX} 字`, 422);
  return s;
}

/** 入参校验（不含事项权限，权限由调用方先查）。 */
export function parseReminderInput(p: Record<string, unknown> | null | undefined, now: number): ReminderInput {
  const kind = p?.kind;
  if (typeof kind !== "string" || !(REMINDER_KINDS as readonly string[]).includes(kind)) throw new DomainError("validation", "请选择期限类型", 422);
  const due = p?.due_date;
  if (typeof due !== "string" || !DATE_RE.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`)) || new Date(`${due}T00:00:00Z`).toISOString().slice(0, 10) !== due) {
    throw new DomainError("validation", "期限日格式应为 2026-11-30", 422);
  }
  if (dueDateEndMs(due) <= now) throw new DomainError("validation", "这个期限日已经过了", 422);
  if (dueDateEndMs(due) > now + 3 * 365 * 86_400_000) throw new DomainError("validation", "期限日不能晚于三年后", 422);
  const days = p?.days_before === undefined ? 3 : p.days_before;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > REMINDER_DAYS_MAX) throw new DomainError("validation", `提前天数须为 0～${REMINDER_DAYS_MAX} 的整数`, 422);
  const time = p?.remind_time === undefined ? "09:00" : p.remind_time;
  if (typeof time !== "string" || !TIME_RE.test(time)) throw new DomainError("validation", "提醒时间格式应为 09:00", 422);
  const audience = p?.audience === undefined ? "me" : p.audience;
  if (audience !== "me" && audience !== "team") throw new DomainError("validation", "通知对象只能是“只提醒我”或“事项成员”", 422);
  const matterId = p?.matter_id;
  if (typeof matterId !== "string" || !matterId) throw new DomainError("validation", "缺少事项", 422);
  return { matter_id: matterId, kind: kind as ReminderKind, due_date: due, days_before: days, remind_time: time, note: cleanNote(p?.note), audience };
}

export function reminderAad(tid: string, rid: string, ver: number, dev: string): string {
  return `${AAD_PREFIX}\n${tid}\n${rid}\n${ver}\n${dev}`;
}

function bodyBytes(b: ReminderBody): Uint8Array {
  return new TextEncoder().encode(canonicalJson(b));
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}


/** 加密前把明文填充到固定长度（复核 S10A-05、S10B-18：密文长度不再泄露期限类型、通知对象与备注长短）。 */
export const REMINDER_PLAIN_BYTES = 2048;
/** 暂时不能判断的条目最多暂缓 24 小时，之后判不合格（复核 S10A-03、S10B-15）。 */
const HOLD_LIMIT_MS = 24 * 3600_000;
const HOLD_RETRY_MS = 10 * 60_000;
/** 提前送达的容差（复核 S10A-11）。 */
const EARLY_TOLERANCE_MS = 5 * 60_000;
/** 可重试失败的退避：1 分钟起翻倍，最长 1 小时。 */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3600_000;
/** 取凭据失败后暂停 5 分钟（复核 S10B-10、S10A-13：不在控制面刷出签发流水）。 */
const CREDENTIAL_BACKOFF_MS = 5 * 60_000;
const CLOUD_RETENTION_MS = 7 * 24 * 3600_000;
/** 事项删除后提醒行的占位（只留编号、版本与云端删除所需的字段；复核 S10B-14）。 */
const PURGED_DATE = "1970-01-01";
const PURGED_AT = "1970-01-01T00:00:00.000Z";

/** 闸门或网络层面的失败：本轮云端操作到此为止（复核 S10B-09）。 */
function networkClass(reason: string): boolean {
  return (
    reason.startsWith("credential:") ||
    reason.startsWith("gate_") ||
    reason.startsWith("notify_tls") ||
    reason.startsWith("notify_upstream") ||
    ["notify_timeout", "notify_unreachable", "notify_connect_failed", "notify_bad_reply", "notify_not_configured", "notify_response_too_large"].includes(reason)
  );
}

type RoundResult = { local: number; cloud: number };
type Verdict = { v: "added" | "dup" } | { v: "rejected"; reason: string } | { v: "hold"; reason: string; until: number };

export class ReminderService {
  readonly #d: ReminderServiceDeps;
  #cred: { token: string; expiresAt: number } | null = null;
  #credFailUntil = 0;
  #forcedThisRound = false;
  #running: Promise<RoundResult> | null = null;
  #queued: Promise<RoundResult> | null = null;
  /** 最近一次云端往返的结果（界面“云端提醒”状态一句话）。 */
  lastCloud: { at: string; ok: boolean; code: string | null } | null = null;

  constructor(d: ReminderServiceDeps) {
    this.#d = d;
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  get cloudConfigured(): boolean {
    return this.#d.cloudConfigured();
  }

  /** 接收设备：只提醒我 = 本人在用的设备；事项成员 = 事项现有成员在用的设备（不含所内节点与已吊销、墓碑设备）。 */
  recipients(matterId: string, audience: "me" | "team"): { device_id: string; enc_pub_pem: string }[] {
    const members =
      audience === "me"
        ? [this.#d.userId]
        : this.#d.db.all<{ user_id: string }>(`SELECT user_id FROM matter_members WHERE matter_id = ? AND removed_at IS NULL`, [matterId]).map((r) => r.user_id);
    if (!members.includes(this.#d.userId)) members.push(this.#d.userId);
    const rows = this.#d.db.all<{ device_id: string; enc_pub_pem: string; member_id: string }>(
      `SELECT device_id, enc_pub_pem, member_id FROM devices
        WHERE tenant_id = ? AND status = 'active' AND role <> 'node'
          AND device_id NOT IN (SELECT device_id FROM cp_revoked_devices WHERE tenant_id = ?)
          AND member_id IN (${members.map(() => "?").join(",")})
        ORDER BY (device_id = ?) DESC, (member_id = ?) DESC, member_id, device_id`,
      [this.#d.tenantId, this.#d.tenantId, ...members, this.#d.deviceId, this.#d.userId],
    );
    return rows.slice(0, REMINDER_MAX_TARGETS).map(({ device_id, enc_pub_pem }) => ({ device_id, enc_pub_pem }));
  }

  /** 登记指纹：接收设备与其加密公钥、本设备签名公钥——任何一项变化即须升版本重登（复核 S10A-04/06、S10B-11）。 */
  #fingerprint(targets: { device_id: string; enc_pub_pem: string }[]): string {
    const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
    return JSON.stringify({ s: h(this.#d.signer.publicKeyPem), t: targets.map((t) => [t.device_id, h(t.enc_pub_pem)]) });
  }

  /** 新建（调用方已核对事项写权限）。 */
  create(input: ReminderInput): ReminderRow {
    const rid = `rmd_${randomBytes(12).toString("hex")}`;
    const at = nowIso();
    const remindAt = this.#clampRemindAt(remindAtOf(input.due_date, input.days_before, input.remind_time));
    this.#d.db.run(
      `INSERT INTO reminders (reminder_id, tenant_id, matter_id, created_by, kind, due_date, remind_at, days_before, remind_time, note, audience, version, status, cloud_state,
         cloud_expire_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?,?)`,
      [rid, this.#d.tenantId, input.matter_id, this.#d.userId, input.kind, input.due_date, remindAt, input.days_before, input.remind_time, input.note, input.audience, this.#activeCloudState(remindAt), this.#expireOf(remindAt, null), at, at],
    );
    this.#d.audit("reminder.create", rid, input.matter_id);
    return this.get(rid)!;
  }

  /** 改动：版本号 + 1，整条重新登记。只有建立者本人可以改。 */
  update(rid: string, input: ReminderInput): ReminderRow {
    const cur = this.#own(rid);
    if (cur.status !== "active") throw new DomainError("conflict", "这条提醒已撤销，不能再改", 409);
    if (cur.matter_id !== input.matter_id) throw new DomainError("validation", "提醒不能改到别的事项：请撤销后重新设置", 422);
    const remindAt = this.#clampRemindAt(remindAtOf(input.due_date, input.days_before, input.remind_time));
    // 未配置通知服务时改动：云端可能还有旧版本——状态仍为“待登记”，配置后以新版本替换（复核 S10B-02、S10A-07）
    this.#d.db.run(
      `UPDATE reminders SET kind = ?, due_date = ?, remind_at = ?, days_before = ?, remind_time = ?, note = ?, audience = ?, version = version + 1,
         cloud_state = ?, cloud_error = NULL, cloud_body = NULL, cloud_attempts = 0, cloud_next_at = NULL, cloud_expire_at = ?, updated_at = ? WHERE reminder_id = ?`,
      [input.kind, input.due_date, remindAt, input.days_before, input.remind_time, input.note, input.audience, this.#activeCloudState(remindAt, cur.cloud_may_have_copy === 1), this.#expireOf(remindAt, cur.cloud_expire_at), nowIso(), rid],
    );
    this.#d.audit("reminder.update", rid, cur.matter_id);
    return this.get(rid)!;
  }

  /** 撤销：本机不再响；云端可能有副本的一律云端删除（不论当前是否配置；复核 S10B-02）。 */
  cancel(rid: string): ReminderRow {
    const cur = this.#own(rid);
    if (cur.status === "cancelled") return cur;
    const state = cur.cloud_may_have_copy === 1 ? "cancel_pending" : "cancelled";
    this.#d.db.run(`UPDATE reminders SET status = 'cancelled', cloud_state = ?, cloud_error = NULL, cloud_attempts = 0, cloud_next_at = NULL, cloud_body = NULL, updated_at = ? WHERE reminder_id = ?`, [
      state,
      nowIso(),
      rid,
    ]);
    this.#d.audit("reminder.cancel", rid, cur.matter_id);
    return this.get(rid)!;
  }

  /** 永久失败（只有云端判定请求不合格时才会出现）后由律师点“重试”。 */
  retry(rid: string): ReminderRow {
    const cur = this.#own(rid);
    if (cur.cloud_state !== "failed") return cur;
    this.#d.db.run(`UPDATE reminders SET cloud_state = ?, cloud_error = NULL, cloud_attempts = 0, cloud_next_at = NULL, cloud_body = NULL WHERE reminder_id = ?`, [
      cur.status === "active" ? "pending" : "cancel_pending",
      rid,
    ]);
    return this.get(rid)!;
  }

  /**
   * 事项删除（matter-lifecycle 在删除事务里调用）：云端没有副本的提醒整行删除；可能有副本的只留编号、版本与云端删除所需字段
   * （期限类型、日期、提醒时刻、备注都抹去；复核 S10B-14），待云端删除后整行删除；收到的提醒一并删除。
   * 只用 db（同一事务），不发网络请求——云端删除由之后的巡检完成。
   */
  static purgeMatter(db: KernelDb, matterId: string): number {
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reminders WHERE matter_id = ?`, [matterId])?.n ?? 0;
    db.run(`DELETE FROM reminders WHERE matter_id = ? AND cloud_may_have_copy = 0`, [matterId]);
    db.run(
      `UPDATE reminders SET status = 'cancelled', cloud_state = 'cancel_pending', cloud_error = NULL, cloud_attempts = 0, cloud_next_at = NULL, cloud_body = NULL, cloud_devices = NULL,
         kind = 'other', due_date = ?, remind_at = ?, days_before = 0, remind_time = '00:00', note = '', audience = 'me', updated_at = ?
       WHERE matter_id = ?`,
      [PURGED_DATE, PURGED_AT, nowIso(), matterId],
    );
    db.run(`DELETE FROM reminder_inbox WHERE matter_id = ?`, [matterId]);
    return n;
  }

  get(rid: string): (ReminderRow & ReminderCloudCols) | null {
    return this.#d.db.get<ReminderRow & ReminderCloudCols>(`SELECT * FROM reminders WHERE reminder_id = ? AND tenant_id = ?`, [rid, this.#d.tenantId]) ?? null;
  }

  #own(rid: string): ReminderRow & ReminderCloudCols {
    const r = this.get(rid);
    if (!r || r.created_by !== this.#d.userId) throw new DomainError("not_found", "提醒不存在", 404);
    return r;
  }

  /** 提醒时刻已过（例如期限只剩两天却要提前七天提醒）：改为下一分钟立即提醒。 */
  #clampRemindAt(iso: string): string {
    const nextMinute = Math.ceil((this.#now() + 1) / 60_000) * 60_000;
    return Date.parse(iso) < nextMinute ? new Date(nextMinute).toISOString() : iso;
  }

  #expireOf(remindAt: string, prev: string | null): string {
    const t = Date.parse(remindAt) + CLOUD_RETENTION_MS;
    return new Date(Math.max(t, prev ? Date.parse(prev) : 0)).toISOString();
  }

  /** 有效提醒的云端状态：一律“待登记”（未配置时等配置后再登记）；太早的只在本机——除非云端可能还有旧版本要替换。 */
  #activeCloudState(remindAt: string, mayHaveCopy = false): ReminderRow["cloud_state"] {
    // 太早（超过云端可接受范围）只在本机。改动后版本已升，云端若有副本必是旧版本——删掉（复核 S10B-25）；
    // 删完回到“只在本机”（#finishDelete 对有效提醒写 local）
    if (Date.parse(remindAt) < this.#now() - CLOUD_PAST_LIMIT_MS) return mayHaveCopy ? "cancel_pending" : "local";
    return "pending";
  }

  /**
   * 本机巡检：本人建立、仍有效、已到时的提醒放进“收到的提醒”（同一编号与版本只放一次——云端送来的同一条不再重复）。
   * 返回新放入的条数。
   */
  fireLocal(): number {
    const now = new Date(this.#now()).toISOString();
    const due = this.#d.db.all<ReminderRow>(
      `SELECT r.* FROM reminders r WHERE r.tenant_id = ? AND r.created_by = ? AND r.status = 'active' AND r.remind_at <= ?
         AND NOT EXISTS (SELECT 1 FROM reminder_inbox i WHERE i.reminder_id = r.reminder_id AND i.version >= r.version)`,
      [this.#d.tenantId, this.#d.userId, now],
    );
    let n = 0;
    for (const r of due) {
      const ins = this.#d.db.run(
        `INSERT OR IGNORE INTO reminder_inbox (reminder_id, version, tenant_id, matter_id, kind, due_date, remind_at, note, from_device, from_member, source, received_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'local',?)`,
        [r.reminder_id, r.version, r.tenant_id, r.matter_id, r.kind, r.due_date, r.remind_at, r.note, this.#d.deviceId, r.created_by, nowIso()],
      );
      n += ins.changes;
    }
    return n;
  }

  /**
   * 巡检：本机到时（**先通知**，不依赖云端）→ 云端登记与撤销 → 取到时提醒。同一时刻只跑一轮；正在跑时到来的调用共享“下一轮”
   * （至多再跑一轮，复核 S10A-14）。一轮内任何异常都不外抛（复核 S10A-02、S10B-04）。
   */
  tick(): Promise<RoundResult> {
    if (!this.#running) return this.#start();
    if (!this.#queued) {
      this.#queued = this.#running.then(
        () => {
          this.#queued = null;
          return this.#start();
        },
        () => {
          this.#queued = null;
          return this.#start();
        },
      );
    }
    return this.#queued;
  }

  #start(): Promise<RoundResult> {
    const p = this.#round().finally(() => {
      if (this.#running === p) this.#running = null;
    });
    this.#running = p;
    return p;
  }

  async #round(): Promise<RoundResult> {
    let local = 0;
    let cloud = 0;
    try {
      local = this.fireLocal();
    } catch (e) {
      slog.event("KERNEL_REMINDER_TICK_FAILED", errFields(e));
    }
    if (local > 0) this.#safeOnDue(local);
    const counter = { added: 0 };
    let cloudOn = false;
    try {
      cloudOn = this.#d.cloudConfigured() && !this.#d.suspended();
    } catch (e) {
      slog.event("KERNEL_REMINDER_TICK_FAILED", errFields(e));
    }
    if (cloudOn) {
      this.#forcedThisRound = false;
      try {
        this.#housekeeping();
        const reachable = await this.#push();
        if (reachable) await this.#poll(counter);
      } catch (e) {
        slog.event("KERNEL_REMINDER_TICK_FAILED", errFields(e));
      }
      // 取提醒中途出错时，已经放进收件的照样通知（复核 S10B-23）
      cloud = counter.added;
      if (cloud > 0) this.#safeOnDue(cloud);
    }
    return { local, cloud };
  }

  #safeOnDue(n: number): void {
    try {
      this.#d.onDue(n);
    } catch {
      // 通知失败不影响巡检
    }
  }

  /**
   * 每轮云端操作前的整理：① 未配置时设的、仍在云端可接受范围内的提醒升为待登记（复核 S10B-02）；
   * ② 已登记、还没到时的提醒，接收设备或密钥变了就升版本重登（复核 S10A-04/06、S10B-11；到时之后不再重登，免得重复响）；
   * ③ 清理过期的暂缓记录。
   */
  #housekeeping(): void {
    const db = this.#d.db;
    const nowIso_ = new Date(this.#now()).toISOString();
    const cutoff = new Date(this.#now() - CLOUD_PAST_LIMIT_MS).toISOString();
    db.run(`UPDATE reminders SET cloud_state = 'pending', cloud_next_at = NULL WHERE tenant_id = ? AND created_by = ? AND status = 'active' AND cloud_state = 'local' AND remind_at > ?`, [
      this.#d.tenantId,
      this.#d.userId,
      cutoff,
    ]);
    const synced = db.all<ReminderRow & ReminderCloudCols>(
      `SELECT * FROM reminders WHERE tenant_id = ? AND created_by = ? AND status = 'active' AND cloud_state = 'synced' AND remind_at > ?`,
      [this.#d.tenantId, this.#d.userId, nowIso_],
    );
    for (const r of synced) {
      if (this.#fingerprint(this.recipients(r.matter_id, r.audience)) === r.cloud_devices) continue;
      db.run(
        `UPDATE reminders SET version = version + 1, cloud_state = 'pending', cloud_body = NULL, cloud_attempts = 0, cloud_next_at = NULL, updated_at = ?
          WHERE reminder_id = ? AND version = ? AND cloud_state = 'synced'`,
        [nowIso(), r.reminder_id, r.version],
      );
    }
    db.run(`DELETE FROM reminder_holds WHERE first_seen < ?`, [new Date(this.#now() - 2 * HOLD_LIMIT_MS).toISOString()]);
  }

  async #credential(force: boolean): Promise<string> {
    if (!force && this.#cred && this.#cred.expiresAt - this.#now() > 10 * 60_000) return this.#cred.token;
    if (this.#now() < this.#credFailUntil) throw new Error("backoff");
    try {
      this.#cred = await this.#d.credential();
      return this.#cred.token;
    } catch (e) {
      this.#credFailUntil = this.#now() + CREDENTIAL_BACKOFF_MS;
      throw e;
    }
  }

  /**
   * `still`：发出之前（取凭据之后）再核对一次该行仍是这一版本、这一状态——等待期间被撤销、改动或事项被删除的，不再发出（复核 S10B-19）。
   */
  async #relay(make: (credential: string) => NotifyRelayRequest, still?: () => boolean): Promise<NotifyRelayResult> {
    let cred: string;
    try {
      cred = await this.#credential(false);
    } catch (e) {
      return { ok: false, reason: `credential:${String((e as Error)?.message ?? "error").slice(0, 40)}` };
    }
    if (still && !still()) return { ok: false, reason: "superseded" };
    let r = await this.#d.relay(make(cred));
    // 凭据失效（到期、轮换、控制面重启）：每轮至多换一次（复核 S10B-10、S10A-13）
    if (r.ok && r.status === 401 && !this.#forcedThisRound) {
      this.#forcedThisRound = true;
      try {
        cred = await this.#credential(true);
      } catch (e) {
        return { ok: false, reason: `credential:${String((e as Error)?.message ?? "error").slice(0, 40)}` };
      }
      if (still && !still()) return { ok: false, reason: "superseded" };
      r = await this.#d.relay(make(cred));
    }
    return r;
  }

  #backoff(attempts: number): string {
    return new Date(this.#now() + Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS)).toISOString();
  }

  /** 明文：正文 + 签名，填充到固定长度。 */
  #plaintext(body: ReminderBody): Uint8Array {
    const sig = this.#d.signer.signSync(bodyBytes(body));
    const bare = canonicalJson({ body, pad: "", sig });
    const len = Buffer.byteLength(bare, "utf8");
    if (len > REMINDER_PLAIN_BYTES) throw new Error("reminder_plaintext_too_large");
    return new TextEncoder().encode(canonicalJson({ body, pad: " ".repeat(REMINDER_PLAIN_BYTES - len), sig }));
  }

  /** 本人待登记、待删除的提醒交给云端。返回 false = 网络或闸门层面失败，本轮到此为止（复核 S10B-09）。 */
  async #push(): Promise<boolean> {
    const nowS = new Date(this.#now()).toISOString();
    const rows = this.#d.db.all<ReminderRow & ReminderCloudCols>(
      `SELECT * FROM reminders WHERE tenant_id = ? AND created_by = ? AND cloud_state IN ('pending','cancel_pending')
         AND (cloud_next_at IS NULL OR cloud_next_at <= ?) ORDER BY cloud_state = 'cancel_pending' DESC, cloud_next_at IS NOT NULL, cloud_next_at, updated_at LIMIT 20`,
      [this.#d.tenantId, this.#d.userId, nowS],
    );
    for (const snap of rows) {
      // 处理到这一行时重读：前面各行的网络往返期间它可能已被撤销、改动或随事项删除（复核 S10B-19）
      const row = this.get(snap.reminder_id);
      if (!row || row.version !== snap.version || row.cloud_state !== snap.cloud_state) continue;
      let outcome: "ok" | "stop";
      try {
        outcome = row.cloud_state === "cancel_pending" ? await this.#pushDelete(row) : await this.#pushPut(row);
      } catch (e) {
        // 单行异常（例如目录里某台设备的公钥损坏）：该行退避，不影响其他行（复核 S10B-04）
        slog.event("KERNEL_REMINDER_TICK_FAILED", errFields(e));
        this.#retryLater(row, "internal_error");
        outcome = "ok";
      }
      if (outcome === "stop") return false;
    }
    return true;
  }

  /** 该行仍是这一版本、这一状态（有效提醒还须仍有效）。 */
  #unchanged(row: ReminderRow, state: "pending" | "cancel_pending"): boolean {
    const c = this.get(row.reminder_id);
    return !!c && c.version === row.version && c.cloud_state === state && (state === "cancel_pending" || c.status === "active");
  }

  /** 该行稍后再试（退避）；状态不变。 */
  #retryLater(row: ReminderRow & ReminderCloudCols, code: string): void {
    const attempts = (row.cloud_attempts ?? 0) + 1;
    this.#d.db.run(`UPDATE reminders SET cloud_error = ?, cloud_attempts = ?, cloud_next_at = ? WHERE reminder_id = ? AND version = ? AND cloud_state = ?`, [
      code.slice(0, 60),
      attempts,
      this.#backoff(attempts),
      row.reminder_id,
      row.version,
      row.cloud_state,
    ]);
  }

  #codeOf(r: NotifyRelayResult): string {
    return r.ok ? String(safeJson(r.body).error ?? `http_${r.status}`).slice(0, 60) : r.reason;
  }

  async #pushDelete(row: ReminderRow & ReminderCloudCols): Promise<"ok" | "stop"> {
    // 云端副本最迟在触发后 7 天自行删除：过了这个时刻不必再删
    if (row.cloud_expire_at && Date.parse(row.cloud_expire_at) <= this.#now()) {
      this.#finishDelete(row, "expired");
      return "ok";
    }
    const r = await this.#relay(
      (credential) => ({ step: "delete", credential, reminder_id: row.reminder_id, version: row.version }),
      () => this.#unchanged(row, "cancel_pending"),
    );
    if (!r.ok && r.reason === "superseded") return "ok";
    this.#note(r);
    if (r.ok && r.status === 200) {
      this.#finishDelete(row, null);
      return "ok";
    }
    const code = this.#codeOf(r);
    if (r.ok && r.status === 403) {
      // 云端记的建立者不是本人：无法删除（不应出现），停止重试并记事件
      slog.event("REMINDER_REJECTED", { count: 1 });
      this.#finishDelete(row, code);
      return "ok";
    }
    // 其余一律保持待删除、退避重试（复核 S10A-07、S10B-01：撤销与删除事项永不进入“失败”）
    this.#retryLater(row, code);
    return (!r.ok && networkClass(r.reason)) || (r.ok && r.status >= 500) ? "stop" : "ok";
  }

  #finishDelete(row: ReminderRow & ReminderCloudCols, code: string | null): void {
    // 事项已删除的提醒（占位行）：云端删除完成即整行删除
    const purged = this.#d.db.get(`SELECT 1 AS x FROM matters WHERE matter_id = ? AND lifecycle = 'purged'`, [row.matter_id]);
    if (purged) {
      this.#d.db.run(`DELETE FROM reminders WHERE reminder_id = ? AND version = ? AND cloud_state = 'cancel_pending'`, [row.reminder_id, row.version]);
      return;
    }
    // 有效提醒（云端旧版本删完）回到“只在本机”；已撤销的记“已撤销”
    this.#d.db.run(
      `UPDATE reminders SET cloud_state = CASE WHEN status = 'active' THEN 'local' ELSE 'cancelled' END, cloud_may_have_copy = 0, cloud_version = NULL, cloud_error = ?, cloud_next_at = NULL, cloud_body = NULL
        WHERE reminder_id = ? AND version = ? AND cloud_state = 'cancel_pending'`,
      [code, row.reminder_id, row.version],
    );
  }

  async #pushPut(row: ReminderRow & ReminderCloudCols): Promise<"ok" | "stop"> {
    if (Date.parse(row.remind_at) < this.#now() - CLOUD_PAST_LIMIT_MS) {
      // 云端持有的就是当前版本：保留（仍可补发给离线设备；复核 S10B-21）；是更旧的或不确定：删掉，删完回到“只在本机”（复核 S10B-25）
      const keep = row.cloud_may_have_copy !== 1 || row.cloud_version === row.version;
      this.#d.db.run(`UPDATE reminders SET cloud_state = ? WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending'`, [keep ? "local" : "cancel_pending", row.reminder_id, row.version]);
      return "ok";
    }
    // 同一版本已封好的密文原样重发（结果不明后重发命中云端幂等，不升版本、不重响；复核 S10A-09、S10B-07）
    type Sealed = { fire_at: string; version: number; targets: { dev: string; ct: string }[]; devices: string };
    let cached: Sealed | null = null;
    try {
      const c = row.cloud_body ? (JSON.parse(row.cloud_body) as Sealed | null) : null;
      if (c && c.version === row.version && c.fire_at === row.remind_at && Array.isArray(c.targets) && typeof c.devices === "string") cached = c;
    } catch {
      cached = null;
    }
    // 缓存的密文按当时的接收设备封装：名单或公钥已变（成员移出、换钥、新设备）——
    // 还没到时：升一版重封（复核 S10A-23）；已经响过：不升版本（免得所有人再响一次，复核 S10B-24），只去掉已不在名单里或已换钥的设备
    if (cached) {
      const current = this.recipients(row.matter_id, row.audience);
      const fp = this.#fingerprint(current);
      if (cached.devices !== fp) {
        if (Date.parse(row.remind_at) > this.#now()) {
          this.#d.db.run(
            `UPDATE reminders SET version = version + 1, cloud_body = NULL, cloud_attempts = 0, cloud_next_at = NULL WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending' AND status = 'active'`,
            [row.reminder_id, row.version],
          );
          return "ok";
        }
        const still = new Set((JSON.parse(fp) as { t: [string, string][] }).t.map(([d, h]) => `${d}:${h}`));
        const was = new Map((JSON.parse(cached.devices) as { t: [string, string][] }).t.map(([d, h]) => [d, `${d}:${h}`]));
        const kept = cached.targets.filter((t) => still.has(was.get(t.dev) ?? ""));
        if (kept.length === 0) {
          this.#d.db.run(`UPDATE reminders SET cloud_state = 'local' WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending'`, [row.reminder_id, row.version]);
          return "ok";
        }
        const keptDevs = new Set(kept.map((t) => t.dev));
        const devices = JSON.stringify({ s: (JSON.parse(cached.devices) as { s: string }).s, t: (JSON.parse(cached.devices) as { t: [string, string][] }).t.filter(([d]) => keptDevs.has(d)) });
        cached = { ...cached, targets: kept, devices };
        this.#d.db.run(`UPDATE reminders SET cloud_body = ? WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending'`, [JSON.stringify(cached), row.reminder_id, row.version]);
      }
    }
    if (!cached) {
      const targets = this.recipients(row.matter_id, row.audience);
      const body: ReminderBody = {
        f: BODY_FORMAT,
        tid: this.#d.tenantId,
        rid: row.reminder_id,
        ver: row.version,
        matter_id: row.matter_id,
        kind: row.kind,
        due_date: row.due_date,
        remind_at: row.remind_at,
        note: row.note,
        audience: row.audience,
        from_dev: this.#d.deviceId,
        from_member: this.#d.userId,
        issued_at: nowIso(),
      };
      const plain = this.#plaintext(body);
      cached = {
        fire_at: row.remind_at,
        version: row.version,
        targets: targets.map((t) => ({ dev: t.device_id, ct: sealForDevice(plain, t.enc_pub_pem, reminderAad(body.tid, body.rid, body.ver, t.device_id)) })),
        devices: this.#fingerprint(targets),
      };
      // 先记“云端可能有副本”与密文，再发出（发出途中退出也知道要云端删除、重发也是同一份）；没命中 = 该行已变，不发
      const w = this.#d.db.run(`UPDATE reminders SET cloud_body = ?, cloud_may_have_copy = 1 WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending' AND status = 'active'`, [
        JSON.stringify(cached),
        row.reminder_id,
        row.version,
      ]);
      if (w.changes !== 1) return "ok";
    } else if (row.cloud_may_have_copy !== 1) {
      const w = this.#d.db.run(`UPDATE reminders SET cloud_may_have_copy = 1 WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending' AND status = 'active'`, [row.reminder_id, row.version]);
      if (w.changes !== 1) return "ok";
    }
    const sealed = cached;
    const r = await this.#relay(
      (credential) => ({ step: "put", credential, reminder_id: row.reminder_id, fire_at: sealed.fire_at, version: sealed.version, targets: sealed.targets }),
      () => this.#unchanged(row, "pending"),
    );
    if (!r.ok && r.reason === "superseded") return "ok";
    this.#note(r);
    if (r.ok && r.status === 200) {
      this.#d.db.run(
        `UPDATE reminders SET cloud_state = 'synced', cloud_error = NULL, cloud_targets = ?, cloud_devices = ?, cloud_version = ?, cloud_attempts = 0, cloud_next_at = NULL
          WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending'`,
        [sealed.targets.length, sealed.devices, row.version, row.reminder_id, row.version],
      );
      return "ok";
    }
    const code = this.#codeOf(r);
    if (!r.ok && networkClass(r.reason)) {
      this.#retryLater(row, code);
      return "stop";
    }
    if (r.ok && r.status >= 500) {
      this.#retryLater(row, code);
      return "stop";
    }
    // 已经响过的提醒：云端已有同版本（版本只对应一份内容），按已登记处理，不升版本重响（复核 S10B-24）
    if (code === "version_conflict" && Date.parse(row.remind_at) <= this.#now()) {
      this.#d.db.run(
        `UPDATE reminders SET cloud_state = 'synced', cloud_error = NULL, cloud_version = ?, cloud_attempts = 0, cloud_next_at = NULL WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending'`,
        [row.version, row.reminder_id, row.version],
      );
      return "ok";
    }
    if (code === "version_conflict" || code === "version_stale") {
      // 云端已有同版本的另一份内容或更高版本（墓碑）：升一版、重新封装后再登记
      this.#d.db.run(
        `UPDATE reminders SET version = version + 1, cloud_body = NULL, cloud_error = ?, cloud_attempts = 0, cloud_next_at = NULL WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending'`,
        [code, row.reminder_id, row.version],
      );
      return "ok";
    }
    if (code === "target_revoked") {
      // 本机目录比云端吊销集落后：重新挑接收设备、退避重试
      this.#d.db.run(`UPDATE reminders SET cloud_body = NULL WHERE reminder_id = ? AND version = ?`, [row.reminder_id, row.version]);
      this.#retryLater(row, code);
      return "ok";
    }
    if (r.ok && (r.status === 401 || r.status === 429)) {
      this.#retryLater(row, code);
      return "ok";
    }
    // 云端判定请求本身不合格（不应出现）：标失败，律师可点“重试”
    this.#d.db.run(`UPDATE reminders SET cloud_state = 'failed', cloud_error = ? WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending'`, [code, row.reminder_id, row.version]);
    return "ok";
  }

  /** 取本设备到时的提醒：解密、核对后放进“收到的提醒”，确认收到；暂时不能判断的请云端暂缓。返回新放入的条数。 */
  async #poll(counter: { added: number }): Promise<number> {
    let added = 0;
    for (let round = 0; round < 5; round++) {
      const r = await this.#relay((credential) => ({ step: "due", credential }));
      this.#note(r);
      if (!r.ok || r.status !== 200) return added;
      const page = safeJson(r.body);
      const items = Array.isArray(page.items) ? (page.items as unknown[]) : [];
      if (items.length === 0) return added;
      const ack: { id: string; version: number }[] = [];
      const defer: { id: string; version: number; until: string }[] = [];
      for (const raw of items.slice(0, 50)) {
        const it = raw as { id?: unknown; version?: unknown; fire_at?: unknown; ct?: unknown } | null;
        if (!it || typeof it.id !== "string" || !/^rmd_[0-9a-f]{24}$/.test(it.id) || typeof it.version !== "number" || !Number.isSafeInteger(it.version) || typeof it.fire_at !== "string" || typeof it.ct !== "string") continue;
        const item = { id: it.id, version: it.version, fire_at: it.fire_at, ct: it.ct };
        let v: Verdict;
        try {
          v = this.#accept(item);
        } catch {
          // 任何意外都按不合格处理（复核 S10A-01：一条坏数据不能中断整批）
          v = { v: "rejected", reason: "malformed" };
        }
        if (v.v === "hold") {
          const first = this.#holdSince(item, v.reason);
          if (v.reason !== "key_change_pending" && this.#now() - first > HOLD_LIMIT_MS) v = { v: "rejected", reason: `held_${v.reason}` };
          else {
            defer.push({ id: item.id, version: item.version, until: new Date(v.until).toISOString() });
            continue;
          }
        }
        if (v.v === "added") {
          added++;
          counter.added++;
        }
        if (v.v === "rejected") this.#countReject(v.reason);
        ack.push({ id: item.id, version: item.version });
      }
      if (defer.length > 0) this.#note(await this.#relay((credential) => ({ step: "defer", credential, items: defer })));
      if (ack.length > 0) {
        const a = await this.#relay((credential) => ({ step: "ack", credential, items: ack }));
        this.#note(a);
        if (!a.ok || a.status !== 200) return added;
      }
      if (page.more !== true) return added;
    }
    return added;
  }

  #holdSince(it: { id: string; version: number }, reason: string): number {
    this.#d.db.run(`INSERT OR IGNORE INTO reminder_holds (reminder_id, version, reason, first_seen) VALUES (?,?,?,?)`, [it.id, it.version, reason, new Date(this.#now()).toISOString()]);
    const r = this.#d.db.get<{ first_seen: string }>(`SELECT first_seen FROM reminder_holds WHERE reminder_id = ? AND version = ?`, [it.id, it.version]);
    return r ? Date.parse(r.first_seen) : this.#now();
  }

  #countReject(reason: string): void {
    slog.event("REMINDER_REJECTED", { count: 1 });
    this.#d.db.run(
      `INSERT INTO reminder_rejects (tenant_id, reason, count, last_at) VALUES (?,?,1,?)
       ON CONFLICT(tenant_id, reason) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      [this.#d.tenantId, reason.slice(0, 40), nowIso()],
    );
  }

  /**
   * 核对一条云端送来的提醒。added = 放进收件；dup = 已有或更旧；rejected = 不合格（确认后丢弃）；
   * hold = 暂时不能判断（发出设备未知、签名对不上、发出者成员关系未同步、提前送达）——请云端暂缓，24 小时后仍不能判断即丢弃。
   */
  #accept(it: { id: string; version: number; fire_at: string; ct: string }): Verdict {
    let parsed: unknown;
    try {
      const plain = openForDevice(it.ct, this.#d.encPrivateKeyPem, reminderAad(this.#d.tenantId, it.id, it.version, this.#d.deviceId));
      parsed = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return { v: "rejected", reason: "undecryptable" };
    }
    const p = parsed as { body?: unknown; sig?: unknown } | null;
    if (!p || typeof p !== "object" || Array.isArray(p) || !p.body || typeof p.body !== "object" || Array.isArray(p.body) || typeof p.sig !== "string") return { v: "rejected", reason: "malformed" };
    const b = p.body as ReminderBody;
    if (b.f !== BODY_FORMAT || b.tid !== this.#d.tenantId || b.rid !== it.id || b.ver !== it.version || b.remind_at !== it.fire_at) return { v: "rejected", reason: "context_mismatch" };
    if (typeof b.matter_id !== "string" || typeof b.from_dev !== "string" || typeof b.from_member !== "string" || typeof b.note !== "string") return { v: "rejected", reason: "malformed" };
    if (!(REMINDER_KINDS as readonly string[]).includes(b.kind) || !DATE_RE.test(b.due_date) || [...b.note].length > REMINDER_NOTE_MAX) return { v: "rejected", reason: "malformed" };
    if (b.audience !== "me" && b.audience !== "team") return { v: "rejected", reason: "malformed" };
    if (typeof b.issued_at !== "string" || Number.isNaN(Date.parse(b.issued_at))) return { v: "rejected", reason: "malformed" };
    if (typeof b.remind_at !== "string" || Number.isNaN(Date.parse(b.remind_at))) return { v: "rejected", reason: "malformed" };

    // 发出设备：本机目录里还没有 → 暂缓；已吊销（含墓碑）或成员不符 → 不收
    const sender = this.#d.db.get<{ sign_pub_pem: string; member_id: string; status: string; revoked: number }>(
      `SELECT sign_pub_pem, member_id, status, EXISTS (SELECT 1 FROM cp_revoked_devices c WHERE c.tenant_id = d.tenant_id AND c.device_id = d.device_id) AS revoked
         FROM devices d WHERE d.device_id = ? AND d.tenant_id = ?`,
      [b.from_dev, this.#d.tenantId],
    );
    if (!sender) return { v: "hold", reason: "unknown_sender", until: this.#now() + HOLD_RETRY_MS };
    if (sender.status !== "active" || sender.revoked === 1) return { v: "rejected", reason: "sender_revoked" };
    if (sender.member_id !== b.from_member) return { v: "rejected", reason: "context_mismatch" };
    // 签名对不上：可能是发出设备刚换钥、本机目录还没同步——暂缓（复核 S10A-04；24 小时后仍不符即丢弃）
    if (!verifyBytes(sender.sign_pub_pem, bodyBytes(b), p.sig)) {
      // 对方换钥、待双方核对安全码：不计 24 小时上限，一直暂缓到核对完成或云端副本过期（复核 S10A-04 遗留）
      const keyChange = this.#d.db.get(`SELECT 1 AS x FROM device_key_changes WHERE device_id = ? AND tenant_id = ? AND status = 'pending'`, [b.from_dev, this.#d.tenantId]);
      return { v: "hold", reason: keyChange ? "key_change_pending" : "signature", until: this.#now() + HOLD_RETRY_MS };
    }

    // 事项：本机已删除 → 不收（复核 S10A-06、S10B-03）；本人已被移出 → 不收；发出者不是成员 → 暂缓（成员关系可能未同步）
    const matter = this.#d.db.get<{ lifecycle: string | null }>(`SELECT lifecycle FROM matters WHERE matter_id = ? AND tenant_id = ?`, [b.matter_id, this.#d.tenantId]);
    if (matter) {
      if (matter.lifecycle === "purged") return { v: "rejected", reason: "matter_deleted" };
      const mine = this.#d.db.get<{ active: number }>(`SELECT MAX(removed_at IS NULL) AS active FROM matter_members WHERE matter_id = ? AND user_id = ?`, [b.matter_id, this.#d.userId]);
      if (mine?.active === 0) return { v: "rejected", reason: "not_member" };
      if (b.from_member !== this.#d.userId) {
        const member = this.#d.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [b.matter_id, b.from_member]);
        if (!member) return { v: "hold", reason: "sender_not_member", until: this.#now() + HOLD_RETRY_MS };
      }
    }
    // 发出方时钟偏快（签发时刻在“现在”之后 10 分钟以上）：暂缓而不是丢弃（复核 S10A-22）
    if (Date.parse(b.issued_at) > this.#now() + EARLY_TOLERANCE_MS * 2) return { v: "hold", reason: "clock", until: Math.min(Date.parse(b.issued_at), this.#now() + HOLD_LIMIT_MS) };
    // 提前送达（云端只该给已到时的）：暂缓到提醒时刻（复核 S10A-11）
    const at = Date.parse(b.remind_at);
    if (at > this.#now() + EARLY_TOLERANCE_MS) return { v: "hold", reason: "early", until: Math.min(at, this.#now() + HOLD_LIMIT_MS) };

    // 本人建立、本机已撤销或已改版的提醒：旧版本不再显示；同一编号见过更高版本的，旧版本（回滚、重放）不再显示（复核 S10A-10）
    const own = this.get(b.rid);
    if (own && (own.status !== "active" || own.version > b.ver)) return { v: "dup" };
    const higher = this.#d.db.get(`SELECT 1 AS x FROM reminder_inbox WHERE reminder_id = ? AND version > ?`, [b.rid, b.ver]);
    if (higher) return { v: "dup" };
    // 备注再清洗一次（发出端清洗过，接收端不信任；复核 S10A-18）
    const note = b.note.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
    const ins = this.#d.db.run(
      `INSERT OR IGNORE INTO reminder_inbox (reminder_id, version, tenant_id, matter_id, kind, due_date, remind_at, note, from_device, from_member, source, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'cloud',?)`,
      [b.rid, b.ver, this.#d.tenantId, b.matter_id, b.kind, b.due_date, b.remind_at, note, b.from_dev, b.from_member, nowIso()],
    );
    return { v: ins.changes === 1 ? "added" : "dup" };
  }

  /** 收到的提醒中因核对不通过而丢弃的条数（按原因；界面如实提示）。 */
  rejectSummary(): { reason: string; count: number; last_at: string }[] {
    return this.#d.db.all(`SELECT reason, count, last_at FROM reminder_rejects WHERE tenant_id = ? ORDER BY last_at DESC`, [this.#d.tenantId]);
  }

  #note(r: NotifyRelayResult): void {
    const ok = r.ok && r.status < 500 && r.status !== 401;
    this.lastCloud = { at: nowIso(), ok, code: ok ? null : r.ok ? `http_${r.status}` : r.reason };
  }
}

/** 迁移 0035 的云端列。 */
export interface ReminderCloudCols {
  cloud_may_have_copy: number;
  cloud_next_at: string | null;
  cloud_attempts: number;
  cloud_body: string | null;
  cloud_devices: string | null;
  cloud_expire_at: string | null;
  /** 云端确认持有的版本（登记成功时写入；迁移 0036）。 */
  cloud_version: number | null;
}
