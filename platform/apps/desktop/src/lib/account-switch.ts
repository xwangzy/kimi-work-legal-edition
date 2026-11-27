/**
 * 同一台电脑上换账号（第 68 批，V42，D-294）：登录的是另一个账号时，内核把这台电脑切到那个账号自己的工作空间（或为它登记新设备），
 * 主进程换用那个档案的密钥后重启内核。界面在这期间等“当前档案”变化，再整页重新载入——上一个账号的页面状态、列表、预览一律丢弃，
 * 不会在下一个账号里露出来。
 */
import { api, kernelRestarter } from "../api.ts";
import type { AccountDevice } from "./account.ts";

/** kernel.status 里能区分“哪个档案、是否待激活”的那一部分。纯函数。 */
export function profileMark(st: { profile?: { id?: string | null } | null; onboarding?: unknown } | null | undefined): string {
  return `${st?.profile?.id ?? "-"}|${st?.onboarding ? "onboarding" : "active"}`;
}

/** 登录（或就地移除电脑后继续）的答复是不是“已切换到别的账号”。纯函数。 */
export function isSwitchResult(r: unknown): r is { switched: true; enrolling?: boolean; account?: { name?: string; email?: string } } {
  return !!r && typeof r === "object" && ((r as { switched?: unknown }).switched === true || (r as { next?: unknown }).next === "switch");
}

/**
 * 等内核换到别的档案后整页重新载入（落在首页：上一个账号的事项地址在新账号里没有意义）。before = 切换前的 profileMark。
 * 两分钟仍没换过来调用 onStuck。
 */
export async function waitForProfileSwitch(
  before: string,
  onStuck: (text: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  restart: (() => Promise<{ ok: boolean }>) | null = kernelRestarter(),
): Promise<void> {
  let until = Date.now() + 120_000;
  // 第 72 批（A1 H5 / E5）：两分钟仍没换过来，先在应用内重拉一次内核（主进程 kwl:restart-kernel），成功后再等两分钟；仍不行才请律师处理
  let retried = restart === null;
  // 安全复核 O-1：切换前没取到档案标记（before 为空）时，要先看到内核重启（一次取不到），或至少等 5 秒，免得在内核真正切换前就重新载入
  let restarted = before !== "";
  const since = Date.now();
  while (Date.now() < until) {
    // 第 72 批（06 实测：剩下的耗时大头是轮询的量化等待）：800 → 250 ms
    await sleep(250);
    try {
      const st = await api.kernelStatus();
      if (!restarted && Date.now() - since < 5_000) continue;
      if (st && profileMark(st) !== before) {
        window.location.hash = "#/";
        window.location.reload();
        return;
      }
    } catch {
      // 重启期间内核暂不可用：继续等
      restarted = true;
    }
    if (Date.now() >= until && !retried) {
      retried = true;
      const r = await restart!().catch(() => ({ ok: false }));
      if (r.ok) until = Date.now() + 120_000;
    }
  }
  onStuck(restart ? "还没有切换过去，已自动重新打开一次仍未完成。请关闭并重新打开应用；若仍如此，请联系客服。" : "还没有切换过去。请关闭并重新打开应用；若仍如此，请联系客服。");
}

/** 满额选择卡要的数据（与登录页、换账号同一形状）。 */
export interface DeviceLimitChoice {
  devices: AccountDevice[];
  canUnbind: boolean;
  canSignout: boolean;
  limit: number | null;
  limitKind: "signed_in" | "registered" | null;
  thisDevice: string | null;
  who: string | null;
}

/**
 * 第 72 批：切换工作空间 / 加入团队时，目标工作空间同时登录已满——内核抛 409（detail.reason = device_limit，带电脑列表），
 * 取出选择卡要的数据；不是这种错误返回 null。与 AccountPanel 登录框的 limitOf 同一口径。纯函数。
 */
export function deviceLimitOf(e: unknown, who: string | null = null): DeviceLimitChoice | null {
  const d = (e as { detail?: { reason?: unknown; devices?: unknown; can_unbind?: unknown; can_signout?: unknown; device_limit?: unknown; limit_kind?: unknown; this_device?: unknown } })?.detail;
  if (!d || d.reason !== "device_limit" || !Array.isArray(d.devices) || d.devices.length === 0) return null;
  return {
    devices: d.devices as AccountDevice[],
    canUnbind: d.can_unbind === true,
    canSignout: d.can_signout === true,
    limit: typeof d.device_limit === "number" ? d.device_limit : null,
    limitKind: d.limit_kind === "registered" ? "registered" : d.limit_kind === "signed_in" ? "signed_in" : null,
    thisDevice: typeof d.this_device === "string" ? d.this_device : null,
    who,
  };
}

/** 切换类调用的结果归类：switched = 内核正在换档案（之后整页重载）；same = 已经在这个工作空间；none = 其它（例如 left 但没有可切的）。纯函数。 */
export function switchOutcome(r: unknown): "switched" | "same" | "unsupported" | "none" {
  if (isSwitchResult(r)) return "switched";
  if (r && typeof r === "object" && (r as { supported?: unknown }).supported === false) return "unsupported";
  if (r && typeof r === "object" && (r as { same?: unknown }).same === true) return "same";
  return "none";
}

/** 当前 kernel.status 的档案标记（取不到按空）。 */
export async function currentProfileMark(): Promise<string> {
  try {
    return profileMark(await api.kernelStatus());
  } catch {
    return "";
  }
}
