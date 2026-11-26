/**
 * 设置 → 备份与安全顶部的三块结论（v9.4）：律师先看一句话结论，细节在下面分块。
 * 只用律师听得懂的话；“执行域、出站闸门”等研发用语留在“管理 → 技术支持”。
 */
import { fmtTime } from "./labels.ts";

export type TileTone = "ok" | "warn" | "info";

/**
 * 案卷安全：计算环境与联网出口都正常、电脑环境没有要 IT 处理的项、也不在退出状态，才写“✓”；任一不满足如实说会受什么影响。
 * 复核 Q1-12：AI 处理要把内容发到云端，不能写“AI 计算时不联网”——不联网的是这台电脑上的计算。
 * 复核 Q1-13：电脑环境自检有警告（如没开 BitLocker、文档在网盘同步）或许可失效时，不能仍显示 ✓。
 */
export function deviceSafetyTile(domainOk: boolean, gateOk: boolean, o: { envWarn?: number; exitMessage?: string | null } = {}): { tone: TileTone; line: string } {
  if (o.exitMessage) return { tone: "warn", line: `新任务已暂停：${o.exitMessage}` };
  if (!domainOk) return { tone: "warn", line: "案卷已加密保存；表格计算暂时用不了，用到时会提示你" };
  if (!gateOk) return { tone: "warn", line: "案卷已加密保存；暂时连不上 AI 和联网检索，用到时会提示你" };
  if ((o.envWarn ?? 0) > 0) return { tone: "warn", line: `案卷加密存在这台电脑上；有 ${o.envWarn} 项电脑设置要请 IT 处理（见下方“电脑环境”）` };
  return { tone: "ok", line: "案卷加密存在这台电脑上；每次发给 AI 的内容都有记录可查" };
}

// ─── 第 56 批：备份与安全页的“一条状态 + 纵向三步” ───

export interface BackupSt {
  packages_created?: number;
  packages_verified?: number;
  latest_package_verified?: boolean;
  recent_packages?: string[];
  configured?: boolean;
  last_ok_at?: string | null;
  stale_days?: number | null;
  last_error?: string | null;
  revoked?: boolean;
}
export type BackupAction = "create" | "verify" | "folder" | "run";
export type StepState = "done" | "now" | "todo";

/** 北京时间“11 月 22 日”（今年不写年）/“11 月 21 日 09:00”。 */
function bjDay(iso: string | null | undefined, withTime = false, now = Date.now()): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 8 * 3600_000);
  const y = d.getUTCFullYear() === new Date(now + 8 * 3600_000).getUTCFullYear() ? "" : `${d.getUTCFullYear()} 年 `;
  const day = `${y}${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
  return withTime ? `${day} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` : day;
}

/**
 * 页首一条状态 + 三步各自的状态与一行摘要。纯函数。
 * 三步有先后：① 生成恢复包 → ② 试着恢复一次（试的是最近一份）→ ③ 每天自动备份（设了位置且成功过、没有连续 3 天失败）。
 * 当前该做的一步是 now，之前的是 done，之后的是 todo（自动备份可以先于“试一次”设好：设好了就算 done）。
 */
export function backupPlan(st: BackupSt | null, now = Date.now()): {
  tone: "ok" | "warn" | "bad" | "info";
  headline: string;
  consequence: string;
  action: { kind: BackupAction; label: string } | null;
  steps: { key: "create" | "verify" | "auto"; state: StepState; summary: string }[];
} {
  if (!st) return { tone: "info", headline: "正在读取备份状态", consequence: "", action: null, steps: [] };
  const created = (st.packages_created ?? 0) > 0;
  const verified = created && (st.latest_package_verified ?? (st.packages_verified ?? 0) > 0);
  const autoFailing = !!st.configured && (!st.last_ok_at || (typeof st.stale_days === "number" && st.stale_days >= 3) || !!st.last_error);
  const autoOk = !!st.configured && !autoFailing;
  const lastPkg = bjDay(st.recent_packages?.[0], false, now);
  const lastOk = bjDay(st.last_ok_at, true, now);
  const done = [created, verified, autoOk];
  const firstTodo = done.indexOf(false);
  const state = (i: number): StepState => (done[i] ? "done" : i === firstTodo ? "now" : "todo");
  const steps = [
    { key: "create" as const, state: state(0), summary: created ? `已生成${lastPkg ? ` · ${lastPkg}` : ""}` : "" },
    { key: "verify" as const, state: state(1), summary: verified ? "试过了，能打开" : "" },
    {
      key: "auto" as const,
      state: state(2),
      summary: autoOk ? `每天自动备份 · 上次 ${lastOk}` : st.configured ? (st.last_error === "location_changed" ? "备份盘不是原来那块" : st.last_ok_at ? `上次成功是 ${lastOk}` : "还没有成功过") : "",
    },
  ];
  if (st.revoked) return { tone: "bad", headline: "这台电脑已从账号移除", consequence: "不能再备份或生成恢复包。", action: null, steps };
  if (!created) return { tone: "warn", headline: "还没有备份", consequence: "电脑坏了或丢了，案卷将无法找回。", action: { kind: "create", label: "生成恢复包" }, steps };
  if (autoFailing)
    return {
      tone: "warn",
      headline: st.last_ok_at ? `自动备份已 ${st.stale_days ?? 0} 天没有成功` : "自动备份还没有成功过",
      consequence: st.last_error === "location_changed" ? "备份盘不是原来那块：请插回原来的备份盘，或重新选择位置。" : "请检查备份位置是否插好、空间是否够。",
      action: { kind: "run", label: "立即备份" },
      steps,
    };
  if (!verified) return { tone: "warn", headline: "恢复包还没试过", consequence: "试着恢复一次，确认恢复码抄对了——等到电脑坏了才发现打不开就晚了。", action: { kind: "verify", label: "试着恢复一次" }, steps };
  if (!st.configured) return { tone: "warn", headline: "还没开每天自动备份", consequence: "恢复包只保住生成那一刻的案卷，之后的新材料与成果要靠每天自动备份。", action: { kind: "folder", label: "选择备份位置" }, steps };
  return { tone: "ok", headline: `备份正常 · 上次自动备份 ${lastOk}`, consequence: "", action: null, steps };
}

/** 备份：没有恢复包或没设自动备份都算“未完成”；超过 3 天没有成功备份要提醒。 */
export function backupTile(st: { packages_created?: number; configured?: boolean; last_ok_at?: string | null; stale_days?: number | null; last_error?: string | null } | null): { tone: TileTone; line: string } {
  if (!st) return { tone: "info", line: "正在读取备份状态" };
  if (!st.packages_created) return { tone: "warn", line: "还没有恢复包：电脑坏了或丢了，案卷将无法找回" };
  if (!st.configured) return { tone: "warn", line: "已有恢复包；还没有设置每天自动备份" };
  if (!st.last_ok_at) return { tone: "warn", line: "自动备份还没有成功过，请检查备份位置" };
  if (typeof st.stale_days === "number" && st.stale_days >= 3) return { tone: "warn", line: `已 ${st.stale_days} 天没有成功备份，请检查备份位置` };
  return { tone: "ok", line: `每天自动备份 · 最近一次 ${fmtTime(st.last_ok_at)}` };
}
