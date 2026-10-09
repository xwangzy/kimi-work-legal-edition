/**
 * 化名引擎 v0 —— 第一遍规则（方案 v5.0 第 4 篇 §8.2）：
 * 身份证号、手机号、银行卡号、统一社会信用代码、车牌、邮箱等直接标识符的
 * 确定性探测与遮盖；供出站闸门化名校验与 redact.* 工具共用（语义一致）。
 *
 * 后续两遍（词典、NER）在 W7 接入；此处如实声明未覆盖类别。
 */
import { DomainError } from "@zr-legal/domain";

export interface PseudonymFinding {
  type: "id_card" | "mobile" | "bank_card" | "uscc" | "email" | "plate";
  start: number;
  end: number;
  masked: string;
  valid: boolean; // 校验位/算法是否通过（未通过仍标出，人工判断）
}

export const COVERAGE_NOTES: readonly string[] = [
  "v0 覆盖：身份证（含校验位）、手机号、银行卡（Luhn）、统一社会信用代码、邮箱、车牌",
  "未覆盖：自然人姓名（词典与 NER 在 W7 接入）、详细地址、批注/修订/文档属性、图片与扫描件内文字（需 OCR 后另行扫描）",
  "未能确认的对象不静默放行：valid=false 项需人工判断",
];

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID_CHECK = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"] as const;

export function idCardValid(s: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * ID_WEIGHTS[i]!;
  return ID_CHECK[sum % 11] === s[17]!.toUpperCase();
}

export function luhnValid(s: string): boolean {
  if (!/^\d{12,19}$/.test(s)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function mask(s: string, head: number, tail: number): string {
  if (s.length <= head + tail) return "*".repeat(s.length);
  return s.slice(0, head) + "*".repeat(s.length - head - tail) + s.slice(s.length - tail);
}

export function scanDirectIdentifiers(text: string): {
  findings: PseudonymFinding[];
  counts: Record<string, number>;
  coverage_notes: readonly string[];
} {
  if (typeof text !== "string" || text.length === 0) throw new DomainError("validation", "需要非空 text", 422);
  const findings: PseudonymFinding[] = [];

  for (const m of text.matchAll(/\b\d{17}[\dXx]\b/g)) {
    const s = m[0];
    findings.push({ type: "id_card", start: m.index!, end: m.index! + s.length, masked: mask(s, 6, 4), valid: idCardValid(s) });
  }
  for (const m of text.matchAll(/(?<!\d)1[3-9]\d{9}(?!\d)/g)) {
    findings.push({ type: "mobile", start: m.index!, end: m.index! + 11, masked: mask(m[0], 3, 4), valid: true });
  }
  for (const m of text.matchAll(/\b\d{16,19}\b/g)) {
    const s = m[0];
    // 与身份证 18 位重叠的跳过（身份证优先）
    if (s.length === 18 && idCardValid(s)) continue;
    if (luhnValid(s)) findings.push({ type: "bank_card", start: m.index!, end: m.index! + s.length, masked: mask(s, 4, 4), valid: true });
  }
  for (const m of text.matchAll(/(?<![0-9A-Z])[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])/g)) {
    // 与身份证重叠的跳过（身份证优先，避免同一 18 位重复计数）
    if (findings.some((f) => f.type === "id_card" && f.start === m.index)) continue;
    findings.push({ type: "uscc", start: m.index!, end: m.index! + 18, masked: mask(m[0], 2, 4), valid: true });
  }
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    findings.push({ type: "email", start: m.index!, end: m.index! + m[0].length, masked: mask(m[0], 2, 0) + "***", valid: true });
  }
  for (const m of text.matchAll(/[京沪津渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-HJ-NP-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]/g)) {
    findings.push({ type: "plate", start: m.index!, end: m.index! + m[0].length, masked: mask(m[0], 2, 1), valid: true });
  }

  findings.sort((a, b) => a.start - b.start);
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return { findings, counts, coverage_notes: COVERAGE_NOTES };
}

/** 按逆序替换文本中的直接标识符（避免位移）；返回替换后文本与替换数。 */
export function replaceDirectIdentifiers(text: string): { text: string; replaced: number; counts: Record<string, number> } {
  const scan = scanDirectIdentifiers(text);
  const sorted = [...scan.findings].sort((a, b) => b.start - a.start);
  let out = text;
  for (const f of sorted) {
    out = out.slice(0, f.start) + f.masked + out.slice(f.end);
  }
  return { text: out, replaced: sorted.length, counts: scan.counts };
}
