/**
 * 平台模拟器（**模拟器非平台**）：本机 WebSocket 服务器，按连接器契约的平台侧形态模拟
 * 钉钉 Stream / 飞书长连接 / 企业微信单连接的协议与离线行为，供开发与测试全链使用。
 * 协议（JSON 帧，cid 字段为连接实例号）：
 *   → 连接器上行：send_card / send_file / update_card / respond_action / register
 *   ← 模拟器下行：file_msg（file_key + 分片）/ text_msg / card_action / offline_hint
 * 离线语义（config.offlineMode）：
 * - dingtalk：连接器离线期间消息直接丢弃并计 dropped_offline（机器人消息不重投）；
 * - feishu：离线消息入重推队列（重连后补投，最多 4 次），连接器离线期间卡片点击立即报错；
 * - wecom：单连接踢线——新连接踢掉旧连接（旧连接收到 kicked_by_new_connection）。
 * 文件分片：file_msg 以 file_key + chunk_size 切片，连接器逐片拉取（协议层支持大文件；
 * 真 100MB 属真机联调（飞书 <100MB 直下、更大分片，§11.2）。
 */
import { createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { ImCard, ImPlatform } from "./connector.ts";

export interface SimulatorConfig {
  platform: ImPlatform;
  port?: number;
  /** 文件分片大小（字节，默认 64KB）。 */
  chunkSize?: number;
}

interface ClientState {
  ws: WebSocket;
  cid: number;
  online: boolean;
}

export class ImSimulator {
  readonly platform: ImPlatform;
  readonly chunkSize: number;
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientState>();
  private nextCid = 1;
  private files = new Map<string, Buffer>();
  private offlineQueue: unknown[] = [];
  private resendCounts = new WeakMap<ClientState, number>();
  private cardSeq = 0;
  /** 探针全局序号：断言平台侧收到帧的先后（如「同步应答先于落库后的卡片更新」）。 */
  private probeSeq = 0;
  private pendingActions = new Map<string, { respond: (text: string) => void; timer: NodeJS.Timeout; startedAt: number }>();
  /** 测试探针。 */
  readonly probes = {
    sentCards: [] as { to: string; card: ImCard }[],
    sentFiles: [] as { to: string; filename: string; bytes: number }[],
    updatedCards: [] as { seq: number; card: ImCard }[],
    actionResponses: [] as { seq: number; actionId: string; text: string; withinMs: number | null }[],
    droppedOffline: 0,
  };

  private cfg: SimulatorConfig;

  constructor(cfg: SimulatorConfig) {
    this.cfg = cfg;
    this.platform = cfg.platform;
    this.chunkSize = cfg.chunkSize ?? 64 * 1024;
  }

  get port(): number {
    const addr = this.wss?.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/im-sim`;
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: this.cfg.port ?? 0 });
    await new Promise<void>((r) => this.wss!.once("listening", () => r()));
    this.wss.on("connection", (ws) => this.handleConnection(ws));
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.ws.close();
    this.clients.clear();
    await new Promise<void>((r) => this.wss?.close(() => r()));
    this.wss = null;
  }

  private handleConnection(ws: WebSocket): void {
    const client: ClientState = { ws, cid: this.nextCid++, online: true };
    // 企业微信语义：单连接踢线——新连接踢掉旧连接
    if (this.platform === "wecom") {
      for (const old of this.clients) {
        this.send(old, { t: "offline_hint", kind: "kicked_by_new_connection", detail: `cid ${old.cid} 被 cid ${client.cid} 踢线（企业微信单连接语义）` });
        try {
          old.ws.close();
        } catch {
          // 已断开
        }
        this.clients.delete(old);
      }
    }
    this.clients.add(client);
    ws.on("message", (data) => this.handleMessage(client, JSON.parse(String(data))));
    ws.on("close", () => {
      client.online = false;
      this.clients.delete(client);
    });
    // 飞书语义：连接建立时补投离线队列（最多 4 次）
    if (this.platform === "feishu" && this.offlineQueue.length > 0) {
      const n = this.resendCounts.get(client) ?? 0;
      if (n < 4) {
        this.resendCounts.set(client, n + 1);
        for (const frame of this.offlineQueue) this.send(client, frame);
        this.offlineQueue = [];
      } else {
        this.send(client, { t: "offline_hint", kind: "resend_exhausted", detail: "重推次数耗尽（飞书语义：约 7 小时内重推 4 次后不再补投）" });
        this.offlineQueue = [];
      }
    }
  }

  private handleMessage(client: ClientState, msg: any): void {
    switch (msg.t) {
      case "send_card": {
        const cardId = `card_${++this.cardSeq}`;
        this.probes.sentCards.push({ to: msg.to, card: msg.card });
        this.send(client, { t: "ack", id: msg.id, card_id: cardId });
        break;
      }
      case "send_file": {
        this.probes.sentFiles.push({ to: msg.to, filename: msg.filename, bytes: msg.size });
        this.send(client, { t: "ack", id: msg.id });
        break;
      }
      case "update_card": {
        this.probes.updatedCards.push({ seq: ++this.probeSeq, card: msg.card });
        this.send(client, { t: "ack", id: msg.id });
        break;
      }
      case "respond_action": {
        const pending = this.pendingActions.get(msg.action_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingActions.delete(msg.action_id);
          const within = Date.now() - pending.startedAt;
          this.probes.actionResponses.push({ seq: ++this.probeSeq, actionId: msg.action_id, text: msg.text, withinMs: within });
          pending.respond(msg.text);
        }
        break;
      }
      case "file_chunk": {
        const buf = this.files.get(msg.file_key);
        if (!buf) {
          this.send(client, { t: "error", id: msg.id, reason: "file_key 不存在" });
          return;
        }
        const start = msg.offset ?? 0;
        const chunk = buf.subarray(start, start + this.chunkSize);
        this.send(client, { t: "ack", id: msg.id, file_key: msg.file_key, offset: start, eof: start + this.chunkSize >= buf.length, data: chunk.toString("base64"), total: buf.length });
        break;
      }
      default:
        break;
    }
  }

  private send(client: ClientState, frame: unknown): void {
    try {
      client.ws.send(JSON.stringify(frame));
    } catch {
      // 连接已断
    }
  }

  private broadcast(frame: unknown): void {
    const online = [...this.clients].filter((c) => c.online);
    if (online.length > 0) {
      // 飞书/钉钉随机投递其中一条（§11.2）
      const target = online[Math.floor(Math.random() * online.length)]!;
      this.send(target, frame);
      return;
    }
    if (this.platform === "feishu") {
      this.offlineQueue.push(frame);
    } else {
      this.probes.droppedOffline += 1;
    }
  }

  // ─── 测试驱动面（模拟「平台侧」动作） ───

  /** 模拟用户单聊发文件（分片寄存，连接器逐片拉取）。 */
  emitFileMessage(args: { senderImId: string; filename: string; bytes: Buffer; mime?: string; chatType?: "direct" | "group" }): void {
    const fileKey = `fk_${createHash("sha256").update(args.bytes).digest("hex").slice(0, 16)}`;
    this.files.set(fileKey, args.bytes);
    this.broadcast({
      t: "file_msg",
      chat_type: args.chatType ?? "direct",
      sender_im_id: args.senderImId,
      filename: args.filename,
      mime: args.mime ?? "application/octet-stream",
      file_key: fileKey,
      size: args.bytes.length,
      chunk_size: this.chunkSize,
      message_id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    });
  }

  emitTextMessage(args: { senderImId: string; text: string; chatType?: "direct" | "group" }): void {
    this.broadcast({ t: "text_msg", chat_type: args.chatType ?? "direct", sender_im_id: args.senderImId, text: args.text, message_id: `msg_${Date.now().toString(36)}` });
  }

  /** 模拟用户点击卡片动作（返回同步应答文本与计时；连接器必须 2 秒内 respond_action）。 */
  emitCardAction(args: { actionId: string; actorImId: string; payload?: Record<string, unknown>; respondWithinMs?: number }): Promise<{ text: string; withinMs: number }> {
    return new Promise((resolve, reject) => {
      const within = args.respondWithinMs ?? 2000;
      const actionId = args.actionId;
      const timer = setTimeout(() => {
        this.pendingActions.delete(actionId);
        reject(new Error(`同步应答超时（>${within}ms，硬限被击穿）`));
      }, within);
      const startedAt = Date.now();
      this.pendingActions.set(actionId, {
        respond: (text: string) => {
          clearTimeout(timer);
          resolve({ text, withinMs: Date.now() - startedAt });
        },
        timer,
        startedAt,
      });
      this.broadcast({ t: "card_action", action_id: actionId, actor_im_id: args.actorImId, payload: args.payload ?? {}, respond_within_ms: within });
    });
  }
}
