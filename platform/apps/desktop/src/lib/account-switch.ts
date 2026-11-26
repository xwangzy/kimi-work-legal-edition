/**
 * 同一台电脑上换账号（第 68 批，V42，D-294）：登录的是另一个账号时，内核把这台电脑切到那个账号自己的工作空间（或为它登记新设备），
 * 主进程换用那个档案的密钥后重启内核。界面在这期间等“当前档案”变化，再整页重新载入——上一个账号的页面状态、列表、预览一律丢弃，
 * 不会在下一个账号里露出来。
 */
import { api } from "../api.ts";

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
export async function waitForProfileSwitch(before: string, onStuck: (text: string) => void, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  const until = Date.now() + 120_000;
  // 安全复核 O-1：切换前没取到档案标记（before 为空）时，要先看到内核重启（一次取不到），或至少等 5 秒，免得在内核真正切换前就重新载入
  let restarted = before !== "";
  const since = Date.now();
  while (Date.now() < until) {
    await sleep(800);
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
  }
  onStuck("还没有切换过去。请关闭并重新打开应用；若仍如此，请联系客服。");
}

/** 当前 kernel.status 的档案标记（取不到按空）。 */
export async function currentProfileMark(): Promise<string> {
  try {
    return profileMark(await api.kernelStatus());
  } catch {
    return "";
  }
}
