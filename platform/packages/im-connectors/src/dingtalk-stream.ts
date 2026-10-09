/**
 * 钉钉 Stream 骨架连接器（方案 §11.2：Stream 模式，出站 443，无需公网 IP/域名/白名单）。
 * **按钉钉 Stream 公开文档形态实现**：WebSocket 长连接、注册/心跳/自动重连（指数退避）、
 * 机器人消息帧、以「下载码换取文件」的协议占位（downloadCode → 分片拉取）。
 * 真实平台联调需律所自建应用凭据（appKey/appSecret 与真实端点，属部署工作）——
 * 本骨架的协议面与平台模拟器一致，测试经模拟器全链验证；凭据注入后经 `endpoint` 切换。
 */
import WebSocket from "ws";
import type { ImCard, ImConnector, ImConnectorEvents, ImPlatform } from "./connector.ts";

export interface DingtalkStreamConfig {
  /** 端点（真实 wss://open-stream.dingtalk.com 或本机模拟器 ws://127.0.0.1:port/im-sim）。 */
  endpoint: string;
  /** 真实平台凭据（部署注入；模拟器形态留空）。 */
  appKey?: string;
  appSecret?: string;
  /** 心跳间隔（默认 30s）。 */
  heartbeatMs?: number;
  /** 最大重连退避（默认 30s）。 */
  maxBackoffMs?: number;
}

interface PendingReq {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DingtalkStreamConnector implements ImConnector {
  readonly platform: ImPlatform = "dingtalk";
  private ws: WebSocket | null = null;
  private events: ImConnectorEvents | null = null;
  private online = false;
  private stopped = false;
  private backoff = 500;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private pending = new Map<string, PendingReq>();
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;

  /** 首次 'open' 即就绪（等待 WS 连接建立；模拟器/平台在此之前广播会按离线语义丢弃）。 */
  waitReady(timeoutMs = 10_000): Promise<void> {
    if (this.online) return Promise.resolve();
    this.readyPromise ??= new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      setTimeout(() => reject(new Error("连接器就绪超时")), timeoutMs).unref();
    });
    return this.readyPromise;
  }

  private cfg: DingtalkStreamConfig;

  constructor(cfg: DingtalkStreamConfig) {
    this.cfg = cfg;
  }

  isOnline(): boolean {
    return this.online;
  }

  async start(events: ImConnectorEvents): Promise<void> {
    this.events = events;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.online = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      this.ws?.close();
    } catch {
      // 已断开
    }
    this.ws = null;
  }

  private connect(): void {
    const ws = new WebSocket(this.cfg.endpoint);
    this.ws = ws;
    ws.on("open", () => {
      this.online = true;
      this.backoff = 500;
      this.readyResolve?.();
      this.readyResolve = null;
      // 注册（真实平台为 appKey/appSecret 握手帧；模拟器忽略）
      ws.send(JSON.stringify({ t: "register", appKey: this.cfg.appKey ?? "", ts: Date.now() }));
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping", ts: Date.now() }));
        } catch {
          // 忽略
        }
      }, this.cfg.heartbeatMs ?? 30_000);
      if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    });
    ws.on("message", (data) => void this.handleFrame(JSON.parse(String(data))));
    ws.on("close", () => {
      this.online = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("连接断开"));
      }
      this.pending.clear();
      if (!this.stopped) {
        const wait = this.backoff;
        this.backoff = Math.min(this.backoff * 2, this.cfg.maxBackoffMs ?? 30_000);
        setTimeout(() => {
          if (!this.stopped) this.connect();
        }, wait).unref();
      }
    });
    ws.on("error", () => {
      // close 事件随后到来，统一走重连
    });
  }

  private async handleFrame(msg: any): Promise<void> {
    const ev = this.events;
    if (!ev) return;
    switch (msg.t) {
      case "ack": {
        const p = this.pending.get(String(msg.id));
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(String(msg.id));
          p.resolve(msg);
        }
        break;
      }
      case "file_msg": {
        // 下载码换取文件（协议占位：分片拉取拼合）
        const bytes = await this.downloadFile(msg.file_key, msg.size, msg.chunk_size);
        await ev.onFileMessage({
          platform: this.platform,
          chatType: msg.chat_type === "group" ? "group" : "direct",
          senderImId: String(msg.sender_im_id),
          filename: String(msg.filename),
          mime: String(msg.mime ?? "application/octet-stream"),
          bytes,
          messageId: String(msg.message_id ?? ""),
        });
        break;
      }
      case "text_msg": {
        await ev.onTextMessage?.({
          platform: this.platform,
          chatType: msg.chat_type === "group" ? "group" : "direct",
          senderImId: String(msg.sender_im_id),
          text: String(msg.text ?? ""),
          messageId: String(msg.message_id ?? ""),
        });
        break;
      }
      case "card_action": {
        const respondWithinMs = Number(msg.respond_within_ms ?? 2000);
        await ev.onCardAction({
          actionId: String(msg.action_id),
          actorImId: String(msg.actor_im_id),
          payload: (msg.payload ?? {}) as Record<string, unknown>,
          respondWithinMs,
          respond: async (text: string) => {
            this.sendFrame({ t: "respond_action", action_id: msg.action_id, text });
          },
        });
        break;
      }
      case "offline_hint": {
        await ev.onOfflineEvent?.(msg.kind, String(msg.detail ?? ""));
        break;
      }
      default:
        break;
    }
  }

  /** 以「下载码」分片拉取文件（协议层支持大文件；真 100MB 属真机联调）。 */
  private async downloadFile(fileKey: string, size: number, chunkSize: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const r = await this.request({ t: "file_chunk", file_key: fileKey, offset });
      parts.push(Buffer.from(String(r.data ?? ""), "base64"));
      offset += chunkSize;
      if (r.eof || offset >= size) break;
    }
    return Buffer.concat(parts);
  }

  private request(frame: Record<string, unknown>, timeoutMs = 10_000): Promise<any> {
    const id = `req_${++this.seq}_${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("请求超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendFrame({ ...frame, id });
    });
  }

  private sendFrame(frame: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      // 已断开
    }
  }

  async sendCard(toImId: string, card: ImCard): Promise<{ cardId: string }> {
    const r = await this.request({ t: "send_card", to: toImId, card });
    return { cardId: String(r.card_id ?? "") };
  }

  async sendFile(toImId: string, file: { filename: string; bytes: Buffer; mime: string }): Promise<void> {
    await this.request({ t: "send_file", to: toImId, filename: file.filename, mime: file.mime, size: file.bytes.length, data: file.bytes.toString("base64") });
  }

  async updateCard(ctx: { cardId?: string; actionId?: string }, card: ImCard): Promise<void> {
    await this.request({ t: "update_card", card_id: ctx.cardId ?? "", action_id: ctx.actionId ?? "", card });
  }
}
