/**
 * 复核建议（偏离 D-223）：独立复核只有建议、没有“必须改”时不再自动交回修改，意见呈律师；
 * 有必须改而没落实（回看判未落实、修改轮没做完、找不到原会话）的，同样列给律师。律师勾选后，
 * 复用追问链路发出一段“按勾选的意见修改”的指示（追问带 review_apply，内核这一轮不再复核与自动修改）。
 * 意见来自“复核完成”事件里的逐条载荷（代号形态，界面还原）。纯函数。
 */
import type { RunEvent } from "../api.ts";

export type ReviewLevel = "must" | "should" | "recheck" | "risk";
export const REVIEW_LEVEL_LABEL: Record<ReviewLevel, string> = { must: "必须改", should: "建议改", recheck: "建议复算", risk: "风险提示" };

export interface ReviewSuggestion {
  no: number;
  level: ReviewLevel;
  where: string;
  problem: string;
  fix: string;
}

/** suggestions：只有建议、未自动修改；open：必须改回看判未落实；unfinished：交回修改没做完或没能交回。 */
export type PendingReviewMode = "suggestions" | "open" | "unfinished";

const LEVELS = new Set<string>(["must", "should", "recheck", "risk"]);

function itemsOf(payload: any): ReviewSuggestion[] {
  const raw = Array.isArray(payload?.items) ? (payload.items as any[]) : [];
  return raw
    .filter((x) => x && Number.isFinite(Number(x.no)))
    .slice(0, 15)
    .map((x) => ({ no: Number(x.no), level: (LEVELS.has(String(x.level)) ? String(x.level) : "should") as ReviewLevel, where: String(x.where ?? ""), problem: String(x.problem ?? ""), fix: String(x.fix ?? "") }));
}

/** 任务结束后仍待律师处理的复核意见；没有就返回 null。只看最后一次复核（重新运行会再复核一次）。 */
export function pendingReviewSuggestions(events: readonly RunEvent[]): { mode: PendingReviewMode; items: ReviewSuggestion[] } | null {
  let at = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "review.completed") {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const items = itemsOf(events[at]!.payload);
  if (items.length === 0) return null;
  const after = events.slice(at + 1);
  if (after.some((e) => e.type === "review.skipped" && e.payload?.reason === "suggestions_only")) return { mode: "suggestions", items };
  if (after.some((e) => e.type === "review.skipped" && e.payload?.reason === "no_session")) return { mode: "unfinished", items };
  const followUp = [...after].reverse().find((e) => e.type === "review.followup");
  const open = Array.isArray(followUp?.payload?.open) ? (followUp!.payload.open as unknown[]).map(Number) : [];
  if (open.length > 0) {
    const left = items.filter((x) => open.includes(x.no));
    return left.length > 0 ? { mode: "open", items: left } : null;
  }
  const outcome = [...after].reverse().find((e) => e.type === "review.fix_outcome");
  if (outcome && outcome.payload?.status !== "succeeded") return { mode: "unfinished", items };
  return null;
}

/** 发出的修改指示以这句开头；追问框里的文字还以它开头时，追问才带 review_apply。 */
export const REVIEW_APPLY_HEAD = "按独立复核意见修改";

/** 把勾选的意见拼成一段修改指示（作为追问发出；restore 把代号还原成律师看得懂的原文，发出时内核照常换回代号）。纯函数。 */
export function reviewApplyText(items: readonly ReviewSuggestion[], restore: (t: string) => string = (t) => t): string {
  const lines = items.map((x) => {
    const parts = [x.where ? `位置：${restore(x.where)}` : "", `问题：${restore(x.problem)}`, x.fix ? `改法：${restore(x.fix)}` : ""].filter(Boolean);
    return `【${x.no}】（${REVIEW_LEVEL_LABEL[x.level]}）${parts.join("；")}`;
  });
  return [
    `${REVIEW_APPLY_HEAD}（以下是我勾选要采纳的 ${items.length} 条）：`,
    ...lines,
    "请逐条处理：先回到材料与文书核对这条意见是否成立；成立的在最新版文件上直接改（登记为同名文件的新版本，不另起一份），不成立的不改并写明理由；只改涉及的地方。改完在答复末尾写“复核意见处理情况”，逐条写“序号｜已改（改在哪里）／未改（理由）”。",
  ].join("\n");
}
