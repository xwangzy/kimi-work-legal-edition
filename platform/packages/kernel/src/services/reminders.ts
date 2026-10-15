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
 * - 改动 = 版本号 + 1 后整条重新登记（旧版本作废）；撤销与事项删除 = 云端删除。
 * 不做（如实）：手机推送（G2 App）、IM 提醒（G1 端侧）、按工作日顺延与法定期间计算（期限日由律师填写）。
 */
import { randomBytes } from "node:crypto";
import { canonicalJson, openForDevice, sealForDevice, verifyBytes, type DeviceSyncSigner } from "@zr-legal/keys";
import type { NotifyRelayRequest, NotifyRelayResult } from "@zr-legal/egress-gate";
import { DomainError } from "@zr-legal/domain";
import { slog } from "@zr-legal/safe-log";
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

/** 云端错误代码（不出现在界面上；界面按 cloudStateText 写律师语言）。 */
const TRANSIENT = new Set(["notify_timeout", "notify_unreachable", "notify_connect_failed", "gate_exited", "gate_unavailable", "notify_bad_reply"]);

export class ReminderService {
  readonly #d: ReminderServiceDeps;
  #cred: { token: string; expiresAt: number } | null = null;
  #busy: Promise<void> | null = null;
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
        ORDER BY (device_id = ?) DESC, member_id, device_id`,
      [this.#d.tenantId, this.#d.tenantId, ...members, this.#d.deviceId],
    );
    return rows.slice(0, REMINDER_MAX_TARGETS).map(({ device_id, enc_pub_pem }) => ({ device_id, enc_pub_pem }));
  }

  /** 新建（调用方已核对事项写权限）。 */
  create(input: ReminderInput): ReminderRow {
    const rid = `rmd_${randomBytes(12).toString("hex")}`;
    const at = nowIso();
    const remindAt = this.#clampRemindAt(remindAtOf(input.due_date, input.days_before, input.remind_time));
    this.#d.db.run(
      `INSERT INTO reminders (reminder_id, tenant_id, matter_id, created_by, kind, due_date, remind_at, days_before, remind_time, note, audience, version, status, cloud_state, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?)`,
      [rid, this.#d.tenantId, input.matter_id, this.#d.userId, input.kind, input.due_date, remindAt, input.days_before, input.remind_time, input.note, input.audience, this.#initialCloudState(remindAt), at, at],
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
    this.#d.db.run(
      `UPDATE reminders SET kind = ?, due_date = ?, remind_at = ?, days_before = ?, remind_time = ?, note = ?, audience = ?, version = version + 1,
         cloud_state = ?, cloud_error = NULL, updated_at = ? WHERE reminder_id = ?`,
      [input.kind, input.due_date, remindAt, input.days_before, input.remind_time, input.note, input.audience, this.#initialCloudState(remindAt), nowIso(), rid],
    );
    this.#d.audit("reminder.update", rid, cur.matter_id);
    return this.get(rid)!;
  }

  /** 撤销：本机不再响；交过云端的由云端删除。 */
  cancel(rid: string): ReminderRow {
    const cur = this.#own(rid);
    if (cur.status === "cancelled") return cur;
    this.#d.db.run(`UPDATE reminders SET status = 'cancelled', cloud_state = ?, cloud_error = NULL, updated_at = ? WHERE reminder_id = ?`, [this.#cancelState(cur), nowIso(), rid]);
    this.#d.audit("reminder.cancel", rid, cur.matter_id);
    return this.get(rid)!;
  }

  /**
   * 事项删除（matter-lifecycle 在删除事务里调用）：撤销该事项的全部提醒并清掉备注，交过云端的待删除；收到的提醒一并删除。
   * 只用 db（同一事务），不发网络请求——云端删除由下次巡检完成。
   */
  static purgeMatter(db: KernelDb, matterId: string): number {
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reminders WHERE matter_id = ?`, [matterId])?.n ?? 0;
    db.run(
      `UPDATE reminders SET status = 'cancelled', note = '', updated_at = ?,
         cloud_state = CASE WHEN cloud_state IN ('pending','synced','failed','cancel_pending') THEN 'cancel_pending' ELSE 'cancelled' END
       WHERE matter_id = ?`,
      [nowIso(), matterId],
    );
    db.run(`DELETE FROM reminder_inbox WHERE matter_id = ?`, [matterId]);
    return n;
  }

  get(rid: string): ReminderRow | null {
    return this.#d.db.get<ReminderRow>(`SELECT * FROM reminders WHERE reminder_id = ? AND tenant_id = ?`, [rid, this.#d.tenantId]) ?? null;
  }

  #own(rid: string): ReminderRow {
    const r = this.get(rid);
    if (!r || r.created_by !== this.#d.userId) throw new DomainError("not_found", "提醒不存在", 404);
    return r;
  }

  /** 提醒时刻已过（例如期限只剩两天却要提前七天提醒）：改为下一分钟立即提醒。 */
  #clampRemindAt(iso: string): string {
    const nextMinute = Math.ceil((this.#now() + 1) / 60_000) * 60_000;
    return Date.parse(iso) < nextMinute ? new Date(nextMinute).toISOString() : iso;
  }

  #initialCloudState(remindAt: string): ReminderRow["cloud_state"] {
    if (!this.#d.cloudConfigured()) return "local";
    return Date.parse(remindAt) < this.#now() - CLOUD_PAST_LIMIT_MS ? "local" : "pending";
  }

  #cancelState(cur: ReminderRow): ReminderRow["cloud_state"] {
    return cur.cloud_state === "local" || cur.cloud_state === "cancelled" ? "cancelled" : "cancel_pending";
  }

  /**
   * 本机巡检：本人建立、仍有效、已到时的提醒放进“收到的提醒”（同一编号与版本只放一次——云端送来的同一条不再重复）。
   * 返回新放入的条数。
   */
  fireLocal(): number {
    const now = new Date(this.#now()).toISOString();
    const due = this.#d.db.all<ReminderRow>(
      `SELECT r.* FROM reminders r WHERE r.tenant_id = ? AND r.created_by = ? AND r.status = 'active' AND r.remind_at <= ?
         AND NOT EXISTS (SELECT 1 FROM reminder_inbox i WHERE i.reminder_id = r.reminder_id AND i.version = r.version)`,
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

  /** 一次完整巡检：本机到时 → 云端登记与撤销 → 取到时提醒。并发调用合并为同一次。 */
  async tick(): Promise<{ local: number; cloud: number }> {
    if (this.#busy) {
      await this.#busy;
      return { local: 0, cloud: 0 };
    }
    let local = 0;
    let cloud = 0;
    const run = (async () => {
      local = this.fireLocal();
      if (this.#d.cloudConfigured() && !this.#d.suspended()) {
        await this.#push();
        cloud = await this.#poll();
      }
      if (local + cloud > 0) this.#d.onDue(local + cloud);
    })();
    this.#busy = run.finally(() => {
      this.#busy = null;
    });
    await this.#busy;
    return { local, cloud };
  }

  async #credential(force = false): Promise<string> {
    if (!force && this.#cred && this.#cred.expiresAt - this.#now() > 10 * 60_000) return this.#cred.token;
    this.#cred = await this.#d.credential();
    return this.#cred.token;
  }

  async #relay(make: (credential: string) => NotifyRelayRequest): Promise<NotifyRelayResult> {
    let cred: string;
    try {
      cred = await this.#credential();
    } catch (e) {
      return { ok: false, reason: `credential:${String((e as Error)?.message ?? "error").slice(0, 40)}` };
    }
    let r = await this.#d.relay(make(cred));
    // 凭据失效（到期、轮换、控制面重启）：换一张再试一次
    if (r.ok && r.status === 401) {
      try {
        cred = await this.#credential(true);
      } catch (e) {
        return { ok: false, reason: `credential:${String((e as Error)?.message ?? "error").slice(0, 40)}` };
      }
      r = await this.#d.relay(make(cred));
    }
    return r;
  }

  /** 本人待登记、待删除的提醒交给云端。 */
  async #push(): Promise<void> {
    const rows = this.#d.db.all<ReminderRow>(
      `SELECT * FROM reminders WHERE tenant_id = ? AND created_by = ? AND cloud_state IN ('pending','cancel_pending') ORDER BY updated_at LIMIT 20`,
      [this.#d.tenantId, this.#d.userId],
    );
    for (const row of rows) {
      const set = (state: ReminderRow["cloud_state"], code: string | null, targets?: number) =>
        this.#d.db.run(`UPDATE reminders SET cloud_state = ?, cloud_error = ?, cloud_targets = COALESCE(?, cloud_targets) WHERE reminder_id = ? AND version = ? AND cloud_state = ?`, [
          state,
          code,
          targets ?? null,
          row.reminder_id,
          row.version,
          row.cloud_state,
        ]);
      if (row.cloud_state === "cancel_pending") {
        const r = await this.#relay((credential) => ({ step: "delete", credential, reminder_id: row.reminder_id }));
        this.#note(r);
        if (r.ok && r.status === 200) set("cancelled", null);
        else if (!r.ok && (TRANSIENT.has(r.reason) || r.reason.startsWith("credential:"))) set("cancel_pending", r.reason);
        else if (r.ok && r.status >= 500) set("cancel_pending", `http_${r.status}`);
        else set("failed", r.ok ? String(safeJson(r.body).error ?? `http_${r.status}`).slice(0, 60) : r.reason);
        continue;
      }
      if (Date.parse(row.remind_at) < this.#now() - CLOUD_PAST_LIMIT_MS) {
        set("local", null);
        continue;
      }
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
      const sig = this.#d.signer.signSync(bodyBytes(body));
      const plain = new TextEncoder().encode(canonicalJson({ body, sig }));
      const sealed = targets.map((t) => ({ dev: t.device_id, ct: sealForDevice(plain, t.enc_pub_pem, reminderAad(body.tid, body.rid, body.ver, t.device_id)) }));
      const r = await this.#relay((credential) => ({ step: "put", credential, reminder_id: row.reminder_id, fire_at: row.remind_at, version: row.version, targets: sealed }));
      this.#note(r);
      if (r.ok && r.status === 200) {
        set("synced", null, sealed.length);
        continue;
      }
      if (!r.ok && (TRANSIENT.has(r.reason) || r.reason.startsWith("credential:"))) {
        set("pending", r.reason);
        continue;
      }
      if (r.ok && r.status >= 500) {
        set("pending", `http_${r.status}`);
        continue;
      }
      const code = r.ok ? String(safeJson(r.body).error ?? `http_${r.status}`).slice(0, 60) : r.reason;
      // 同一版本云端已收下另一份密文（上次送出后结果不明、重发时密文随机不同）：升一个版本整条重登
      if (code === "version_conflict" || code === "version_stale") {
        this.#d.db.run(`UPDATE reminders SET version = version + 1, cloud_error = ? WHERE reminder_id = ? AND version = ? AND cloud_state = 'pending'`, [code, row.reminder_id, row.version]);
        continue;
      }
      set("failed", code);
    }
  }

  /** 取本设备到时的提醒：解密、核对签名与上下文后放进“收到的提醒”，再确认收到。返回新放入的条数。 */
  async #poll(): Promise<number> {
    let added = 0;
    for (let round = 0; round < 5; round++) {
      const r = await this.#relay((credential) => ({ step: "due", credential }));
      this.#note(r);
      if (!r.ok || r.status !== 200) return added;
      const items = (safeJson(r.body).items as unknown[] | undefined) ?? [];
      if (!Array.isArray(items) || items.length === 0) return added;
      const ack: { id: string; version: number }[] = [];
      let rejected = 0;
      for (const raw of items.slice(0, 50)) {
        const it = raw as { id?: unknown; version?: unknown; fire_at?: unknown; ct?: unknown };
        if (typeof it.id !== "string" || typeof it.version !== "number" || typeof it.fire_at !== "string" || typeof it.ct !== "string") continue;
        const v = this.#accept({ id: it.id, version: it.version, fire_at: it.fire_at, ct: it.ct });
        if (v === "retry") continue; // 发出设备本机还不认识（目录未同步）：先不确认，下次再取
        if (v === "added") added++;
        if (v === "rejected") rejected++;
        ack.push({ id: it.id, version: it.version });
      }
      if (rejected > 0) slog.event("REMINDER_REJECTED", { count: rejected });
      if (ack.length === 0) return added;
      const a = await this.#relay((credential) => ({ step: "ack", credential, items: ack }));
      this.#note(a);
      if (!a.ok || a.status !== 200 || safeJson(r.body).more !== true) return added;
    }
    return added;
  }

  /** 核对一条云端送来的提醒：added = 放进收件；dup = 已有；rejected = 不合格（确认后丢弃）；retry = 暂不能判断。 */
  #accept(it: { id: string; version: number; fire_at: string; ct: string }): "added" | "dup" | "rejected" | "retry" {
    let parsed: { body?: ReminderBody; sig?: string };
    try {
      const plain = openForDevice(it.ct, this.#d.encPrivateKeyPem, reminderAad(this.#d.tenantId, it.id, it.version, this.#d.deviceId));
      parsed = JSON.parse(new TextDecoder().decode(plain)) as { body?: ReminderBody; sig?: string };
    } catch {
      return "rejected";
    }
    const b = parsed.body;
    if (!b || typeof parsed.sig !== "string" || b.f !== BODY_FORMAT || b.tid !== this.#d.tenantId || b.rid !== it.id || b.ver !== it.version || b.remind_at !== it.fire_at) return "rejected";
    if (!(REMINDER_KINDS as readonly string[]).includes(b.kind) || !DATE_RE.test(b.due_date) || typeof b.note !== "string" || [...b.note].length > REMINDER_NOTE_MAX) return "rejected";
    if (typeof b.from_dev !== "string" || typeof b.from_member !== "string" || typeof b.matter_id !== "string") return "rejected";
    const sender = this.#d.db.get<{ sign_pub_pem: string; member_id: string; status: string; revoked: number }>(
      `SELECT sign_pub_pem, member_id, status, EXISTS (SELECT 1 FROM cp_revoked_devices c WHERE c.tenant_id = d.tenant_id AND c.device_id = d.device_id) AS revoked
         FROM devices d WHERE d.device_id = ? AND d.tenant_id = ?`,
      [b.from_dev, this.#d.tenantId],
    );
    if (!sender) return "retry";
    if (sender.status !== "active" || sender.revoked === 1 || sender.member_id !== b.from_member) return "rejected";
    if (!verifyBytes(sender.sign_pub_pem, bodyBytes(b), parsed.sig)) return "rejected";
    // 本机有这个事项时：发出者须仍是事项成员（被移出的人不能再给事项成员发提醒）
    const haveMatter = this.#d.db.get(`SELECT 1 AS x FROM matters WHERE matter_id = ? AND tenant_id = ?`, [b.matter_id, this.#d.tenantId]);
    if (haveMatter && b.from_member !== this.#d.userId) {
      const member = this.#d.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [b.matter_id, b.from_member]);
      if (!member) return "rejected";
    }
    // 本人建立、本机已撤销或已改版的提醒：旧版本不再显示
    const mine = this.get(b.rid);
    if (mine && (mine.status !== "active" || mine.version > b.ver)) return "dup";
    const ins = this.#d.db.run(
      `INSERT OR IGNORE INTO reminder_inbox (reminder_id, version, tenant_id, matter_id, kind, due_date, remind_at, note, from_device, from_member, source, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'cloud',?)`,
      [b.rid, b.ver, this.#d.tenantId, b.matter_id, b.kind, b.due_date, b.remind_at, b.note, b.from_dev, b.from_member, nowIso()],
    );
    return ins.changes === 1 ? "added" : "dup";
  }

  #note(r: NotifyRelayResult): void {
    const ok = r.ok && r.status < 500 && r.status !== 401;
    this.lastCloud = { at: nowIso(), ok, code: ok ? null : r.ok ? `http_${r.status}` : r.reason };
  }
}
