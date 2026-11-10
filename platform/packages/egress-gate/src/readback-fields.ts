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

/** docx.revise 结果里按模型写的处理的字段（V16 第 41 批）。 */
const REVISE_MODEL_FIELDS = new Set(["changes", "conflicts", "numbering_changes", "numbering_note", "label_notes", "note"]);

/** 键为内核法律工具名。 */
export const READBACK_MODEL_FIELDS: Readonly<Record<string, ModelFieldRule>> = Object.freeze({
  "riskcards.list": (k) => CARD_FIELDS.has(k),
  // 律师确认事实时可以改写陈述（只存改后的一份）：确认过的按律师写的处理
  "facts.list": (k, p) => k === "party" || k === "quote" || (k === "statement" && p.lawyer_status !== "confirmed"),
  // 律师改写过的论点（lawyer_edited）与律师备注照常识别
  "outline.get": (k, p) => k === "basis" || k === "facts" || k === "counter" || (k === "claim" && p.lawyer_edited !== true),
  // 律师改过的格子（state=edited）是律师的值
  "table.get": (k, p) => k === "quote" || (k === "value" && p.state !== "edited"),
  // 法规库的条文原文与模型自己的检索词（V14 第 39 批）：法条里没有自然人，规则识别却会把“当事人一方明确表示”“被监护人利益”
  // “利害关系人”里的字认成姓名；学进事项令牌表后，本事项材料与草稿里的同一串字都被换成代号（真实走查 A：“方明”）。
  // 法规库 3,513 条全文扫描，V13 规则误认 47 个值、78 条。只替换已知名单，不从条文里学新名字
  "law.search": () => true,
  "law.get_version": () => true,
  "law.get_article": () => true,
  "citations.verify": () => true,
  // 出文书、出表、改文书、改表、在原件上修订这几个工具的结果，回给助手的是它自己刚交上来的文字（交付前检查摘出的原句、改前改后的整段、被退回的定位文字）
  // 和原件里它已经读过的文字（V16 第 41 批两轮真实回归：文书里的“被告应予返还”“应休”“应发工资”“曾根据”“公式成立”经这些结果被认成新姓名，学进事项代号表后，
  // 独立复核看到的文书里这些词都成了代号，报“无出处的自然人代号，必须改”，修改轮照改）。只替换已知名单，不从中学新名字；
  // 出文书、出表、改文书、改表只能作用于本任务里助手自己生成的文书与表格（edit-draft.ts、review.ts 按任务与成果类别核对），结果整体按模型写的处理
  "docx.render_report": () => true,
  "docx.edit_draft": () => true,
  "xlsx.render_table": () => true,
  "xlsx.edit_cells": () => true,
  // 在原件上修订：只有改前改后的整段（changes）、被退回的原因（conflicts）、编号顺延与互引（numbering_changes）、条款标签提示与说明按模型写的处理——
  // 这些是助手交的修改加上它读过的正文段落；页眉页脚（header_footer、header_footer_text、header_footer_changes）不在材料文字里、助手未必读过，照常识别
  "docx.revise": (k) => REVISE_MODEL_FIELDS.has(k),
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
