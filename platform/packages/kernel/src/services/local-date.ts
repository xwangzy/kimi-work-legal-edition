/**
 * 引用核对用的“今天”（复核 R15B-15）：按北京时间取日期——按 UTC 取，北京时间 0 点到 8 点之间会按前一天选法规版本。
 */
const FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

export function localToday(now: Date = new Date()): string {
  return FMT.format(now);
}
