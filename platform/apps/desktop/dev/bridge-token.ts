/**
 * 开发桥令牌（仅开发）：开发桥与 vite 各自启动，先到者生成随机令牌写入 dev/.bridge-token（0600），另一方读取。
 * 浏览器里其他网页不知道令牌，无法经开发桥调用内核（审批、还原等接口在开发形态同样受保护）。
 */
import { randomBytes } from "node:crypto";
import { openSync, readFileSync, writeSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BRIDGE_TOKEN_FILE = fileURLToPath(new URL("./.bridge-token", import.meta.url));

export function bridgeToken(): string {
  if (process.env.ZR_DEV_BRIDGE_TOKEN) return process.env.ZR_DEV_BRIDGE_TOKEN;
  try {
    const fd = openSync(BRIDGE_TOKEN_FILE, "wx", 0o600);
    const token = randomBytes(24).toString("base64url");
    writeSync(fd, token);
    closeSync(fd);
    return token;
  } catch {
    return readFileSync(BRIDGE_TOKEN_FILE, "utf8").trim();
  }
}
