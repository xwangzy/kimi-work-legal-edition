/**
 * Mock provider：确定性离线提供方（开发/评测/探针用）。
 * - 同一输入 → 同一输出（可复现）；
 * - 模拟前缀缓存：相同稳定前缀在 5 分钟内记为命中，首次记缓存写入（探针 9 口径）；
 * - 明确标识：requestId 带 mock 前缀，去向记录 destination=mock_local，永不冒充真实供应商。
 */
import { createHash } from "node:crypto";
import { DomainError } from "@zr-legal/domain";
import type { ChatRequest, Provider, ProviderResult, ProviderStream, ToolCall, UpstreamMeta, UsageBuckets } from "./types.ts";
import { emptyUsage, estimateTokens } from "./types.ts";
import type { RouteDef } from "../config.ts";

interface CacheEntry {
  tokens: number;
  firstSeen: number;
  lastSeen: number;
}

const prefixCache = new Map<string, CacheEntry>();
let counter = 0;

/**
 * 红队脚本化响应（方案 v5.0 §16.2 A1 注入红队 v0；仅供测试注入）：
 * - 双重门禁：测试文件须先设置进程环境 ZR_MOCK_SCRIPT=1，再调用 __setMockScriptForTests 装配；
 *   生产路径不设置该变量、也不调用该函数，缺省行为与无脚本时逐字节一致；
 * - 脚本返回 null 表示该次请求回落到默认确定性行为；
 * - 用途：模拟「被注入的模型」返回预设 tool_calls（内置工具/跨事项/不存在工具），
 *   验证引擎执行层与内核工具层的拒绝链。
 */
export interface MockScriptedReply {
  toolCalls?: ToolCall[];
  content?: string;
  /** 流式分块间隔（测试“在途流被中止”用；缺省 0）。 */
  chunkDelayMs?: number;
}
export type MockScript = (req: ChatRequest) => MockScriptedReply | null;
let activeScript: MockScript | null = null;

export function __setMockScriptForTests(script: MockScript | null): void {
  if (script !== null && process.env.ZR_MOCK_SCRIPT !== "1") {
    throw new Error("mock 脚本化响应仅供测试注入：需进程显式设置 ZR_MOCK_SCRIPT=1（生产路径不得设置该变量、不得调用本函数）");
  }
  activeScript = script;
}

function prefixKey(messages: { role: string; content: string }[]): string {
  // 稳定前缀：连续 system 部分（提示组装约定：系统→方法包→盐值块→覆盖层→材料→任务）
  const sys = messages.filter((m) => m.role === "system").map((m) => messageText(m)).join("\n");
  return createHash("sha256").update(sys).digest("hex");
}

function mockContent(req: ChatRequest): string {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const seed = createHash("sha256").update(JSON.stringify(req.messages)).digest("hex").slice(0, 12);
  const schema = (req.response_format as any)?.json_schema?.schema;
  if (schema?.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(schema.properties)) {
      if (v.type === "array") out[k] = [v.items?.type === "object" ? { _mock: seed } : `mock_${seed}`];
      else if (v.type === "integer" || v.type === "number") out[k] = 0;
      else if (v.type === "boolean") out[k] = false;
      else out[k] = `mock_${k}_${seed}`;
    }
    return JSON.stringify(out);
  }
  // 工具结果已返回 → 产出总结性终答
  const toolMsgs = req.messages.filter((m: any) => m.role === "tool");
  if (toolMsgs.length > 0) {
    const lastTool = toolMsgs.at(-1)! as any;
    const body = typeof lastTool.content === "string" ? lastTool.content : JSON.stringify(lastTool.content);
    let intercepted = "0";
    let suggestion = "";
    try {
      const parsed = JSON.parse(body);
      intercepted = String(parsed?.summary?.intercepted ?? "0");
      suggestion = parsed?.intercepted?.[0]?.suggestion ?? "";
    } catch {
      // 非 JSON 工具结果
    }
    return [
      `【mock 法律分析 ${seed}】`,
      `已调用法律工具完成核验（${toolMsgs.length} 次工具调用）。`,
      `引用核验结论：拦截 ${intercepted} 条。${suggestion ? `处理建议：${suggestion}` : ""}`,
      "基于已核验依据的分析：该保密条款所引《律师法》条文需按适用时点更新后方可作为有效依据；建议按拦截提示改引后再进入复核。",
      "（本结果由离线 mock 提供方生成，用于链路演示，不构成法律意见。）",
    ].join("\n");
  }
  return [
    `【mock 分析结果 ${seed}】`,
    `收到 ${req.messages.length} 条消息；最后用户输入约 ${estimateTokens(messageText(lastUser))} tokens。`,
    "本结果由离线 mock 提供方生成，仅用于链路开发，不构成任何法律分析。",
  ].join("\n");
}

function messageText(m: any): string {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) return m.content.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n");
  return "";
}

/** 是否应发起一次工具调用（离线演示 agent→MCP 法律工具全链路）。 */
function mockToolCall(req: ChatRequest): ToolCall | null {
  if (!Array.isArray(req.tools) || req.tools.length === 0) return null;
  if (req.messages.some((m: any) => m.role === "tool")) return null; // 已调用过
  const text = req.messages.filter((m) => m.role === "user").map(messageText).join("\n");
  if (!/核验|引用|律师法|法条/.test(text)) return null;
  const hasCitationsTool = req.tools.some((t: any) => /citations/i.test(t?.function?.name ?? t?.name ?? ""));
  if (!hasCitationsTool) return null;
  const toolEntry = req.tools.find((t: any) => /citations/i.test(t?.function?.name ?? t?.name ?? "")) as any;
  const name = toolEntry?.function?.name ?? toolEntry?.name;
  return {
    id: `call_mock_${createHash("sha256").update(text).digest("hex").slice(0, 10)}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify({ text: text.slice(0, 4000), as_of: "2026-10-01", topic_hint: "保密义务" }),
    },
  };
}

function computeUsage(req: ChatRequest, content: string, effort: string | null): UsageBuckets {
  const now = Date.now();
  const key = prefixKey(req.messages);
  // content 可能是字符串或内容块数组（工具结果/多模态形态）——统一经 messageText 归一
  const sysTokens = req.messages.filter((m) => m.role === "system").reduce((n, m) => n + estimateTokens(messageText(m)), 0);
  const restTokens = req.messages.filter((m) => m.role !== "system").reduce((n, m) => n + estimateTokens(messageText(m)), 0);
  const usage = emptyUsage();
  const hit = prefixCache.get(key);
  if (hit && now - hit.lastSeen < 5 * 60_000) {
    usage.cached_input = hit.tokens;
    hit.lastSeen = now;
  } else {
    usage.cache_write = sysTokens;
    prefixCache.set(key, { tokens: sysTokens, firstSeen: now, lastSeen: now });
  }
  usage.uncached_input = restTokens;
  usage.output = estimateTokens(content);
  if (effort === "max") usage.reasoning = Math.ceil(usage.output * 2);
  else if (effort === "high") usage.reasoning = Math.ceil(usage.output * 1);
  else if (effort === "low") usage.reasoning = Math.ceil(usage.output * 0.25);
  return usage;
}

/** 按（至多一次求值的）脚本结果生成响应：脚本可能有副作用（例如“只触发一次”），同一请求不得重复求值。 */
function respond(route: RouteDef, req: ChatRequest, scripted: MockScriptedReply | null): ProviderResult {
  const toolCall = scripted?.toolCalls?.[0] ?? (scripted ? null : mockToolCall(req));
  const content = toolCall ? null : (scripted?.content ?? mockContent(req));
  const usage = computeUsage(req, content ?? JSON.stringify(toolCall?.function.arguments ?? ""), req.reasoning_effort ?? route.defaultEffort);
  if (toolCall) usage.tool_calls = 1;
  return {
    requestId: `mock_${createHash("sha256").update(`${Date.now()}_${counter++}`).digest("hex").slice(0, 16)}`,
    content,
    toolCalls: toolCall ? [toolCall] : undefined,
    finishReason: toolCall ? "tool_calls" : "stop",
    usage,
  };
}

export const mockProvider: Provider = {
  name: "mock",
  async chat(route: RouteDef, req: ChatRequest): Promise<ProviderResult> {
    return respond(route, req, activeScript ? activeScript(req) : null);
  },
  async chatStream(route: RouteDef, req: ChatRequest, meta?: UpstreamMeta): Promise<ProviderStream> {
    const scripted = activeScript ? activeScript(req) : null;
    const delayMs = scripted?.chunkDelayMs ?? 0;
    const result = respond(route, req, scripted);
    const requestId = result.requestId;
    const model = route.providerModel;
    const signal = meta?.signal;
    async function* chunks(): AsyncIterable<string> {
      for await (const c of rawChunks()) {
        // 与真实上游一致：令牌失效即中止在途流（复审 N-01）
        if (signal?.aborted) throw new DomainError("cancelled", "任务令牌已失效：在途模型流已中止", 401);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (signal?.aborted) throw new DomainError("cancelled", "任务令牌已失效：在途模型流已中止", 401);
        yield c;
      }
    }
    async function* rawChunks(): AsyncIterable<string> {
      if (result.toolCalls && result.toolCalls.length > 0) {
        yield JSON.stringify({
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: result.toolCalls.map((tc, i) => ({
                  index: i,
                  id: tc.id,
                  type: "function",
                  function: { name: tc.function.name, arguments: tc.function.arguments },
                })),
              },
              finish_reason: null,
            },
          ],
        });
        yield JSON.stringify({
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: streamUsage(result.usage),
        });
        yield "[DONE]";
        return;
      }
      const pieces = (result.content ?? "").match(/.{1,24}/gs) ?? [];
      for (const p of pieces) {
        yield JSON.stringify({
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: p }, finish_reason: null }],
        });
      }
      yield JSON.stringify({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: streamUsage(result.usage),
      });
      yield "[DONE]";
    }
    return { requestId, chunks: chunks(), finalUsage: Promise.resolve(result.usage) };
  },
};

function streamUsage(u: UsageBuckets) {
  return {
    prompt_tokens: u.uncached_input + u.cached_input,
    completion_tokens: u.output,
    total_tokens: u.uncached_input + u.cached_input + u.output,
  };
}

/** 测试辅助：清空模拟缓存。 */
export function resetMockCache(): void {
  prefixCache.clear();
}
