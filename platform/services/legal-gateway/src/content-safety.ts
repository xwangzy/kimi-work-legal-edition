/**
 * 网关内容安全（v9.2 R11；生成式人工智能服务登记前须可演示的“内容审核能力”，调研 Y2-U7）：
 *
 * - 机制：按类别的词库（由内容安全团队或供应商维护、签名下发；本模块只负责装载与匹配），Aho-Corasick 多模式匹配，
 *   文字先做 NFKC 折叠、去零宽字符、大小写折叠；
 * - 动作按类别：record（只计数）或 block（拒绝请求 / 截断输出）。法律工作的材料本来就大量讨论违法犯罪事实，
 *   缺省策略对一切类别只计数——是否拦截由内容安全策略逐类决定，不在代码里写死；
 * - 留存：**只记类别编号与命中次数**，不记命中的词、不记上下文（计量日志的 `safety` 字段）；匹配在内存里完成；
 * - 不在本模块：模型厂商侧的内容安全（月之暗面照常执行）、人工复核流程、词库本身。
 */

export type SafetyAction = "record" | "block";

export interface SafetyCategory {
  /** 类别编号：字母数字与连字符（进计量日志）。 */
  id: string;
  action: SafetyAction;
  terms: string[];
}

export interface SafetyPolicy {
  version: string;
  categories: SafetyCategory[];
}

export interface SafetyVerdict {
  /** 类别编号 → 命中次数（只含命中的类别）。 */
  hits: Record<string, number>;
  /** 命中且动作为 block 的第一个类别；null = 放行。 */
  blocked: string | null;
}

const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
/**
 * 匹配前删除的不可见字符（复核 B4-R13）：全部格式字符 \p{Cf}（零宽、方向控制、标签字符、软连字符、U+180E 等）、
 * 组合用字形连接符 U+034F、变体选择符、韩文填充字符——插在词中间能让肉眼看到的同一个词躲过匹配。
 */
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

/** 匹配前的统一折叠（词库与待测文字用同一函数）。 */
export function foldForSafety(s: string): string {
  return s.normalize("NFKC").replace(INVISIBLE, "").toLowerCase();
}

interface AcNode {
  next: Map<string, number>;
  fail: number;
  /** 以此结点结尾的类别下标。 */
  out: number[];
}

export class ContentSafety {
  readonly version: string;
  private readonly cats: SafetyCategory[];
  private readonly nodes: AcNode[] = [{ next: new Map(), fail: 0, out: [] }];

  constructor(policy: SafetyPolicy) {
    if (!policy || typeof policy.version !== "string" || !Array.isArray(policy.categories)) throw new Error("内容安全策略格式不合法");
    this.version = policy.version;
    this.cats = policy.categories.map((c) => {
      if (!CATEGORY_ID.test(c.id)) throw new Error(`内容安全类别编号不合法：${String(c.id).slice(0, 60)}`);
      if (c.action !== "record" && c.action !== "block") throw new Error(`内容安全类别 ${c.id} 的动作须为 record / block`);
      return { id: c.id, action: c.action, terms: (c.terms ?? []).map(String) };
    });
    this.cats.forEach((c, ci) => {
      for (const raw of c.terms) {
        const t = foldForSafety(raw);
        if (!t) continue;
        let n = 0;
        for (const ch of t) {
          let nx = this.nodes[n]!.next.get(ch);
          if (nx === undefined) {
            nx = this.nodes.length;
            this.nodes.push({ next: new Map(), fail: 0, out: [] });
            this.nodes[n]!.next.set(ch, nx);
          }
          n = nx;
        }
        if (!this.nodes[n]!.out.includes(ci)) this.nodes[n]!.out.push(ci);
      }
    });
    // 失败指针（广度优先）
    const queue: number[] = [];
    for (const nx of this.nodes[0]!.next.values()) queue.push(nx);
    while (queue.length) {
      const r = queue.shift()!;
      for (const [ch, u] of this.nodes[r]!.next) {
        queue.push(u);
        let f = this.nodes[r]!.fail;
        while (f !== 0 && !this.nodes[f]!.next.has(ch)) f = this.nodes[f]!.fail;
        const cand = this.nodes[f]!.next.get(ch);
        this.nodes[u]!.fail = cand !== undefined && cand !== u ? cand : 0;
        for (const o of this.nodes[this.nodes[u]!.fail]!.out) if (!this.nodes[u]!.out.includes(o)) this.nodes[u]!.out.push(o);
      }
    }
  }

  /** 词库里有没有任何条目（没有就不必扫描）。 */
  get empty(): boolean {
    return this.nodes.length === 1;
  }

  check(texts: Iterable<string>): SafetyVerdict {
    const counts = new Map<number, number>();
    if (!this.empty) {
      for (const text of texts) {
        let n = 0;
        for (const ch of foldForSafety(text)) {
          while (n !== 0 && !this.nodes[n]!.next.has(ch)) n = this.nodes[n]!.fail;
          n = this.nodes[n]!.next.get(ch) ?? 0;
          for (const ci of this.nodes[n]!.out) counts.set(ci, (counts.get(ci) ?? 0) + 1);
        }
      }
    }
    const hits: Record<string, number> = {};
    let blocked: string | null = null;
    for (const [ci, k] of [...counts].sort((a, b) => a[0] - b[0])) {
      const c = this.cats[ci]!;
      hits[c.id] = (hits[c.id] ?? 0) + k;
      if (c.action === "block" && blocked === null) blocked = c.id;
    }
    return { hits, blocked };
  }
}

/** 计量日志里的安全字段：`类别:次数` 按类别排序、逗号分隔（只有编号与次数）。 */
export function safetySummary(v: SafetyVerdict): string | null {
  const parts = Object.entries(v.hits)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}:${n}`);
  return parts.length ? parts.join(",") : null;
}

/** 请求体里需要检查的文字：消息的字符串内容与 text 类内容块（工具参数与图像不在此列）。 */
export function requestTexts(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const msgs = Array.isArray(body.messages) ? (body.messages as { content?: unknown }[]) : [];
  for (const m of msgs) {
    if (typeof m?.content === "string") out.push(m.content);
    else if (Array.isArray(m?.content)) for (const p of m.content as { type?: unknown; text?: unknown }[]) if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
  }
  return out;
}

/** 模型输出的一段文字及其通道：正文、推理文字、第 N 个工具调用的参数（各通道分开检查，跨块窗口也分开）。 */
export interface OutputPiece {
  channel: string;
  text: string;
}

const MAX_PENDING = 1_000_000;

/**
 * 从 OpenAI 兼容的流式 SSE 片段里取出模型输出文字（复核 B4-R05）：
 * - 通道：`delta.content`、`delta.reasoning_content`、`delta.tool_calls[].function.arguments`（按调用序号分通道）——
 *   开放任务的主要产出走工具参数（成果渲染、风险卡提交），只看正文等于对它们不检查；
 * - 行尾按 SSE 规范认 CR、LF、CRLF；不完整的行留给下一块；
 * - 一行超过 100 万字符（异常上游或攻击）即置 `overflow`，调用方须失败关闭（中止并以错误事件结束），不跳过检查。
 */
export class OutputTextTap {
  private pending = "";
  overflow = false;

  /** 喂入一块原始字节解码后的文字，按通道返回其中新出现的输出文字。 */
  feedChannels(chunk: string): OutputPiece[] {
    if (this.overflow) return [];
    this.pending += chunk;
    const out: OutputPiece[] = [];
    let m: RegExpExecArray | null;
    const LINE = /\r\n|\r|\n/g;
    let consumed = 0;
    while ((m = LINE.exec(this.pending)) !== null) {
      // 块末尾的单个 \r 可能是 \r\n 的前一半：留到下一块再判
      if (m[0] === "\r" && m.index === this.pending.length - 1) break;
      const line = this.pending.slice(consumed, m.index).trim();
      consumed = m.index + m[0].length;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: { index?: unknown; function?: { arguments?: unknown } }[] } }[] };
        for (const c of j.choices ?? []) {
          const d = c.delta;
          if (typeof d?.content === "string" && d.content) out.push({ channel: "content", text: d.content });
          if (typeof d?.reasoning_content === "string" && d.reasoning_content) out.push({ channel: "reasoning", text: d.reasoning_content });
          for (const [k, tc] of (Array.isArray(d?.tool_calls) ? d!.tool_calls! : []).entries()) {
            const args = tc?.function?.arguments;
            if (typeof args === "string" && args) out.push({ channel: `tool:${typeof tc.index === "number" ? tc.index : k}`, text: args });
          }
        }
      } catch {
        // 非 JSON 行忽略
      }
    }
    this.pending = this.pending.slice(consumed);
    if (this.pending.length > MAX_PENDING) {
      this.overflow = true;
      this.pending = "";
    }
    return out;
  }

  /** 兼容：各通道新文字按顺序拼接（通道之间以换行隔开，不会拼出跨通道的词）。 */
  feed(chunk: string): string {
    return this.feedChannels(chunk)
      .map((p) => p.text)
      .join("\n");
  }
}

/** 非流式响应里的模型输出：正文、推理文字与工具调用参数，逐项分开（复核 B4-R05）。 */
export function completionTexts(json: string): string[] {
  try {
    const j = JSON.parse(json) as { choices?: { message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: { function?: { arguments?: unknown } }[] } }[] };
    const out: string[] = [];
    for (const c of j.choices ?? []) {
      const msg = c.message;
      if (typeof msg?.content === "string") out.push(msg.content);
      if (typeof msg?.reasoning_content === "string") out.push(msg.reasoning_content);
      for (const tc of Array.isArray(msg?.tool_calls) ? msg!.tool_calls! : []) if (typeof tc?.function?.arguments === "string") out.push(tc.function.arguments);
    }
    return out;
  } catch {
    return [];
  }
}

export function completionText(json: string): string {
  return completionTexts(json).join("\n");
}
