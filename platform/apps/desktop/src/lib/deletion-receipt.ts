/**
 * 删除回执的律师语言（第 73 批，11c T13）：回执是律师留作合规证明的东西——正文只写这台电脑删了什么、哪些副本还在谁那里、能不能恢复；
 * 内核签名回执里的原话（密钥包裹、令牌表、Agent 会话、签名事件链、同步段、不是读者等实现词）收进“删除清单”展开项，原样保留可核对。纯函数。
 */
export interface ReceiptCopy {
  where: string;
  status: string;
  note: string;
}

/** 副本所在 → 律师看得懂的叫法（内核 copies[].where 原话；没认出的去掉括注）。 */
const WHERE_TEXT: readonly [RegExp, string][] = [
  [/^本机/, "这台电脑"],
  [/^负责人与其他同事的电脑/, "负责人与其他同事的电脑"],
  [/^其他成员设备/, "同事的电脑"],
  [/^律所共享文件夹/, "律所共享文件夹"],
  [/^中软共享中继/, "中软上的加密副本"],
  [/^律所恢复托管/, "律所的恢复托管"],
  [/^已外发的内容/, "已发给 AI 和联网检索的内容（已换成代号）"],
  [/^已导出或下载的文件/, "导出或下载过的文件"],
  [/^本应用的自动备份/, "本应用的自动备份"],
  [/^电脑与律所的系统备份/, "电脑与律所的系统备份"],
  [/^中软通知服务/, "期限提醒（中软通知服务）"],
  [/^已送达其他设备的期限提醒/, "已送到其他设备的期限提醒"],
  [/^挂载原件/, "你文件夹里的原文件"],
];

export function receiptWhere(where: string): string {
  for (const [re, text] of WHERE_TEXT) if (re.test(where)) return text;
  return where.replace(/（[^）]*）/g, "").trim() || where;
}

/** 状态 → 一个短词（“状态”列不折行）。 */
const STATUS_TEXT: Readonly<Record<string, string>> = { deleted: "已删除", kept: "保留", pending: "待删除", irrevocable: "无法撤回" };
export function receiptStatus(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

/** “待删除”按副本说清什么时候删（实拍：系统备份写“待删除”像是本产品会去删）。 */
const PENDING_TEXT: readonly [RegExp, string][] = [
  [/^电脑与律所的系统备份/, "按备份保留期删除"],
  [/^本应用的自动备份/, "下次备份后删除"],
  [/^其他成员设备|^已送达其他设备/, "对方上线后删除"],
  [/^中软通知服务/, "联网后删除"],
];

/** 正文那张表：不涉及的不列；这台电脑排第一。 */
export function receiptRows(copies: readonly ReceiptCopy[]): { where: string; status: string; tone: "deleted" | "kept" | "other" }[] {
  return copies
    .filter((c) => c.status !== "none")
    .map((c) => ({
      where: receiptWhere(c.where),
      status: c.status === "pending" ? (PENDING_TEXT.find(([re]) => re.test(c.where))?.[1] ?? receiptStatus(c.status)) : receiptStatus(c.status),
      tone: c.status === "deleted" ? ("deleted" as const) : c.status === "kept" ? ("kept" as const) : ("other" as const),
    }));
}

/** 标题：用事项名称（内核删除时把名称换成了占位，名称只在删除当时的页面上还知道；不知道时写“已删除的事项”）。 */
export function receiptTitle(localCopy: boolean, title: string | null | undefined): string {
  const head = localCopy ? "已从这台电脑删除" : "已删除这个事项的数据";
  return title ? `${head}：${title}` : localCopy ? "已从这台电脑删除这个事项" : "已删除的事项";
}

/** 能不能恢复（一句）。 */
export function receiptRestoreText(localCopy: boolean): string {
  return localCopy
    ? "这台电脑上删除的内容无法恢复；负责人那边的事项照旧，需要时请负责人重新把你加进来。"
    : "删除的内容无法恢复；标为“待删除”的副本在对方电脑上线、或运维按事项处理后删除。";
}

/** 正文里的回执编号只写前 8 位（去掉 drc_ 前缀）；完整编号在“删除清单”与保存的删除证明里（11d）。纯函数。 */
export function shortReceiptId(id: string): string {
  return id.replace(/^drc_/, "").slice(0, 8);
}
