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

/**
 * 用户卡底部那一行（状态点、一句话、点开去哪）。正常时“本机运行 · 防护正常”；出问题时变色并说明。
 * 有入组申请等这台电脑批准（v9.3 B-3 余项）：亮橙点、说“有 N 位同事等你批准入组”，点开直接到“管理 · 成员”；
 * 联网记录需要核对比它更要紧，排在前面。
 */
export function sidebarFoot(s: { gate: boolean | null; unresolved: number; execOk: boolean | null; pendingJoins: number }): {
  title: string;
  note: string;
  tone: "dot-off" | "dot-warn" | "dot-ok";
  href: string;
} {
  if (s.gate === null) return { title: "正在启动…", note: "", tone: "dot-off", href: "/connections/device" };
  if (s.unresolved > 0) return { title: "有联网记录需要核对", note: `${s.unresolved} 条因中断无法确认是否发出`, tone: "dot-warn", href: "/connections/device" };
  if (s.pendingJoins > 0) return { title: `有 ${s.pendingJoins} 位同事等你批准入组`, note: "", tone: "dot-warn", href: "/connections/admin" };
  if (s.execOk === false) return { title: "本机运行 · 代码分析暂不可用", note: "其余功能正常", tone: "dot-warn", href: "/connections/device" };
  return { title: "本机运行 · 防护正常", note: "", tone: "dot-ok", href: "/connections" };
}
