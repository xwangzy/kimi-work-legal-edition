/**
 * 成员离所（v9.3 第 14 批续 B-10；评审 Z4 §五第 5 项、P1-8）的文字：离所的人自己的交接清单、管理员“移出律所”前的提醒、成员表的状态。
 * 律师层不讲“控制成员、中继、密钥、吊销”：说“同事之间同步的管理权”“停用电脑”。纯函数。
 */
import type { OffboardingItem, RosterMember } from "../api.ts";

/** 交接清单的一行：现在的状态与要做的事。 */
export function offboardingRow(it: OffboardingItem): { state: string; action: "archive" | "handoff" | "none"; candidates: OffboardingItem["colleagues"] } {
  if (it.colleagues.length === 0) {
    const where = it.closed ? "已结案" : it.scope === "team" ? "事项里已没有在用的同事" : "只在这台电脑上";
    if (it.status === "ok") return { state: `${where} · 已导出归档`, action: "none", candidates: [] };
    return { state: `${where} · ${it.archived_at ? "导出后又有改动，要重新导出" : "还没有导出归档"}`, action: "archive", candidates: [] };
  }
  if (it.status === "needs_owner") return { state: "除你之外没有别的负责人：交给一位同事", action: "handoff", candidates: it.colleagues };
  if (it.status === "needs_handoff") return { state: "同事之间同步的管理权在你这里：交给一位负责人", action: "handoff", candidates: it.colleagues.filter((c) => c.role === "owner") };
  return { state: "已有别的负责人，不用再做什么", action: "none", candidates: [] };
}

/** 清单顶上的一句话。 */
export function offboardingSummary(r: { matters: OffboardingItem[]; pending: number } | null): string {
  if (!r) return "";
  if (r.matters.length === 0) return "你没有负责的事项，不用交接。请告诉管理员，在“设置 · 管理 · 成员”里把你移出。";
  if (r.pending === 0) return "都交接好了。请把导出的归档交给律所，再告诉管理员在“设置 · 管理 · 成员”里把你移出。";
  return `你负责的 ${r.matters.length} 个事项里，还有 ${r.pending} 个没有交接好。`;
}

/** 管理员“移出律所”前的提醒：后果、本机知道的还没交接的事项、本机看不到的部分。 */
export function removalLines(p: { name: string | null; active_devices: number; matters: { title: string; relay_controller: boolean }[] }): string[] {
  const who = p.name ?? "这位同事";
  const lines = [
    `移出后，${who} 的${p.active_devices > 1 ? ` ${p.active_devices} 台` : ""}电脑不能再同步、不能用 AI、不能签发或导出，并释放 1 个席位。他电脑上已有的事项仍在那台电脑上，无法远程删除——请按律所制度收回电脑；已经复制或导出的文件也收不回来。`,
    `请先确认 ${who} 已在自己电脑的“设置 · 本机与安全 · 离所交接”里交接完：只在他电脑上的事项要导出归档交给律所；这台电脑看不到他自己的事项。`,
  ];
  if (p.matters.length > 0) {
    lines.push(
      `这台电脑知道 ${who} 还负责下面 ${p.matters.length} 个同事一起办的事项、还没交给别人：${p.matters.map((m) => `「${m.title}」`).join("、")}。没交接就移出，这些事项以后加人、移人要联系中软客服。`,
    );
  }
  return lines;
}

/** 成员表的状态一栏。 */
export function memberStatusText(m: Pick<RosterMember, "status" | "is_me" | "removal">): string {
  if (m.status === "removed") return m.removal && !m.removal.seat_released ? "已移出 · 席位还没有释放（会自动再试）" : "已移出";
  if (m.status === "devices_stopped") return "电脑都已停用（还在律所，席位未释放）";
  return m.is_me ? "正常（你）" : "正常";
}

/** 成员显示名：本机不认识的成员（不是在这台电脑上邀请的）给一个看得出是谁的占位。 */
export function memberLabel(m: Pick<RosterMember, "name" | "member_id" | "is_me">): string {
  if (m.name) return m.name;
  if (m.is_me) return "你";
  return `成员 ${m.member_id.slice(-6)}`;
}

/** 离所归档的建议文件名（复核 R15A-15）：不带事项标题（常含当事人名称），用事项编号后六位与日期。 */
export function offboardArchiveName(matterId: string, today = new Date()): string {
  return `离所归档-${matterId.replace(/[^A-Za-z0-9]/g, "").slice(-6)}-${today.toISOString().slice(0, 10)}.zip`;
}
