import type { RunMode } from "../api.ts";
import { MODE_HINTS, MODE_LABELS } from "./labels.ts";

/**
 * 一个维度的选项（v9.4 第 20 批，U1 §1.2：原来“标准 · 先给我看计划”是两组概念叠在一个胶囊上）：
 * “先给我看计划”与“直接做”是标准档位的两种做法，和“每步问我 / 放手做 / 只问答”并列成一张单选表。
 */
export interface ModeOption {
  key: "plan" | "direct" | "manual" | "auto" | "chat";
  mode: RunMode;
  planFirst: boolean;
  label: string;
  hint: string;
}
export function modeOptions(allowed: readonly RunMode[]): ModeOption[] {
  const all: ModeOption[] = [
    { key: "plan", mode: "default", planFirst: true, label: "先给我看计划（推荐）", hint: "先列出要做的步骤，你确认后再开始；要联网或用到当事人信息时先问你" },
    { key: "direct", mode: "default", planFirst: false, label: "直接做", hint: MODE_HINTS.default },
    { key: "manual", mode: "manual", planFirst: true, label: MODE_LABELS.manual, hint: MODE_HINTS.manual },
    { key: "auto", mode: "auto", planFirst: false, label: MODE_LABELS.auto, hint: MODE_HINTS.auto },
    { key: "chat", mode: "chat", planFirst: false, label: MODE_LABELS.chat, hint: MODE_HINTS.chat },
  ];
  return all.filter((o) => allowed.includes(o.mode));
}
/** 胶囊上只写一个短语。 */
export function modeChipLabel(v: { mode: RunMode; planFirst: boolean }): string {
  if (v.mode === "default") return v.planFirst ? "先给我看计划" : "直接做";
  return MODE_LABELS[v.mode].replace("（推荐）", "");
}
/** 开始前确认的“做法”一行（第 27 批，评审 U3-03）：胶囊同名 + 说明的第一分句，如“先给我看计划：先列出要做的步骤，你确认后再开始”。 */
export function modeSheetText(v: { mode: RunMode; planFirst: boolean }): string {
  const o = modeOptions(["chat", "manual", "default", "auto"]).find((x) => isOn(x, v));
  const hint = (o?.hint ?? "").split(/[；;。]/)[0]?.trim();
  return hint ? `${modeChipLabel(v)}：${hint}` : modeChipLabel(v);
}
export const isOn = (o: ModeOption, v: { mode: RunMode; planFirst: boolean }) => o.mode === v.mode && (o.mode !== "default" || o.planFirst === v.planFirst);

