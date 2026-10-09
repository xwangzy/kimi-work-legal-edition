/**
 * IM 连接器契约（方案 v5.0 第 2 篇 §9、第 4 篇 §11.2）——所有平台实现与模拟器都按此形状对接。
 * 固化的方案约束（实现者必须遵守，注释即契约）：
 * - 中软不运营任何 IM 中转：连接器只连「配置的平台端点或本机模拟器」，无中软域名路径；
 * - 「把文件转给机器人」一律单聊（企业微信只能单聊收文件、飞书外部群拿不到文件）；
 * - 卡片回调在 respondWithinMs 内同步应答「已收到」（飞书 3 秒/企业微信 5 秒硬限，本契约按 2 秒设计），
 *   审批结果异步落账本后更新卡片；
 * - 连接器是律所侧唯一消息消费者（租约选主由 firm-node 落实；飞书/钉钉双活属 G1）；
 * - 机器人只供律所内部人员使用；通知/卡片默认不含客户名称与案情（脱敏由调用方保证，契约字段标注）。
 */

export type ImPlatform = "dingtalk" | "feishu" | "wecom" | "simulator";
export type ImChatType = "direct" | "group";

export interface ImFileMessage {
  platform: ImPlatform;
  chatType: ImChatType;
  senderImId: string;
  filename: string;
  mime: string;
  /** 文件字节（协议层大文件分片由连接器内部拼合后交付）。 */
  bytes: Buffer;
  /** 平台消息 ID（回执关联用）。 */
  messageId: string;
}

export interface ImTextMessage {
  platform: ImPlatform;
  chatType: ImChatType;
  senderImId: string;
  text: string;
  messageId: string;
}

export interface ImCardField {
  label: string;
  value: string;
}

/** 卡片（通用形态：标题 + 字段 + 动作按钮；平台适配层翻译成各家卡片 JSON）。 */
export interface ImCard {
  title: string;
  /** 正文字段（**调用方保证脱敏：不得含客户名称/案情**）。 */
  fields?: ImCardField[];
  actions?: { actionId: string; text: string; payload?: Record<string, unknown> }[];
  note?: string;
}

export interface ImCardAction {
  actionId: string;
  actorImId: string;
  payload: Record<string, unknown>;
  /** 同步应答硬限（毫秒）——调用方必须在此之前调 respond()。 */
  respondWithinMs: number;
  /** 同步应答（2 秒内「已收到」；超时模拟器/平台按离线行为处理）。 */
  respond(text: string): Promise<void>;
}

export interface ImConnectorEvents {
  onFileMessage(msg: ImFileMessage): void | Promise<void>;
  onTextMessage?(msg: ImTextMessage): void | Promise<void>;
  onCardAction(action: ImCardAction): void | Promise<void>;
  /** 离线行为计数（钉钉丢消息/飞书重推耗尽/企业微信踢线），控制台可见。 */
  onOfflineEvent?(kind: "dropped_offline" | "resend_exhausted" | "kicked_by_new_connection", detail: string): void;
}

export interface ImConnector {
  readonly platform: ImPlatform;
  start(events: ImConnectorEvents): Promise<void>;
  stop(): Promise<void>;
  /** 在线状态（离线行为语义因平台而异——钉钉丢消息、飞书重推、企业微信踢线）。 */
  isOnline(): boolean;
  sendCard(toImId: string, card: ImCard): Promise<{ cardId: string }>;
  sendFile(toImId: string, file: { filename: string; bytes: Buffer; mime: string }): Promise<void>;
  updateCard(actionContext: { cardId?: string; actionId?: string }, card: ImCard): Promise<void>;
}
