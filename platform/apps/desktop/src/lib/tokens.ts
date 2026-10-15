/**
 * 代号还原（v9 第 02 篇 §8.4、第 06 篇 T20）：Agent 与模型只见令牌形态；律师在可信界面看到还原后的原文。
 * 还原结果只存在于渲染进程内存（按事项与代号缓存），不落盘、不回传 Agent、不进日志。
 */
import { api } from "../api.ts";

/** 与 @zr-legal/tokenizer 的 TOKEN_RE 一致（类别 + 6 位或冲突时 10 位 Crockford）。 */
export const TOKEN_RE = /〔(自然人|机构|证件号|电话|账号|信用代码|地址|车牌|邮箱|案号|出生日期)·([0-9A-HJKMNP-TV-Z]{6}|[0-9A-HJKMNP-TV-Z]{10})〕/g;
const SEP = "␞";

const cache = new Map<string, Map<string, string | null>>();

/** 返回 代号 → 原文（无法还原的为 null：未知代号或冲突代号，界面原样显示）。 */
export async function restoreTokens(matterId: string, text: string): Promise<Map<string, string | null>> {
  const tokens = [...new Set(Array.from(text.matchAll(TOKEN_RE), (m) => m[0]))];
  let known = cache.get(matterId);
  if (!known) {
    known = new Map();
    cache.set(matterId, known);
  }
  const missing = tokens.filter((t) => !known!.has(t));
  if (missing.length > 0) {
    const r = await api.restore(matterId, missing.join(SEP));
    const parts = r.text.split(SEP);
    missing.forEach((t, i) => {
      const v = parts[i];
      known!.set(t, v && v !== t ? v : null);
    });
  }
  return new Map(tokens.map((t) => [t, known!.get(t) ?? null]));
}

export function forgetRestored(matterId?: string): void {
  if (matterId) cache.delete(matterId);
  else cache.clear();
}

export type TokenSegment = { kind: "text"; text: string } | { kind: "token"; token: string; value: string | null };

export function splitTokens(text: string, map: Map<string, string | null>): TokenSegment[] {
  const out: TokenSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    out.push({ kind: "token", token: m[0], value: map.get(m[0]) ?? null });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** 纯文本还原（复制、导出到剪贴板时用）。 */
/** 按字截断，但不把代号切成半截（复核 S6B-14）；截掉了就加省略号。 */
export function cutKeepingTokens(s: string, n: number): string {
  const cs = [...s];
  if (cs.length <= n) return s;
  let cut = cs.slice(0, n).join("");
  const open = cut.lastIndexOf("〔");
  if (open > cut.lastIndexOf("〕")) cut = cut.slice(0, open);
  return `${cut}…`;
}

export function restoredPlain(text: string, map: Map<string, string | null>): string {
  return text.replace(TOKEN_RE, (t) => map.get(t) ?? t);
}
