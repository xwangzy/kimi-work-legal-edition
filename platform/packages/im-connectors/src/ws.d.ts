/** ws 的最小类型声明（包内使用面：WebSocket 客户端与 WebSocketServer；与 ws 官方 API 一致）。 */
declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { AddressInfo } from "node:net";

  class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    static readonly CLOSED: number;
    readonly readyState: number;
    constructor(url: string, options?: Record<string, unknown>);
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    on(event: "open" | "message" | "close" | "error", cb: (...args: any[]) => void): this;
    once(event: "open" | "message" | "close" | "error", cb: (...args: any[]) => void): this;
  }
  export default WebSocket;
  export { WebSocket };

  export class WebSocketServer extends EventEmitter {
    constructor(options: { port?: number; host?: string });
    address(): AddressInfo | string | null;
    close(cb?: () => void): this;
    on(event: "listening" | "connection", cb: (...args: any[]) => void): this;
    once(event: "listening" | "connection", cb: (...args: any[]) => void): this;
  }
}
