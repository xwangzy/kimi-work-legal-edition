/**
 * 设置 → 本机与安全顶部的三块结论（v9.4）：律师先看一句话结论，细节在下面分块。
 * 只用律师听得懂的话；“执行域、出站闸门”等研发用语留在“管理 → 技术支持”。
 */
import { fmtTime } from "./labels.ts";

export type TileTone = "ok" | "warn" | "info";

/** 案卷安全：计算环境与联网出口都正常才写“✓”；任一不可用如实说会受什么影响。 */
export function deviceSafetyTile(domainOk: boolean, gateOk: boolean): { tone: TileTone; line: string } {
  if (domainOk && gateOk) return { tone: "ok", line: "加密保存在这台电脑上；AI 计算时不联网，联网的每一次都有记录" };
  if (!domainOk) return { tone: "warn", line: "加密保存正常；计算环境暂不可用，需要计算的任务会停下并说明原因" };
  return { tone: "warn", line: "加密保存正常；联网功能暂不可用，检索与模型会停下并说明原因" };
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
