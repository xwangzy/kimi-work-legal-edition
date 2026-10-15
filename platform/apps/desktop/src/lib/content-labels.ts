/**
 * 在线内容更新的律师语言（第 8 批 S6/S7；设置 → 资料来源）：来源一句话、检查结果一句话。不出现工程用语（序号、通道、签名、凭据）。
 * 复核 S8B-03/13、S8A-13：本机出错、授权不可用、版本信息过期分别说明；检查失败保留上次结果并给一句提示；长期没能确认最新时提示。
 */
import type { ContentCheckResult, ContentStatus } from "../api.ts";

const KIND = { lawdb: "法规库", skills: "方法模板" } as const;

/** 面板说明（复核 S8B-13①：不出现“签名”“席位凭据”）。 */
export const CONTENT_PANEL_NOTE = "法规库与方法模板由中软发布，下载后在本机核对无误才使用；只用本所的使用授权，不发送任何案件信息";
/** 调用“检查更新”本身失败（复核 S8B-03）。 */
export const CONTENT_CHECK_FAILED = "这次没有检查成功，继续用当前版本，可稍后再试";
/** 超过这么久没能确认“已是最新”就提示（复核 S8A-13：清单有效期最长 90 天，取其 2/3）。 */
export const STALE_AFTER_MS = 60 * 86_400_000;

/** 当前用的是哪一份：随安装包 / 在线更新，以及待生效的变化。 */
export function contentSourceLine(kind: "lawdb" | "skills", st: ContentStatus | null): string | null {
  const s = st?.[kind];
  if (!s || !s.source) return null;
  if (kind === "skills" && st?.skills?.revoked_pending_restart && !st.skills.pending) return `${KIND[kind]}：在线更新的版本（已被中软撤回，下次打开 Kimi Work 时换回随安装包的版本）`;
  const base = `${KIND[kind]}：${s.source === "installed" ? "在线更新的版本" : "随安装包的版本"}`;
  if (kind === "skills" && st?.skills?.pending) return `${base}；已下载新版本，下次打开 Kimi Work 时生效`;
  if (kind === "lawdb" && st?.lawdb?.pending) return `${base}；已下载新版本，进行中的任务结束后启用`;
  return base;
}

/** 一次检查的结果（律师语言）。 */
export function contentCheckLine(r: ContentCheckResult | null | undefined): string | null {
  if (!r) return null;
  const k = KIND[r.kind];
  switch (r.outcome) {
    case "installed":
      if (r.kind === "skills") return `${k}已更新，下次打开 Kimi Work 时生效`;
      return r.pending_swap ? `${k}已更新，进行中的任务结束后启用新版本` : `${k}已更新，已在使用新版本`;
    case "up_to_date":
      return `${k}已是最新`;
    case "staged_rollout":
      return `${k}有新版本，正在分批推送，稍后会轮到这台电脑`;
    case "not_configured":
      return `本机未开通在线更新：${k}随安装包更新`;
    case "unreachable":
      return `暂时连不上更新服务，${k}继续用当前版本（稍后自动再试）`;
    case "unauthorized":
      return `这台电脑的使用授权暂不可用（例如尚未联网续期），${k}继续用当前版本`;
    case "stale":
      return `更新服务给出的版本信息已过期，${k}暂不更新；如持续出现请联系管理员`;
    case "rollback_ignored":
      return `更新服务给出的版本比本机现有的旧，已忽略（${k}继续用当前版本）`;
    case "reverted":
      return `中软撤回了当前版本，${k}${r.kind === "skills" ? "下次打开时换回随安装包的版本" : "已换回随安装包的版本"}`;
    case "rejected":
      return `下载的${k}没有通过核对，已丢弃，继续用当前版本；如反复出现请联系管理员`;
    case "failed":
      return `这次${k}更新没有装上（这台电脑上出错），继续用当前版本；如反复出现请联系管理员`;
    case "skipped":
      return `这台电脑目前处于停用状态，暂不检查${k}更新`;
    default:
      return null;
  }
}

/** 长期没能确认“已是最新”（复核 S8A-13：分发方一直给过期清单时，界面要能看出来）。 */
export function contentStaleLine(kind: "lawdb" | "skills", st: ContentStatus | null, now: number): string | null {
  const s = st?.[kind];
  if (!st?.configured || !s?.last_check) return null;
  const confirmed = s.last_confirmed_at ? Date.parse(s.last_confirmed_at) : null;
  if (confirmed !== null && now - confirmed < STALE_AFTER_MS) return null;
  if (confirmed === null && ["up_to_date", "installed"].includes(s.last_check.outcome)) return null;
  return `已有一段时间没能确认${KIND[kind]}是最新的；如持续出现请联系管理员`;
}
