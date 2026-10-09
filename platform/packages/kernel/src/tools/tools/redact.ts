/**
 * redact.scan — 直接标识符确定性扫描（方案第 3 篇 S6 与第 4 篇 §8.2 第一遍规则）。
 * 扫描引擎在 @zr-legal/pseudonym（出站闸门化名校验与本工具共用，语义一致）。
 */
import { scanDirectIdentifiers, COVERAGE_NOTES, idCardValid, luhnValid, type PseudonymFinding } from "@zr-legal/pseudonym";

export type RedactFinding = PseudonymFinding;

export function redactScan(params: { text: string }): {
  findings: RedactFinding[];
  counts: Record<string, number>;
  coverage_notes: readonly string[];
} {
  const scan = scanDirectIdentifiers(params.text);
  return { findings: scan.findings, counts: scan.counts, coverage_notes: COVERAGE_NOTES };
}

export { idCardValid, luhnValid };
