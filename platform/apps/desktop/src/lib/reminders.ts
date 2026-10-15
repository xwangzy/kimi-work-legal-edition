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

/** 本人提醒的“电脑关机时”状态一句话。 */
export function cloudStateText(state: string, configured: boolean): { text: string; tone: "ok" | "warn" | "plain" } {
  if (!configured || state === "local") return { text: "只在这台电脑上提醒（电脑关机时不提醒）", tone: "plain" };
  if (state === "synced") return { text: "电脑关机时，你的其他设备也会收到", tone: "ok" };
  if (state === "pending") return { text: "正在交给中软通知服务…（联网后自动完成）", tone: "plain" };
  if (state === "failed") return { text: "没能交给中软通知服务：这台电脑上照常提醒；可改一下再保存重试", tone: "warn" };
  return { text: "", tone: "plain" };
}

export function audienceText(a: string, collabTeam: boolean): string {
  if (a === "team") return collabTeam ? "提醒事项全体成员" : "只提醒我（个人事项）";
  return "只提醒我";
}

/** 提醒表单的初值：期限日缺省 7 天后、提前 3 天、上午 9 点。 */
export function defaultForm(now = Date.now()): { kind: string; due_date: string; days_before: number; remind_time: string; note: string; audience: "me" | "team" } {
  return { kind: "hearing", due_date: new Date(now + BJ + 7 * 86_400_000).toISOString().slice(0, 10), days_before: 3, remind_time: "09:00", note: "", audience: "me" };
}
