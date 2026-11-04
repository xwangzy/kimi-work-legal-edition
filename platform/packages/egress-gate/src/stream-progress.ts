/**
 * 模型响应的“进展”判定（V12；闸门模型看门狗用，server.ts handleModel）。
 *
 * 第 35 批看门狗按“收到响应头”解除首字计时、按“收到任何字节”重置断档计时。上游或其前置代理先回 200 响应头、之后只发
 * SSE 注释保活（`: keep-alive`）、空行或不带任何输出的空增量块时，两个计时器都永远到不了点——请求挂到上游自己放弃为止
 * （V10 第 36 批遗留“闸门看门狗第三次未截断”；V17 真实走查 375 秒、965 秒）。这里只认模型确有输出的数据：
 *
 * - 流式（text/event-stream）：按行拼接（一行可能跨块）；`data:` 行里的 `[DONE]`、非 JSON 内容、带 error / usage 的事件、
 *   任一 choice 有结束原因或非空的正文 / 思考（reasoning_content、reasoning）/ 工具调用 / 旧式 function_call / 拒绝说明 / 完整 message，
 *   都算进展；注释行（`:` 开头）、空行、`event:` / `id:` / `retry:` 行、choices 为空或只有空增量（含只带 role）的块不算；
 * - 非流式：任何非空白字节算进展（只写空白的排队保活不算）。
 *
 * 判定只用于计时，不改写、不缓存响应（响应流仍原样转发）；拿不准的一律算进展（宁可不截断，不误杀正常输出）。
 */

/** 单行拼接上限：超过即视为确有数据（正常的大块工具参数），丢弃缓冲、不再解析这一行。 */
const MAX_LINE = 64 * 1024;

/** 块的元数据字段（不是模型输出）。 */
const META_KEYS = new Set(["id", "object", "created", "model", "system_fingerprint", "service_tier"]);

const nonEmpty = (v: unknown): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
};

/** 一个 SSE data 事件是否带有模型输出。 */
function eventProgress(payload: string): boolean {
  if (payload === "") return false;
  if (payload === "[DONE]") return true;
  let j: unknown;
  try {
    j = JSON.parse(payload);
  } catch {
    return true;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return true;
  const o = j as { choices?: unknown; usage?: unknown; error?: unknown };
  if (nonEmpty(o.error) || nonEmpty(o.usage)) return true;
  // 没有 choices：只带元数据（id、object、model 等）的是心跳；带别的字段的是其他形态的事件，拿不准，算进展
  if (o.choices === undefined) return Object.keys(o).some((k) => !META_KEYS.has(k));
  if (!Array.isArray(o.choices)) return true;
  for (const c of o.choices) {
    if (!c || typeof c !== "object") return true;
    const ch = c as { delta?: unknown; message?: unknown; finish_reason?: unknown; text?: unknown };
    if (nonEmpty(ch.finish_reason) || nonEmpty(ch.message) || nonEmpty(ch.text)) return true;
    const d = ch.delta;
    if (d === undefined || d === null) continue;
    if (typeof d !== "object" || Array.isArray(d)) return true;
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (k === "role") continue;
      if (nonEmpty(v)) return true;
    }
  }
  return false;
}

/**
 * 为一次模型响应建判定器：每收到一块调用一次，返回这一块里是否有进展（完整的行才判定，半行留到下一块）。
 * `contentType` 取上游响应头；不是 event-stream 的按非流式处理。
 */
export function modelStreamProgress(contentType: string | null | undefined): (chunk: Uint8Array) => boolean {
  if (!/text\/event-stream/i.test(contentType ?? "")) {
    return (chunk) => {
      for (const b of chunk) if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return true;
      return false;
    };
  }
  const dec = new TextDecoder();
  let buf = "";
  let overlong = false;
  return (chunk) => {
    buf += dec.decode(chunk, { stream: true });
    let progress = false;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (overlong) {
        // 超长行的尾部：前面已算过进展
        overlong = false;
        continue;
      }
      if (progress) continue;
      if (line.startsWith("data:")) progress = eventProgress(line.slice(5).trim());
    }
    if (buf.length > MAX_LINE) {
      buf = "";
      overlong = true;
      progress = true;
    }
    return progress;
  };
}
