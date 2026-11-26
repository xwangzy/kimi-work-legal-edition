/**
 * 开始面板的日期栏（第 71 批，区域 6）：原生 `<input type="date">` 在英文系统或浏览器里显示“mm/dd/yyyy”，律师容易把月和日填反
 * （答辩期正是从这个日期起算）。改成中文写法的文字框：可以写“2026-12-15”“2026/12/15”“2026.12.15”“2026年12月15日”“20261215”，
 * 失焦时统一成 YYYY-MM-DD（存给方法参数的仍是这一种）；旁边的日历按钮仍可用系统日历选。纯函数。
 */

/** 把律师写的日期规整成 YYYY-MM-DD；不是有效日期返回 null（空串返回 ""）。 */
export function normalizeDateInput(raw: string): string | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, "");
  if (!s) return "";
  const m = /^(\d{4})(?:[-/.年])(\d{1,2})(?:[-/.月])(\d{1,2})日?$/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > last) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** YYYY-MM-DD → “2026 年 12 月 15 日（星期二）”；不是这种写法返回 null。 */
export function cnDateLabel(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(dt.getTime())) return null;
  return `${Number(m[1])} 年 ${Number(m[2])} 月 ${Number(m[3])} 日（星期${WEEK[dt.getUTCDay()]}）`;
}

/** 日期栏的占位（不出现 mm/dd/yyyy）。 */
export const DATE_PLACEHOLDER = "年-月-日，例如 2026-12-15";
