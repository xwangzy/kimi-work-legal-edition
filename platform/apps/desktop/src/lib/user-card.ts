/**
 * 侧栏底部用户卡的文字（v9.3 第 15 批；复核 R15B-23）。纯函数。
 * 还没取到内核状态（启动中、内核重启的那几秒）时说“正在连接…”，不说“本机 / 开发形态”——那几个字只属于确实没有激活记录的开发形态。
 */
export interface UserCardMe {
  name: string | null;
  firm: string | null;
}

export function userCardText(me: UserCardMe | null, foot: { title: string; note: string }): { name: string; firm: string | null; avatar: string; tooltip: string } {
  const status = foot.note ? `${foot.title}：${foot.note}` : foot.title;
  if (!me) return { name: "正在连接…", firm: null, avatar: "我", tooltip: `设置 · ${status}` };
  return { name: me.name ?? "本机", firm: me.firm ?? "开发形态", avatar: (me.name ?? me.firm ?? "我").slice(0, 1), tooltip: `设置 · ${status}` };
}
