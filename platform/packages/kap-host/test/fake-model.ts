/**
 * 测试用假模型：Unix 套接字上的 OpenAI 兼容 Chat Completions（流式与非流式）。宿主出口把 gate.kwl 的模型请求转到这里。
 * 脚本按请求返回一步：文本、工具调用（可多个）或错误码；记录每个请求（路径、鉴权头、请求体）供断言。
 */
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";

export interface FakeToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type FakeStep = (
  | { text: string; finish?: "stop" | "length" | "content_filter" | null }
  | { toolCalls: FakeToolCall[] }
  | { status: number; body?: unknown }
) & { /** 延迟响应（模拟慢模型或仍在运行的后台子 Agent）。 */ delayMs?: number };

export interface FakeRequest {
  path: string;
  auth: string | undefined;
  body: any;
}

export interface FakeModel {
  socket: string;
  requests: FakeRequest[];
  setScript(fn: (body: any, req: FakeRequest) => FakeStep): void;
  close(): Promise<void>;
}

function sseChunks(step: FakeStep): string[] {
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake" };
  const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
  if ("toolCalls" in step) {
    return [
      JSON.stringify({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: step.toolCalls.map((c, i) => ({ index: i, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }),
      "[DONE]",
    ];
  }
  if ("text" in step) {
    const pieces = step.text.match(/.{1,16}/gsu) ?? [""];
    return [
      ...pieces.map((t, i) => JSON.stringify({ ...base, choices: [{ index: 0, delta: { ...(i === 0 ? { role: "assistant" } : {}), content: t }, finish_reason: null }] })),
      JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: step.finish === undefined ? "stop" : step.finish }], usage }),
      "[DONE]",
    ];
  }
  return [];
}

export async function startFakeModel(socket: string): Promise<FakeModel> {
  rmSync(socket, { force: true });
  const requests: FakeRequest[] = [];
  let script: (body: any, req: FakeRequest) => FakeStep = () => ({ text: "完成。" });
  const respond = (res: import("node:http").ServerResponse, body: any, step: FakeStep): void => {
    if (res.writableEnded || res.destroyed) return;
    if ("status" in step) {
      res.writeHead(step.status, { "content-type": "application/json" });
      res.end(JSON.stringify(step.body ?? { error: { message: `status ${step.status}` } }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const c of sseChunks(step)) res.write(`data: ${c}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if ("toolCalls" in step) {
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: null, tool_calls: step.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
      );
    } else {
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: step.text }, finish_reason: step.finish === undefined ? "stop" : step.finish }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
      );
    }
  };
  const srv: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      const r: FakeRequest = { path: req.url ?? "", auth: req.headers.authorization, body };
      requests.push(r);
      // 宿主出口转给出站闸门时保留 /m/<事项> 前缀（闸门按事项取出站上下文）；替身两种形态都接受
      if ((req.url ?? "").replace(/^\/m\/[A-Za-z0-9_.-]+/, "") !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      let step: FakeStep;
      try {
        step = script(body, r);
      } catch (e) {
        step = { status: 500, body: { error: { message: (e as Error).message } } };
      }
      if (step.delayMs && step.delayMs > 0) {
        setTimeout(() => respond(res, body, step), step.delayMs);
        return;
      }
      respond(res, body, step);
    });
  });
  await new Promise<void>((r) => srv.listen(socket, () => r()));
  return {
    socket,
    requests,
    setScript(fn) {
      script = fn;
    },
    async close() {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

/** 本轮对话里最后一条用户消息的文本。 */
export function lastUserText(body: any): string {
  const msgs: any[] = body?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("\n");
  }
  return "";
}

/** 全部消息文本（含系统提示），用于断言某段内容是否进入了模型上下文。 */
export function allText(body: any): string {
  return JSON.stringify(body?.messages ?? []);
}

/** 已返回过结果的工具调用 ID。 */
export function answeredToolCalls(body: any): Set<string> {
  const s = new Set<string>();
  for (const m of body?.messages ?? []) if (m.role === "tool" && typeof m.tool_call_id === "string") s.add(m.tool_call_id);
  return s;
}
