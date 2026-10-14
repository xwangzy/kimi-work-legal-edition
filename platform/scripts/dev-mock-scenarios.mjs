/**
 * 界面联调用的 mock 剧本（只在开发形态、mock 上游时使用：KWL_MOCK_SCRIPT=scripts/dev-mock-scenarios.mjs npm run dev:cloud-v0）。
 * 任务说明含“演示确认卡”时：先发一条含当事人的检索（触发确认卡）→ 再提一个澄清问题（提问卡）→ 最后给出带代号的 Markdown 答复（界面还原）。
 * 其余请求返回 null（网关 mock 的缺省回答）。不访问任何外部地址。
 */
const msgs = (body) => (Array.isArray(body.messages) ? body.messages : []);

/** 工具结果（MCP 文本内容里的 JSON）。 */
function toolResult(body, id) {
  const m = msgs(body).find((x) => x.role === "tool" && x.tool_call_id === id);
  if (!m) return null;
  const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c?.text ?? "").join("") : "";
  const at = text.indexOf("{");
  try {
    return JSON.parse(text.slice(at, text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

/**
 * “演示合同审查”：材料目录 → 读合同全文 → 按关键词挑出违约金、管辖、付款、解除等条款提交风险卡（锚点逐字取自 Agent 看到的令牌化文本）→ 答复。
 * 只用于界面联调（审查工作台与修订稿）；真实审查由模型按 contract-review 方法完成。
 */
function contractReviewDemo(body) {
  const answered = new Set(msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  if (!answered.has("cr_list")) return { toolCalls: [{ id: "cr_list", name: "mcp__legal__materials_list", args: {} }] };
  const list = toolResult(body, "cr_list");
  const mat = list?.materials?.find((x) => x.in_this_task) ?? list?.materials?.[0];
  if (!mat) return { content: "本任务没有可审查的合同材料。" };
  if (!answered.has("cr_read")) return { toolCalls: [{ id: "cr_read", name: "mcp__legal__materials_read_excerpt", args: { parse_version_id: mat.parse_version_id } }] };
  const text = String(toolResult(body, "cr_read")?.text ?? "");
  const sentences = text.split(/(?<=。)|\n/).map((x) => x.trim()).filter((x) => x.length >= 8);
  const rules = [
    { re: /违约金|滞纳金/, severity: "high", category: "both", issue: "违约责任约定不对等或标准明显偏低/偏高，需结合我方立场调整", law: "中华人民共和国民法典", article: 585, fix: (x) => x.replace(/万分之[一二三四五]/, "千分之五") },
    { re: /管辖|诉讼解决|仲裁/, severity: "mid", category: "legal", issue: "争议解决地点对我方不利，建议改为我方所在地或约定仲裁", law: "中华人民共和国民事诉讼法", article: 35, fix: (x) => x.replace(/(转让方|甲方|出卖人|卖方)所在地/, "受让方所在地") },
    { re: /付款|支付.*价款|价款.*支付/, severity: "mid", category: "commercial", issue: "付款节点与交割条件未挂钩，建议以先决条件满足为付款前提", law: "中华人民共和国民法典", article: 525, fix: null },
    { re: /解除/, severity: "low", category: "legal", issue: "解除条件与通知程序约定不清，建议明确解除事由与通知期限", law: "中华人民共和国民法典", article: 565, fix: null },
  ];
  if (!answered.has("cr_cards")) {
    const cards = [];
    for (const r of rules) {
      const sent = sentences.find((x) => r.re.test(x) && !cards.some((c) => c.anchor_text === x));
      if (!sent) continue;
      const suggestion = r.fix ? r.fix(sent) : null;
      cards.push({
        clause_ref: (/^(\d+(?:\.\d+)*)/.exec(sent) ?? [])[1],
        anchor_text: sent,
        severity: r.severity,
        category: r.category,
        issue: r.issue,
        basis: [{ law: r.law, article: r.article }],
        ...(suggestion && suggestion !== sent ? { suggestion } : {}),
        needs_client_decision: r.category !== "legal",
      });
    }
    if (cards.length === 0) return { content: "未在合同中发现需要提示的条款（演示脚本只识别违约金、管辖、付款与解除条款）。" };
    for (const c of cards) if (!c.clause_ref) delete c.clause_ref;
    return { toolCalls: [{ id: "cr_cards", name: "mcp__legal__riskcards_submit", args: { document_version_id: mat.document_version_id, cards } }] };
  }
  const sub = toolResult(body, "cr_cards");
  return {
    content: [
      "## 合同审查（演示）",
      "",
      `已在审查工作台提交 ${sub?.submitted ?? 0} 项意见，请逐项接受、修改或不采纳；处理后可一键生成带修订痕迹的 Word 修订稿。`,
      "",
      "- 本答复由演示脚本生成，仅用于界面联调。",
    ].join("\n"),
  };
}

export default function script(body) {
  const all = JSON.stringify(msgs(body));
  if (all.includes("演示合同审查")) return contractReviewDemo(body);
  if (!all.includes("演示确认卡")) return null;
  const answered = new Set(msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  // 从用户消息里取一个机构名称（相对方）作检索式，演示“含当事人须确认”
  const user = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
  const org = /([一-龥A-Za-z]{2,20}有限公司)/.exec(user)?.[1] ?? "某有限公司";
  const steps = [
    { id: "demo_ws", name: "WebSearch", args: { query: `${org} 股东未实缴出资 补足责任` } },
    { id: "demo_q", name: "AskUserQuestion", args: { questions: [{ question: "检索范围限于近三年的裁判吗？", header: "范围", options: [{ label: "近三年", description: "只看 2023 年以来" }, { label: "不限年份", description: "全部年份" }], multi_select: false }] } },
  ];
  const next = steps.find((s) => !answered.has(s.id));
  if (next) return { toolCalls: [next] };
  const tokens = [...new Set(all.match(/〔(?:自然人|机构)·[0-9A-Z]{6,10}〕/g) ?? [])].slice(0, 2);
  return {
    content: [
      "## 研究备忘（草稿）",
      "",
      `- 本事项当事人：${tokens.join("、") || "（材料中未出现代号）"}`,
      "- 结论：股东未按期足额缴纳出资的，应在未出资本息范围内对公司债务不能清偿的部分承担补充赔偿责任（《公司法》第 49 条、第 50 条，**须核验现行有效**）。",
      "",
      "| 要点 | 依据 |",
      "| --- | --- |",
      "| 补足责任 | 《公司法》第 50 条 |",
      "| 加速到期 | 《公司法》第 54 条 |",
    ].join("\n"),
  };
}
