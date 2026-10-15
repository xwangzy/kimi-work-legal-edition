/**
 * 在线内容更新的律师语言（第 8 批 S6/S7；设置 → 资料来源）：来源一句话、检查结果一句话。不出现工程用语（seq、通道、签名算法）。
 */
import type { ContentCheckResult, ContentStatus } from "../api.ts";

const KIND = { lawdb: "法规库", skills: "方法模板" } as const;

/** 当前用的是哪一份：随安装包 / 在线更新。 */
export function contentSourceLine(kind: "lawdb" | "skills", st: ContentStatus | null): string | null {
  const s = st?.[kind];
  if (!s || !s.source) return null;
  const pending = kind === "skills" && st?.skills?.pending ? "；已下载新版本，下次打开 Kimi Work 时生效" : "";
  return `${KIND[kind]}：${s.source === "installed" ? "在线更新的版本" : "随安装包的版本"}${pending}`;
}

/** 一次检查的结果（律师语言）。 */
export function contentCheckLine(r: ContentCheckResult | null | undefined): string | null {
  if (!r) return null;
  const k = KIND[r.kind];
  switch (r.outcome) {
    case "installed":
      return r.kind === "skills" ? `${k}已更新，下次打开 Kimi Work 时生效` : `${k}已更新，已在使用新版本`;
    case "up_to_date":
      return `${k}已是最新`;
    case "staged_rollout":
      return `${k}有新版本，正在分批推送，稍后会轮到这台电脑`;
    case "not_configured":
      return `本机未开通在线更新：${k}随安装包更新`;
    case "unreachable":
      return `暂时连不上更新服务，${k}继续用当前版本（稍后自动再试）`;
    case "rollback_ignored":
      return `更新服务给出的版本比本机已见过的旧，已忽略（${k}继续用当前版本）`;
    case "reverted":
      return `中软撤回了当前版本，${k}已换回随安装包的版本${r.kind === "skills" ? "（下次打开时生效）" : ""}`;
    case "rejected":
      return `下载的${k}没有通过核对，已丢弃，继续用当前版本`;
    default:
      return null;
  }
}
