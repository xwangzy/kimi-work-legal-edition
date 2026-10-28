/**
 * 读回工具结果里由模型写的字段（v9.4 第 30 批，D-157 第二步）：Agent 用 riskcards.list / facts.list / outline.get / table.get
 * 读回自己提交过的卡片、事实、论点与格子——这些字段是模型写的，只替换已知名单（`knownOnly`）；律师写的字段、材料文件名、
 * 列名与内核说明照常识别。内核本机法律工具端点（交回 Agent 前）与出站闸门（tool 消息出站时）用同一张表。
 *
 * 第 30 批真实复测：`riskcards.list` 交回的卡片建议“乙方应开具等额……发票”在内核按材料口径令牌化，学进“应开具”；
 * 只改闸门的 assistant 消息挡不住这条路，闸门对 tool 消息的复扫同样会学。
 */

/** 某个键（及其整个子树）是不是模型写的；`parent` 是这个键所在的对象（按同级的状态字段判断谁写的）。 */
export type ModelFieldRule = (key: string, parent: Readonly<Record<string, unknown>>) => boolean;

/** 风险卡里 Agent 提交的字段；`lawyer_text` 是律师“修改后接受”写的，照常识别。 */
const CARD_FIELDS = new Set(["clause_ref", "anchor_text", "category", "issue", "basis", "suggestion", "fallback", "bottom_line", "rule_ref", "searched_terms", "searched_found", "adopted_text"]);

/** 键为内核法律工具名。 */
export const READBACK_MODEL_FIELDS: Readonly<Record<string, ModelFieldRule>> = Object.freeze({
  "riskcards.list": (k) => CARD_FIELDS.has(k),
  // 律师确认事实时可以改写陈述（只存改后的一份）：确认过的按律师写的处理
  "facts.list": (k, p) => k === "party" || k === "quote" || (k === "statement" && p.lawyer_status !== "confirmed"),
  // 律师改写过的论点（lawyer_edited）与律师备注照常识别
  "outline.get": (k, p) => k === "basis" || k === "facts" || k === "counter" || (k === "claim" && p.lawyer_edited !== true),
  // 律师改过的格子（state=edited）是律师的值
  "table.get": (k, p) => k === "quote" || (k === "value" && p.state !== "edited"),
});

/** 引擎给本机法律工具起的函数名（`mcp__legal__riskcards_list`）→ 有读回规则的内核工具名；其他名字返回 null。 */
export function readbackToolOf(functionName: unknown): string | null {
  if (typeof functionName !== "string") return null;
  const m = /^mcp__legal__([a-z_]+)$/.exec(functionName);
  if (!m) return null;
  return Object.keys(READBACK_MODEL_FIELDS).find((t) => t.replace(".", "_") === m[1]) ?? null;
}

/**
 * 按字段遍历工具结果：每个字符串值交给 `tok(值, 是否模型写的, 所在键)`；模型写的字段整个子树都按模型写的处理。
 * 没有规则（`rule` 为 null）时全部按非模型写的处理。
 */
export function tokenizeByField(
  value: unknown,
  tok: (s: string, modelWritten: boolean, key: string | null) => string,
  rule: ModelFieldRule | null,
  key: string | null = null,
  modelWritten = false,
): unknown {
  if (typeof value === "string") return tok(value, modelWritten, key);
  if (Array.isArray(value)) return value.map((x) => tokenizeByField(x, tok, rule, key, modelWritten));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = tokenizeByField(v, tok, rule, k, modelWritten || (rule?.(k, obj) ?? false));
    return out;
  }
  return value;
}
