/**
 * 模型请求体的出站处理（第 02 篇 §8.3–§8.4；第 04 篇 §5.1 `/v1` 行）：
 *
 * - **按协议位置**区分结构值与内容（复核 S4-19：结构键只在协议层位置生效，不在任意深度生效）：
 *   请求顶层的模型与采样参数、消息的角色与调用 ID、工具调用的 ID/类型/函数名、内容块的类型/ID/缓存控制/签名、工具定义的类型与名称原样；
 *   **其余一切字符串值**（消息内容、system、`messages[].name`、思考内容、工具描述、参数 schema、工具调用参数的每一个值、
 *   `stop`、`user`、元数据、未知字段）都经同一令牌化器——工具参数与 schema 内部不再有任何“结构键”豁免；
 * - **模型自己写的内容只替换已知名单**（v9.4 第 30 批，D-157）：assistant 消息（正文、思考、工具调用参数、引用）的标识符照常替换，
 *   当事人词典与令牌表里的姓名照常替换，但不做姓名识别、不学新姓名——模型只见过令牌化后的输入，它写的“应全额、任何、向乙”
 *   不应被学成姓名、再回过头把合同原文换成代号。本机写入的 assistant 预填（`partial` / `prefix`、或位于末尾的 assistant 消息）
 *   不是模型写的，照常识别；system、user、tool 消息与工具定义照常识别；
 * - 工作区本已是令牌形态，确定性令牌化幂等：同一值得到同一代号，跨轮稳定、前缀缓存不破；
 * - 工具调用参数（JSON 字符串）先解析再逐值令牌化（`\uXXXX` 转义写法同样识别），只在确有替换时重新序列化；
 * - **响应流不还原**（不在本模块）：引擎收到的永远是令牌形态；
 * - 内容块类型白名单：文本类令牌化；图像、视频、音频、文件、文档类列为非文本载荷（默认改走本机 OCR；直送须批准、L3 禁止）；
 *   **未知类型**同样列为非文本载荷（`unknown:<类型>`）——失败关闭，由闸门拒绝。
 */
import { createHash } from "node:crypto";
import { suspectedNames, TOKEN_RE, tokenCategory, type MatterTokenizer, type TokenCategory } from "@zr-legal/tokenizer";

export interface ChatPayloadReport {
  /** 处理后的请求体（只改文本值）。 */
  body: Record<string, unknown>;
  textChars: number;
  segments: number;
  replaced: number;
  /** 闸门本次补替换的次数（按类别；工作区已是令牌形态时通常为 0）。 */
  counts: Partial<Record<TokenCategory, number>>;
  /** 处理后出站载荷中的代号出现次数（按类别；含工作区已有的与闸门补替换的）——数据去向卡的“遮蔽与化名计数”。 */
  present: Partial<Record<TokenCategory, number>>;
  /** 非文本载荷（类别、所在消息序号、内联数据的摘要；未知内容块类型为 `unknown:<类型>`）。不含载荷本身。 */
  media: { kind: string; message: number; digest?: string }[];
  /**
   * 发送前二次检测（v9.2 R7；Y5 §4.3）：令牌化之后仍像自然人姓名的原文，按不同的值计数（高、中两档）。
   * 只有计数进去向记录；具体的值只在 `suspectValues`（闸门内存，用于回给本机界面核对），不写入任何记录。
   */
  suspects: { high: number; medium: number };
  suspectValues: { value: string; confidence: "high" | "medium" }[];
}

const MEDIA_TYPES = new Set(["image_url", "input_image", "image", "video_url", "input_video", "video", "file", "input_file", "input_audio", "audio", "document"]);
const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text", "tool_use", "tool_result", "thinking", "redacted_thinking", "refusal"]);

/** 请求顶层的结构参数（值原样）。`stop`、`user` 不在此列（复核 S4-19）。 */
const TOP_STRUCTURAL = new Set([
  "model", "stream", "stream_options", "temperature", "top_p", "top_k", "n", "seed", "max_tokens", "max_completion_tokens", "parallel_tool_calls",
  "service_tier", "logprobs", "top_logprobs", "presence_penalty", "frequency_penalty", "prompt_cache_key", "reasoning_effort", "tool_choice", "function_call", "thinking",
]);
/** 消息对象的结构字段。 */
const MESSAGE_STRUCTURAL = new Set(["role", "tool_call_id", "partial", "prefix"]);
/** 内容块对象的结构字段（`redacted_thinking` 的 data 为上游加密数据，原样）。`citations` 含原文片段，照常令牌化（终核 S4-24）。 */
const BLOCK_STRUCTURAL = new Set(["type", "id", "tool_use_id", "cache_control", "signature", "is_error"]);

export function processChatPayload(input: unknown, tokenizer: MatterTokenizer): ChatPayloadReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求体不是对象");
  const report: ChatPayloadReport = { body: {}, textChars: 0, segments: 0, replaced: 0, counts: {}, present: {}, media: [], suspects: { high: 0, medium: 0 }, suspectValues: [] };
  const seen = new Map<string, "high" | "medium">();
  /** 正在处理模型写的 assistant 消息（D-157）：其中的字符串只替换已知名单。 */
  let modelAuthored = false;
  const tok = (s: string): string => {
    if (s.length === 0) return s;
    report.textChars += s.length;
    report.segments += 1;
    const r = tokenizer.tokenize(s, modelAuthored ? { knownOnly: true } : {});
    report.replaced += r.replaced;
    for (const [k, v] of Object.entries(r.counts)) report.counts[k as TokenCategory] = (report.counts[k as TokenCategory] ?? 0) + (v ?? 0);
    TOKEN_RE.lastIndex = 0;
    for (const m of r.text.matchAll(TOKEN_RE)) {
      const c = tokenCategory(m[0]);
      if (c) report.present[c] = (report.present[c] ?? 0) + 1;
    }
    for (const x of suspectedNames(r.text)) {
      const had = seen.get(x.value);
      if (had === "high" || had === x.confidence) continue;
      if (had === "medium") report.suspects.medium -= 1;
      seen.set(x.value, x.confidence);
      report.suspects[x.confidence] += 1;
    }
    return r.text;
  };

  /** 内容子树：每一个字符串值都令牌化（键名不论）。 */
  const deep = (v: unknown): unknown => {
    if (typeof v === "string") return tok(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deep(x);
      return out;
    }
    return v;
  };

  /** JSON 字符串形态的参数：解析后逐值令牌化（转义写法同样识别）；有替换才重新序列化（格式确定，跨轮稳定）。 */
  const tokArgs = (raw: unknown): unknown => {
    if (typeof raw !== "string") return deep(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return tok(raw);
    }
    const before = JSON.stringify(parsed);
    const out = deep(parsed);
    return JSON.stringify(out) === before ? raw : JSON.stringify(out);
  };

  /** 工具调用（OpenAI `tool_calls[]` 元素与旧式 `function_call`）：ID、类型与函数名原样，参数全部令牌化。 */
  const toolCall = (c: unknown): unknown => {
    if (!c || typeof c !== "object" || Array.isArray(c)) return deep(c);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(c as Record<string, unknown>)) {
      if (k === "id" || k === "type" || k === "index") out[k] = x;
      else if (k === "function" && x && typeof x === "object" && !Array.isArray(x)) out[k] = functionRef(x as Record<string, unknown>);
      else if (k === "name" && typeof x === "string") out[k] = x;
      else if (k === "arguments") out[k] = tokArgs(x);
      else out[k] = deep(x);
    }
    return out;
  };
  const functionRef = (f: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(f)) out[k] = k === "name" && typeof x === "string" ? x : k === "arguments" ? tokArgs(x) : deep(x);
    return out;
  };

  /** 内容块（消息 content 数组、tool_result 的 content、顶层 system 数组）。 */
  const block = (b: unknown, message: number): unknown => {
    if (typeof b === "string") return tok(b);
    if (!b || typeof b !== "object" || Array.isArray(b)) return deep(b);
    const o = b as Record<string, unknown>;
    if (typeof o.type !== "string") return deep(o);
    if (MEDIA_TYPES.has(o.type)) {
      report.media.push({ kind: o.type, message, ...mediaData(o) });
      return o;
    }
    if (!TEXT_BLOCK_TYPES.has(o.type)) {
      report.media.push({ kind: `unknown:${o.type}`.slice(0, 64), message });
      return o;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      if (BLOCK_STRUCTURAL.has(k)) out[k] = x;
      else if (k === "name" && o.type === "tool_use" && typeof x === "string") out[k] = x;
      else if (k === "data" && o.type === "redacted_thinking") out[k] = x;
      else if (k === "content") out[k] = Array.isArray(x) ? x.map((y) => block(y, message)) : block(x, message);
      else out[k] = deep(x);
    }
    return out;
  };

  const message = (m: unknown, index: number, count: number): unknown => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return deep(m);
    const mo = m as Record<string, unknown>;
    // 模型写的：assistant 角色，且不是本机写入的预填（partial / prefix 标记，或位于末尾——Anthropic 形态的预填）
    modelAuthored = mo.role === "assistant" && mo.partial !== true && mo.prefix !== true && index < count - 1;
    try {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(mo)) {
        if (MESSAGE_STRUCTURAL.has(k)) out[k] = x;
        else if (k === "content") out[k] = x === null ? null : Array.isArray(x) ? x.map((y) => block(y, index)) : block(x, index);
        else if (k === "tool_calls" && Array.isArray(x)) out[k] = x.map(toolCall);
        else if (k === "function_call") out[k] = toolCall(x);
        else out[k] = deep(x);
      }
      return out;
    } finally {
      modelAuthored = false;
    }
  };

  /** 工具定义：类型与名称原样；描述与参数 schema 全部令牌化。 */
  const toolDef = (t: unknown): unknown => {
    if (!t || typeof t !== "object" || Array.isArray(t)) return deep(t);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(t as Record<string, unknown>)) {
      if (k === "type" || k === "cache_control" || k === "strict") out[k] = x;
      else if (k === "name" && typeof x === "string") out[k] = x;
      else if (k === "function" && x && typeof x === "object" && !Array.isArray(x)) out[k] = toolDef(x);
      else out[k] = deep(x);
    }
    return out;
  };

  const src = input as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(src)) {
    if (TOP_STRUCTURAL.has(k)) body[k] = x;
    else if (k === "messages" && Array.isArray(x)) body[k] = x.map((m, i) => message(m, i, x.length));
    else if (k === "system") body[k] = Array.isArray(x) ? x.map((b) => block(b, -1)) : block(x, -1);
    else if ((k === "tools" || k === "functions") && Array.isArray(x)) body[k] = x.map(toolDef);
    else if (k === "response_format" && x && typeof x === "object" && !Array.isArray(x)) {
      const rf = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [rk, rx] of Object.entries(rf)) {
        if (rk === "type") out[rk] = rx;
        else if (rk === "json_schema" && rx && typeof rx === "object" && !Array.isArray(rx)) {
          const js: Record<string, unknown> = {};
          for (const [jk, jx] of Object.entries(rx as Record<string, unknown>)) js[jk] = jk === "name" || jk === "strict" ? jx : deep(jx);
          out[rk] = js;
        } else out[rk] = deep(rx);
      }
      body[k] = out;
    } else if (k === "metadata" && x && typeof x === "object" && !Array.isArray(x)) {
      // 会话键（metadata.user_id）是结构标识；其余元数据字符串照常令牌化
      const md: Record<string, unknown> = {};
      for (const [mk, mx] of Object.entries(x as Record<string, unknown>)) md[mk] = mk === "user_id" ? mx : deep(mx);
      body[k] = md;
    } else body[k] = deep(x);
  }
  report.body = body;
  report.suspectValues = [...seen].map(([value, confidence]) => ({ value, confidence }));
  return report;
}

/** 图像等非文本载荷的内联数据摘要（解码后字节的 SHA-256；供闸门按摘要核对批准）；外部 URL 无摘要。载荷本身不进任何记录。 */
function mediaData(o: Record<string, unknown>): { digest?: string } {
  const iu = o.image_url;
  const url = typeof iu === "string" ? iu : iu && typeof iu === "object" ? (iu as { url?: unknown }).url : undefined;
  let b64: string | null = null;
  if (typeof url === "string" && url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma > 0 && /;base64$/i.test(url.slice(0, comma))) b64 = url.slice(comma + 1);
  }
  const source = o.source as { type?: unknown; data?: unknown } | undefined;
  if (!b64 && source && source.type === "base64" && typeof source.data === "string") b64 = source.data;
  return b64 ? { digest: createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex") } : {};
}
