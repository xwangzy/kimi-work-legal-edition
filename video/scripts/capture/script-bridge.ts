// 第 26 批走查：云端 v0（网关 + 脚本化模型）+ 内核开发桥。Agent 任务经 kap-host → 出站闸门 → 网关 v0 → 下面的脚本模型，
// 让“须真实或脚本模型跑完任务”的页面能在浏览器里走查。只在会话暂存区，不进仓库。
const ROOT = "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/platform";
const { startCloudV0 } = await import(`${ROOT}/packages/kernel/test/cloud-v0.ts`);
const cloud = await startCloudV0({ tenant: "ten_dev-firm" });
Object.assign(process.env, cloud.env);

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));
const mcp = (n: string) => `mcp__legal__${n.replace(/\./g, "_")}`;
const seen = new Set<string>();

cloud.model.script = (body: Record<string, unknown>) => {
  const msgs = (Array.isArray(body.messages) ? body.messages : []) as Msg[];
  const U = text(msgs.find((m) => m.role === "user")?.content);
  const sys = text(msgs.find((m) => m.role === "system")?.content);
  const all = `${sys}\n${U}`;
  const method = /方法模板“([a-z-]+)”/.exec(U)?.[1] ?? "";
  const res = new Map<string, string>();
  for (const m of msgs) if (m.role === "tool" && typeof m.tool_call_id === "string") res.set(m.tool_call_id, text(m.content));
  const key = U.slice(0, 80);
  if (!seen.has(key)) {
    seen.add(key);
    console.log(`[script] new task; user head: ${U.slice(0, 600).replace(/\n/g, " ⏎ ")}`);
  }
  // 走查：模型收到的全部文字里的代号（看方法正文、工具结果有没有被误换）
  const toks = [...new Set([...JSON.stringify(msgs).matchAll(/.{0,14}〔自然人·[0-9A-Z]{6,10}〕.{0,14}/g)].map((m) => m[0]))];
  if (toks.length) console.log(`[script] person tokens seen (${toks.length}): ${toks.slice(0, 25).join(" | ")}`);
  if (res.has("w_skill") && !seen.has(`skill:${key}`)) {
    seen.add(`skill:${key}`);
    console.log(`[script] skill body head: ${(res.get("w_skill") ?? "").slice(0, 300)}`);
  }
  const step = (id: string, name: string, args: Record<string, unknown>) => (res.has(id) ? null : { toolCalls: [{ id, name, args }] });
  // materials.list 的结果里挑一份：want 命中文件名的那份（其后到下一个编号之间出现）
  const docId = (want = /\.docx/) => {
    const r = (res.get("w_mat") ?? "").replace(/\\"/g, '"');
    const ids = [...r.matchAll(/docv_[0-9a-f-]{36}/g)];
    for (let i = 0; i < ids.length; i++) if (want.test(r.slice(ids[i]!.index!, ids[i + 1]?.index ?? r.length))) return ids[i]![0];
    return ids[0]?.[0] ?? "";
  };
  const flow = (calls: [string, string, () => Record<string, unknown>][], final: string) => {
    for (const [id, name, args] of calls) {
      const s = step(id, name, args());
      if (s) return s;
    }
    return { content: final };
  };

  if (/WALK-NOOUTLINE/.test(U)) {
    return { content: "民事起诉状（草稿）\n\n原告：【当事人】\n被告：丁贸易有限公司\n\n诉讼请求：\n一、判令被告支付货款 300,000 元及逾期付款违约金；\n二、本案诉讼费用由被告承担。\n\n事实与理由：原告于 2026 年 3 月 1 日交付全部货物，被告签收后至今未付款。依据《中华人民共和国民法典》第五百零九条、第五百七十七条，被告应当承担继续履行与赔偿损失的违约责任。" };
  }
  if (method === "review-rules-draft") {
    return flow(
      [
        ["w_skill", "Skill", () => ({ skill: "review-rules-draft" })],
        ["w_mat", mcp("materials.list"), () => ({})],
        ["w_rules", mcp("rules.propose"), () => ({
          title: "采购合同审查要点（买方，草稿）",
          rules: [
            { topic: "付款", standard: "验收合格后三十日内付款；预付不超过 30%（范本《本所采购合同（买方版）》第五条）", fallback: "不超过六十日", red_line: "不接受货到前付全款" },
            { topic: "质量异议期", standard: "验收后九十日内可提出质量异议（范本《本所采购合同（买方版）》第六条）", fallback: "不少于 30 日", red_line: "不接受“签收即视为验收合格”" },
            { topic: "违约金", standard: "逾期付款违约金不高于日万分之三（范本《本所采购合同（买方版）》第七条）", fallback: "日万分之五", red_line: "不接受按日千分之一" },
          ],
        })],
      ],
      "已按本所范本整理三条审查要点草稿，请在事项概览审定后启用。",
    );
  }
  if (method === "contract-review" && /股权转让协议/.test(res.get("w_mat") ?? "")) {
    return flow(
      [
        ["w_skill", "Skill", () => ({ skill: "contract-review" })],
        ["w_mat", mcp("materials.list"), () => ({})],
        ["w_cards", mcp("riskcards.submit"), () => ({
          document_version_id: docId(/股权转让协议/),
          cards: [
            { kind: "risk", rule_source: "general", anchor_text: "受让方应于本协议签署后五个工作日内一次性支付全部转让价款。", severity: "high", category: "commercial", nature: "must", issue: "价款在股权变更登记之前一次付清：若之后无法完成变更登记，受让方承担全部交割风险", suggestion: "受让方应于目标股权变更登记完成后五个工作日内支付全部转让价款。", fallback: "受让方应于本协议签署后五个工作日内支付 30% 价款，其余价款于变更登记完成后五个工作日内付清。" },
            { kind: "risk", rule_source: "general", anchor_text: "受让方逾期付款的，每日按应付未付金额的千分之五支付违约金。", severity: "mid", category: "legal", nature: "should", issue: "逾期付款违约金按日千分之五，折合年化逾 180%，明显偏高且对我方不利", suggestion: "受让方逾期付款的，每日按应付未付金额的万分之三支付违约金，累计不超过转让价款的百分之五。" },
            { kind: "risk", rule_source: "general", anchor_text: "因本协议引起的任何争议，提交转让方所在地人民法院诉讼解决。", severity: "low", category: "legal", issue: "管辖法院约定在转让方所在地，受让方诉讼成本较高", suggestion: "因本协议引起的任何争议，提交原告所在地人民法院诉讼解决。" },
            { kind: "missing", rule_source: "general", insert_after: "转让方保证目标公司不存在未向受让方披露的债务或担保。", searched_terms: ["或有负债", "赔偿", "补偿"], anchor_text: "", severity: "mid", category: "legal", issue: "缺少或有负债的赔偿条款", suggestion: "5.2　如目标公司存在交割日前未披露的债务或担保，转让方应全额赔偿受让方因此遭受的损失。" },
          ],
        })],
        ["w_rep", mcp("docx.render_report"), () => ({
          title: "关于《股权转让协议》的审查意见（内部稿）",
          sections: [
            { heading: "一、总体评价", paragraphs: ["协议结构完整，但付款安排与违约责任对受让方明显不利，建议在签署前重点调整第 2.2 条与第 7.1 条。"] },
            { heading: "二、主要风险与修改建议", paragraphs: [
              "1. 第 2.2 条：价款在股权变更登记前一次付清，受让方承担全部交割风险。依据《中华人民共和国民法典》第五百二十六条，建议改为变更登记完成后五个工作日内支付。",
              "2. 第 7.1 条：逾期付款违约金按日千分之五，明显过高。依据《中华人民共和国民法典》第五百八十五条第二款，约定的违约金过分高于造成的损失的，可以请求予以适当减少；建议调整为日万分之三。",
              "3. 第 5.1 条：缺少或有负债的赔偿安排，参考（2023）沪01民终12345号判决的裁判思路，建议增设第 5.2 条。",
            ] },
          ],
        })],
      ],
      "已提交四张审查意见卡，并生成审查意见书（内部稿）。请在审查工作台逐条处理。",
    );
  }
  if (method === "contract-review") {
    const byRules = /本事项审查要点 第/.test(all);
    return flow(
      [
        ["w_skill", "Skill", () => ({ skill: "contract-review" })],
        ["w_mat", mcp("materials.list"), () => ({})],
        ["w_cards", mcp("riskcards.submit"), () => ({
          document_version_id: docId(),
          cards: [
            byRules
              ? { kind: "deviation", rule_source: "firm_rule", rule_ref: "要点 1：验收合格后三十日内付款", anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "high", category: "commercial", nature: "should", issue: "付款期限九十日，长于本事项审查要点（三十日）", suggestion: "买方应于验收合格后三十日内支付货款。", fallback: "买方应于验收合格后六十日内支付货款。" }
              : { kind: "risk", rule_source: "general", anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "mid", category: "commercial", issue: "付款期限较长", suggestion: "买方应于验收合格后六十日内支付货款。" },
            { kind: "risk", rule_source: "general", anchor_text: "逾期付款的，按日千分之一支付违约金。", severity: "high", category: "legal", nature: "must", issue: "违约金按日千分之一，折合年化 36.5%，可能被认定过高", suggestion: "逾期付款的，按日万分之三支付违约金。" },
            { kind: "missing", rule_source: "general", insert_after: "逾期付款的，按日千分之一支付违约金。", searched_terms: ["保密", "商业秘密", "保密义务"], anchor_text: "", severity: "mid", category: "legal", issue: "缺少保密条款", suggestion: "第九条 保密 双方对因本合同知悉的对方商业秘密负保密义务，期限至本合同终止后三年。" },
          ],
        })],
      ],
      "已提交三张审查意见卡，请在审查工作台逐条处理。",
    );
  }
  if (/WALK-FACTS/.test(U)) {
    return flow(
      [
        ["w_mat", mcp("materials.list"), () => ({})],
        ["w_facts", mcp("facts.submit"), () => ({
          facts: [
            { statement: "买方于 2026 年 3 月 1 日签收全部货物", kind: "claimed", occurred_on: "2026-03-01", document_version_id: docId(/签收单/), quote: "买方于 2026 年 3 月 1 日签收全部货物" },
            { statement: "卖方于 2026 年 6 月 10 日发出催款函", kind: "claimed", occurred_on: "2026-06-10" },
          ],
        })],
        ["w_rep", mcp("docx.render_report"), () => ({
          title: "案情时间线（草稿）",
          sections: [{ heading: "一、时间线", paragraphs: ["2026 年 3 月 1 日，买方签收全部货物。", "2026 年 6 月 10 日，卖方发出催款函。", "2026 年 9 月 1 日，双方电话沟通未果（尚无材料）。"] }],
        })],
      ],
      "时间线草稿已生成。",
    );
  }
  return null; // 其余交给网关的 mock
};
console.log(`[script] cloud v0 up: ${cloud.env.ZR_GATEWAY_BASE}`);
await import(`${ROOT}/apps/desktop/dev/bridge.ts`);
