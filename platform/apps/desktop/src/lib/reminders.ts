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
