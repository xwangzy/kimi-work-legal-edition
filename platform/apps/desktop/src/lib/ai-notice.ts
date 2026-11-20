/**
 * 首次使用 AI 的数据去向告知（第 51 批，D-216）。告知对象是律师本人：数据去哪、谁处理、AI 结果都是草稿须你核对。
 * 它不是客户授权（客户授权按事项另记，见 lib/authorization.ts），也不是闸门：看过一次（按告知版本）就不再出现；
 * 内核没有这个接口（旧版本）或读取失败时不拦，照常继续。界面由 components/AiNotice.tsx 的宿主渲染（挂在 AskHost 里）。
 */
export interface AiNoticeState {
  version: string;
  needs_ack: boolean;
}

type Host = (version: string) => Promise<boolean>;
let host: Host | null = null;

export function setAiNoticeHost(h: Host | null): void {
  host = h;
}

/**
 * 发起 AI 之前调用：需要告知时弹出说明，律师点“我知道了，继续”后记下版本并返回 true；点“先不用”返回 false（调用方不发起）。
 * get / ack 由调用方传入（便于单测）。
 */
export async function ensureAiNotice(get: () => Promise<AiNoticeState>, ack: (version: string) => Promise<unknown>): Promise<boolean> {
  let st: AiNoticeState;
  try {
    st = await get();
  } catch {
    return true;
  }
  if (!st.needs_ack || !host) return true;
  const ok = await host(st.version);
  if (!ok) return false;
  // 记录失败不拦（下次再说明一次）
  await ack(st.version).catch(() => undefined);
  return true;
}

/** 律师点了“先不用”时给调用方的说明。 */
export const AI_NOTICE_DECLINED = "没有开始：你选择了先不用 AI。需要时再点开始即可。";
