/**
 * 期限提醒的界面文字（第 10 批 S9）：期限类型、“还有几天”、提醒时间、云端状态一句话——律师语言，不出现版本号、密文、设备编号等用语。
 */
export const REMINDER_KINDS: readonly { value: string; label: string }[] = [
  { value: "hearing", label: "开庭" },
  { value: "evidence", label: "举证期限" },
  { value: "appeal", label: "上诉期限" },
  { value: "limitation", label: "诉讼时效" },
  { value: "contract", label: "合同节点" },
  { value: "filing", label: "提交或申报" },
  { value: "other", label: "其他期限" },
];

export function reminderKindLabel(k: string): string {
  return REMINDER_KINDS.find((x) => x.value === k)?.label ?? "期限";
}

const BJ = 8 * 3600_000;
/** 北京时间的“今天”（YYYY-MM-DD）。 */
export function bjToday(now = Date.now()): string {
  return new Date(now + BJ).toISOString().slice(0, 10);
}

/** 期限日距今天几天（北京时间按日计）：0 = 今天，负数 = 已过。 */
export function daysUntil(dueDate: string, now = Date.now()): number {
  const a = Date.parse(`${bjToday(now)}T00:00:00Z`);
  const b = Date.parse(`${dueDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function dueText(dueDate: string, now = Date.now()): string {
  const d = daysUntil(dueDate, now);
  if (d < 0) return `已过 ${-d} 天`;
  if (d === 0) return "今天到期";
  if (d === 1) return "明天到期";
  return `还有 ${d} 天`;
}

/** 到期远近的色调：3 天内红、7 天内橙、其余常规。 */
export function dueTone(dueDate: string, now = Date.now()): "red" | "orange" | "plain" {
  const d = daysUntil(dueDate, now);
  return d <= 3 ? "red" : d <= 7 ? "orange" : "plain";
}

/** 提醒时刻（UTC ISO）→ 北京时间“11月27日 09:00”。 */
export function remindAtText(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = new Date(t + BJ).toISOString();
  return `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日 ${s.slice(11, 16)}`;
}

export function scheduleText(daysBefore: number, time: string): string {
  return daysBefore === 0 ? `当天 ${time} 提醒` : `提前 ${daysBefore} 天 ${time} 提醒`;
}

/** 按期限日、提前天数与几点（北京时间）算出的提醒时刻（UTC ISO，与内核同一算法）。 */
export function plannedRemindAt(dueDate: string, daysBefore: number, time: string): string {
  const [y, m, d] = dueDate.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, d - daysBefore, hh, mm) - BJ).toISOString();
}

/**
 * 提醒时间一句话：设提醒时已经过了“提前 N 天几点”的（期限临近），内核改为立即提醒——如实写出，不再显示原来的“提前 N 天”。
 */
export function scheduleLine(r: { due_date: string; days_before: number; remind_time: string; remind_at: string }): string {
  const planned = plannedRemindAt(r.due_date, r.days_before, r.remind_time);
  if (Date.parse(r.remind_at) > Date.parse(planned)) return `期限临近，设好时已立即提醒（${remindAtText(r.remind_at)}）`;
  return `${scheduleText(r.days_before, r.remind_time)}（${remindAtText(r.remind_at)}）`;
}

/**
 * 本人提醒的“电脑关机时”状态一句话（复核 S10B-13：按实际送达的设备数与通知对象说，只有这一台电脑时不说“其他设备也会收到”）。
 */
export function cloudStateText(state: string, configured: boolean, o: { targets?: number | null; audience?: string } = {}): { text: string; tone: "ok" | "warn" | "plain" } {
  // cancel_pending 的有效提醒 = 云端那份旧版本正在删除，之后只在本机（复核 S10B-25）
  if (!configured || state === "local" || state === "cancel_pending") return { text: "只在这台电脑上提醒（电脑关机时不提醒）", tone: "plain" };
  if (state === "synced") {
    const others = Math.max(0, (o.targets ?? 1) - 1);
    if (others === 0) return { text: "目前只有这台电脑：关机时不会提醒（之后在其他设备登录，还没到时的提醒会自动补发过去）", tone: "plain" };
    return { text: o.audience === "team" ? `电脑关机时，事项成员与你的其他设备共 ${others} 台也会收到` : `电脑关机时，你的其他 ${others} 台设备也会收到`, tone: "ok" };
  }
  if (state === "pending") return { text: "正在发到你的其他设备…（联网后自动完成）", tone: "plain" };
  if (state === "failed") return { text: "没能发到其他设备：这台电脑上照常提醒", tone: "warn" };
  return { text: "", tone: "plain" };
}

/** 收件核对丢弃的原因（律师语言；复核 S10A-04）。 */
export function rejectReasonText(reason: string): string {
  if (reason === "sender_revoked") return "设提醒的那台设备已停用";
  if (reason === "not_member" || reason === "matter_deleted") return "你已不在该事项或事项已删除";
  if (reason.startsWith("held_")) return "一天内都没能核对设提醒的设备";
  return "内容核对不通过";
}

export function audienceText(a: string, collabTeam: boolean): string {
  if (a === "team") return collabTeam ? "提醒事项全体成员" : "只提醒我（个人事项）";
  return "只提醒我";
}

/** 提醒表单的初值：期限日缺省 7 天后、提前 3 天、上午 9 点。 */
export function defaultForm(now = Date.now()): { kind: string; due_date: string; days_before: number; remind_time: string; note: string; audience: "me" | "team" } {
  return { kind: "hearing", due_date: new Date(now + BJ + 7 * 86_400_000).toISOString().slice(0, 10), days_before: 3, remind_time: "09:00", note: "", audience: "me" };
}

/** 期限提醒页的一句话（Z3 #18 / 3.6）：已连接中软通知服务与未连接各一句。纯函数。 */
export function reminderLine(cloudConfigured: boolean): string {
  return cloudConfigured ? "到时在这台电脑上提醒；电脑关机时也会送到你登记的其他设备。" : "到时在这台电脑上提醒；电脑关机时不会提醒。";
}

/** 首页“今天”的近期期限（v9.4）：未结案事项、未撤销、14 天内（含已过 3 天内未处理的），按到期日排序。纯函数。 */
export function upcomingDeadlines<T extends { due_date: string; cloud_state: string; matter_lifecycle: string }>(items: T[], now = Date.now(), withinDays = 14): T[] {
  // 列表只含有效的提醒；cancel_pending 是“云端旧副本正在删除”的有效提醒，照常列出（第 27 批复核 Q8-04：原先也滤掉，改过备注的期限会从首页消失）
  return items
    .filter((r) => r.matter_lifecycle === "active" && r.cloud_state !== "cancelled")
    .filter((r) => {
      const d = daysUntil(r.due_date, now);
      return d >= -3 && d <= withinDays;
    })
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
}

// ─── v9.4 第 20 批：按法定期间推算届满日、从事项导入、过期分组 ───

/** 常用法定期间（推算由内核 calc.deadline 做；期间规则以法律规定为准，起算事实由律师确认）。 */
export const PERIOD_PRESETS: readonly { id: string; label: string; kind: string; unit: "day" | "month" | "year"; n: number }[] = [
  { id: "appeal_judgment", label: "判决上诉期（15 日）", kind: "appeal", unit: "day", n: 15 },
  { id: "appeal_ruling", label: "裁定上诉期（10 日）", kind: "appeal", unit: "day", n: 10 },
  { id: "defense", label: "答辩期（15 日）", kind: "filing", unit: "day", n: 15 },
  { id: "labor_suit", label: "劳动仲裁裁决后起诉（15 日）", kind: "filing", unit: "day", n: 15 },
  { id: "labor_limit", label: "劳动争议仲裁时效（1 年）", kind: "limitation", unit: "year", n: 1 },
  { id: "enforce", label: "申请执行期间（2 年）", kind: "limitation", unit: "year", n: 2 },
  { id: "civil_limit", label: "一般诉讼时效（3 年）", kind: "limitation", unit: "year", n: 3 },
];

/** 事项关键日期的名字 → 期限类型（开庭、举证、上诉；其余“其他”）。 */
export function kindForKey(key: string): string {
  if (/开庭|庭审|hearing/i.test(key)) return "hearing";
  if (/举证|证据|evidence/i.test(key)) return "evidence";
  if (/上诉|appeal/i.test(key)) return "appeal";
  if (/时效|limitation/i.test(key)) return "limitation";
  if (/合同|到期|续约|contract/i.test(key)) return "contract";
  return "other";
}

export interface ImportCandidate {
  matter_id: string;
  matter_title: string;
  source: "key_date" | "todo";
  label: string;
  due_date: string;
  kind: string;
}

/**
 * 从事项导入的候选：关键日期（分析截止日不算）与待办期限；今天及以前的、已经设过同一天同一说明提醒的不列。
 * existing：已有提醒的“事项|日期|说明”。
 */
export function importCandidates(
  matters: readonly { matter_id: string; title: string; key_dates?: Record<string, string> | null; lifecycle?: string }[],
  todos: ReadonlyMap<string, readonly { title: string; due_date?: string | null; status: string }[]>,
  existing: ReadonlySet<string>,
  today: string,
): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  for (const m of matters) {
    if ((m.lifecycle ?? "active") !== "active") continue;
    for (const [k, v] of Object.entries(m.key_dates ?? {})) {
      if (k === "analysis_as_of" || !/^\d{4}-\d{2}-\d{2}$/.test(v ?? "") || v <= today) continue;
      out.push({ matter_id: m.matter_id, matter_title: m.title, source: "key_date", label: k, due_date: v, kind: kindForKey(k) });
    }
    for (const t of todos.get(m.matter_id) ?? []) {
      if (t.status !== "open" || !t.due_date || t.due_date <= today) continue;
      out.push({ matter_id: m.matter_id, matter_title: m.title, source: "todo", label: t.title.slice(0, 60), due_date: t.due_date, kind: "other" });
    }
  }
  return out.filter((c) => !existing.has(`${c.matter_id}|${c.due_date}|${c.label}`)).sort((a, b) => a.due_date.localeCompare(b.due_date));
}

/** 我设的提醒分两组：还没到期的（含今天）在前；已过期的收起（复核 Q1 未改项“提醒页过期分组”）。 */
export function splitByDue<T extends { due_date: string }>(list: readonly T[], now = Date.now()): { upcoming: T[]; past: T[] } {
  return { upcoming: list.filter((r) => daysUntil(r.due_date, now) >= 0), past: list.filter((r) => daysUntil(r.due_date, now) < 0) };
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** 期限日写给人看（第 27 批，评审 U3 规则 11）：“10月28日 周三”，不是今年的加年份；ISO 写法只留在导出与悬停提示。纯函数。 */
export function dueDateText(dueDate: string, now = Date.now()): string {
  const [y, m, d] = dueDate.split("-").map(Number) as [number, number, number];
  if (!y || !m || !d) return dueDate;
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  const sameYear = bjToday(now).slice(0, 4) === String(y);
  return `${sameYear ? "" : `${y}年`}${m}月${d}日 ${wd}`;
}

export type DueBucketKey = "today" | "week" | "later" | "past";
const BUCKET_LABELS: Record<DueBucketKey, string> = { today: "今天到期", week: "7 天内", later: "以后", past: "已过期" };

/**
 * 按到期日看期限（第 27 批，评审 U2-36）：律师按日程看“今天 / 这周 / 以后”，不按提醒来源看。
 * 列表里的都是有效提醒（内核只返回有效的）；cancel_pending 是云端旧副本正在删除的有效提醒，照常列出（复核 Q8-04）。
 * 每组按到期日从近到远（已过期的从最近过期的排起）；空组不返回。纯函数。
 */
export function dueBuckets<T extends { due_date: string; cloud_state?: string }>(list: readonly T[], now = Date.now()): { key: DueBucketKey; label: string; items: T[] }[] {
  const live = list.filter((r) => r.cloud_state !== "cancelled");
  const keyOf = (r: T): DueBucketKey => {
    const d = daysUntil(r.due_date, now);
    return d < 0 ? "past" : d === 0 ? "today" : d <= 7 ? "week" : "later";
  };
  return (["today", "week", "later", "past"] as const)
    .map((key) => {
      const items = live.filter((r) => keyOf(r) === key).sort((a, b) => (key === "past" ? b.due_date.localeCompare(a.due_date) : a.due_date.localeCompare(b.due_date)));
      return { key, label: BUCKET_LABELS[key], items };
    })
    .filter((g) => g.items.length > 0);
}

/**
 * 日程行（第 49 批）：把“我设的提醒”与“收到的提醒”合成一份日程，消除第 48 批“新到的提醒”块与日程列表重复列同一条的问题。
 * - 我设的每条提醒一行；它的未读收件（同一 reminder_id，任意版本）记在 fresh 里，行内标“新”，“知道了”把这些版本标为已读；
 * - 没有对应“我设的提醒”的未读收件（事项成员设的、别的设备送来的、已撤销的）单独成行（received），只能“知道了”；
 * - 已读且没有对应行的收件只进页底“看过的提醒”（history），已读且有对应行的不再重复列。
 * 内核的已读 / 未读语义不变：标为已读仍按 { reminder_id, version } 逐条提交。纯函数。
 */
export interface AgendaEntry<R, I> {
  key: string;
  due_date: string;
  /** 用于 dueBuckets 过滤已撤销（只有我设的提醒有）。 */
  cloud_state?: string;
  reminder: R | null;
  /** 没有对应“我设的提醒”时，收到的那一条（取最新版本）。 */
  received: I | null;
  /** 这一行的未读收件（标“新”；“知道了”提交这些）。 */
  fresh: I[];
}

export function agendaEntries<
  R extends { reminder_id: string; due_date: string; cloud_state: string },
  I extends { reminder_id: string; version: number; due_date: string; read_at: string | null },
>(reminders: readonly R[], inbox: readonly I[]): { entries: AgendaEntry<R, I>[]; history: I[]; unread: I[] } {
  const mine = new Map(reminders.map((r) => [r.reminder_id, r]));
  const unread = inbox.filter((i) => !i.read_at);
  const freshBy = new Map<string, I[]>();
  for (const i of unread) freshBy.set(i.reminder_id, [...(freshBy.get(i.reminder_id) ?? []), i]);
  const entries: AgendaEntry<R, I>[] = reminders.map((r) => ({ key: r.reminder_id, due_date: r.due_date, cloud_state: r.cloud_state, reminder: r, received: null, fresh: freshBy.get(r.reminder_id) ?? [] }));
  for (const [id, items] of freshBy) {
    if (mine.has(id)) continue;
    const latest = [...items].sort((a, b) => b.version - a.version)[0]!;
    entries.push({ key: `in:${id}`, due_date: latest.due_date, reminder: null, received: latest, fresh: items });
  }
  const history = inbox.filter((i) => !!i.read_at && !mine.has(i.reminder_id));
  return { entries, history, unread };
}

/** 倒计时文字的颜色档（与 dueTone 同档，另加已过期）：只用文字颜色表达远近，不再叠色条与底色。 */
export function countTone(dueDate: string, now = Date.now()): "red" | "orange" | "plain" | "past" {
  return daysUntil(dueDate, now) < 0 ? "past" : dueTone(dueDate, now);
}

// ─── 第 56 批“日程”：分组（已过期 / 本周 / 本月 / 以后）、日历叶、标题去重、倒计时胶囊、提醒安排人话、小月历 ───

export type AgendaGroupKey = "past" | "week" | "month" | "later";
const AGENDA_LABELS: Record<AgendaGroupKey, string> = { past: "已过期", week: "本周", month: "本月", later: "以后" };

/**
 * 日程分组：已过期（从最近过期的排起）/ 本周（今天起 7 天内）/ 本月（本月内、7 天以后）/ 以后。北京时间按日计；空组不返回。纯函数。
 * “本周”按“今天起 7 天”滚动算，不按日历周：周日看日程时，后天的开庭仍在“本周”里，不会掉进“本月”。
 */
export function agendaGroups<T extends { due_date: string; cloud_state?: string }>(list: readonly T[], now = Date.now()): { key: AgendaGroupKey; label: string; items: T[] }[] {
  const today = bjToday(now);
  const keyOf = (r: T): AgendaGroupKey => {
    const d = daysUntil(r.due_date, now);
    if (d < 0) return "past";
    if (d <= 7) return "week";
    return r.due_date.slice(0, 7) === today.slice(0, 7) ? "month" : "later";
  };
  const live = list.filter((r) => r.cloud_state !== "cancelled");
  return (["past", "week", "month", "later"] as const)
    .map((key) => ({ key, label: AGENDA_LABELS[key], items: live.filter((r) => keyOf(r) === key).sort((a, b) => (key === "past" ? b.due_date.localeCompare(a.due_date) : a.due_date.localeCompare(b.due_date))) }))
    .filter((g) => g.items.length > 0);
}

/** 日历叶三行：上“11月”（不是今年写“2027 · 1月”）、中大号日“24”、下“周二”。纯函数。 */
export function leafParts(dueDate: string, now = Date.now()): { top: string; day: string; week: string } {
  const [y, m, d] = dueDate.split("-").map(Number) as [number, number, number];
  if (!y || !m || !d) return { top: "", day: dueDate, week: "" };
  const sameYear = bjToday(now).slice(0, 4) === String(y);
  return { top: sameYear ? `${m}月` : `${y} · ${m}月`, day: String(d), week: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]! };
}

/**
 * 一条期限的标题：期限类型 + 备注合成一句，备注已经以类型开头时不重复类型。
 * “开庭：朝阳法院第 12 法庭” → “开庭 · 朝阳法院第 12 法庭”；“举证期限届满” → “举证期限届满”；“上诉期届满”（以“上诉”开头）→ 原样。纯函数。
 */
export function entryTitle(kind: string, note: string): string {
  const label = reminderKindLabel(kind);
  const n = (note ?? "").trim();
  if (!n) return label;
  const sep = /^[\s：:·、,，\-—]+/;
  if (n.startsWith(label)) {
    const rest = n.slice(label.length);
    if (!rest.trim()) return label;
    return sep.test(rest) ? `${label} · ${rest.replace(sep, "")}` : n;
  }
  const stem = label.replace(/期限$/, "");
  if (stem.length >= 2 && n.startsWith(stem)) return n;
  return `${label} · ${n}`;
}

/** 倒计时胶囊：今天写“今天”、过期写“已过 n 天”；3 天内红、7 天内橙、其余中性灰。纯函数。 */
export function countPill(dueDate: string, now = Date.now()): { text: string; tone: "red" | "orange" | "neutral" | "past" } {
  const d = daysUntil(dueDate, now);
  if (d < 0) return { text: `已过 ${-d} 天`, tone: "past" };
  if (d === 0) return { text: "今天", tone: "red" };
  return { text: d === 1 ? "明天" : `还有 ${d} 天`, tone: d <= 3 ? "red" : d <= 7 ? "orange" : "neutral" };
}

/**
 * 提醒安排写成人话：“提前 3 天 9:00 提醒”“当天 9:00 提醒”；已经提醒过的写“已提醒”；
 * 设提醒时已经过了“提前 N 天几点”、内核立即提醒的写“已提醒（设置时已不足 3 天）”。纯函数。
 */
export function scheduleHuman(r: { due_date: string; days_before: number; remind_time: string; remind_at: string; fired?: boolean }, now = Date.now()): string {
  const planned = plannedRemindAt(r.due_date, r.days_before, r.remind_time);
  const time = r.remind_time.replace(/^0(\d)/, "$1");
  if (Date.parse(r.remind_at) > Date.parse(planned)) return r.days_before > 0 ? `已提醒（设置时已不足 ${r.days_before} 天）` : "已提醒（设置时已过提醒时间）";
  if (r.fired || Date.parse(r.remind_at) <= now) return "已提醒";
  return r.days_before === 0 ? `当天 ${time} 提醒` : `提前 ${r.days_before} 天 ${time} 提醒`;
}

export interface MonthCell {
  date: string;
  day: number;
}
/**
 * 小月历的一个月（周一开头，6 行以内）：每格是这个月的日子，月前月后补 null。纯函数。
 * month 从 1 起；跨年由 monthsFrom 处理。
 */
export function monthGrid(year: number, month: number): { key: string; label: string; weeks: (MonthCell | null)[][] } {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0 = 周日
  const lead = (first + 6) % 7; // 周一开头前面补几格
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (MonthCell | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push({ date: `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`, day: d });
  while (cells.length % 7) cells.push(null);
  const weeks: (MonthCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { key: `${year}-${String(month).padStart(2, "0")}`, label: `${year} 年 ${month} 月`, weeks };
}

/** 本月与下月（按北京时间的今天；12 月的下月是次年 1 月）。纯函数。 */
export function monthsFrom(today: string, count = 2): { year: number; month: number }[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return Array.from({ length: count }, (_, i) => {
    const k = m - 1 + i;
    return { year: y + Math.floor(k / 12), month: (k % 12) + 1 };
  });
}

/** 月历上每天的点：取那天最近的一档——3 天内红、7 天内橙、其余灰蓝，已过的灰。纯函数。 */
export function dayMarks(list: readonly { due_date: string; cloud_state?: string }[], now = Date.now()): Map<string, "red" | "orange" | "plain" | "past"> {
  const rank = { red: 3, orange: 2, plain: 1, past: 0 } as const;
  const out = new Map<string, "red" | "orange" | "plain" | "past">();
  for (const r of list) {
    if (r.cloud_state === "cancelled") continue;
    const t = countTone(r.due_date, now);
    const cur = out.get(r.due_date);
    if (!cur || rank[t] > rank[cur]) out.set(r.due_date, t);
  }
  return out;
}
