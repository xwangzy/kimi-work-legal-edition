/**
 * 问答回答里的引用核对（v9.3 第 15 批 B-6；评审 Z1 P1-5）：内核按本机法规库离线核对，这里只把结果写成律师看得懂的一行与逐条状态。纯函数。
 * 口径与签发门禁一致：核到法规库的只说“来源与条号对得上”，内容是否支持观点仍要律师判断。
 */
export interface QaCitationsView {
  total: number;
  verified: number;
  wrong: number;
  outside: number;
  cases: number;
  items: { raw: string; kind: "wrong" | "case" | "outside" | "ok"; reason: string | null; partial?: boolean }[];
  partial?: number;
  unrecognized?: number;
  unchecked?: boolean;
}

export function qaCitationLine(c: QaCitationsView): { text: string; tone: "ok" | "warn" | "bad" } {
  if (c.unchecked) return { text: "引用没有核对成功：请自行核对回答里的法条与案号。", tone: "warn" };
  const parts = [
    c.verified ? `${c.verified} 条在本机法规库核到${c.partial ? `（其中 ${c.partial} 条只核到条号）` : ""}，内容是否支持观点请自行判断` : "",
    c.wrong ? `${c.wrong} 条条号对不上（超出总条数或已改号）` : "",
    c.outside ? `${c.outside} 条系统没法核对（法规库没有收录，或款项、适用版本对不上），请自行核对` : "",
    c.cases ? `${c.cases} 个案号离线没法核对` : "",
    c.unrecognized ? `另有 ${c.unrecognized} 处“第X条”没认出是哪部法，请自行核对` : "",
  ].filter(Boolean);
  return { text: `引用核对：${parts.join("；")}`, tone: c.wrong ? "bad" : c.outside || c.cases || c.unrecognized ? "warn" : "ok" };
}

export const QA_CITATION_KIND: Record<QaCitationsView["items"][number]["kind"], string> = {
  ok: "核到",
  wrong: "对不上",
  outside: "法规库外",
  case: "案号未核",
};
