/**
 * A1 法律 MCP 工具面（§4.2 工具层；探针 2）——kernel（local-server /mcp 白名单）与
 * kap-host（内存 mcp.json 与宿主策略）同源的单一出处，避免双份漂移。
 * 外发、签发、删除类动作根本不在注册表内（§6.2），此处仅为「允许暴露给 Agent」的子集。
 */
export const LEGAL_MCP_TOOLS = [
  "materials.read_excerpt",
  "law.get_version",
  "law.search",
  "citations.verify",
  "calc.interest",
  "redact.scan",
  // 2026-10-13 审计 D2：结构化产出与材料目录（Skills 依赖），文书与表格生成（写本事项草稿），整稿比对（只读）
  "materials.list",
  "riskcards.submit",
  "riskcards.list",
  "facts.submit",
  "facts.list",
  "xlsx.render_table",
  "docx.render_report",
  "docx.compare",
  // 2026-10-21 v9.4 评审 S1 §6.2 第 4、9 项：取条文原文（论证支持比对）、期间计算（届满日附过程）
  "law.get_article",
  "calc.deadline",
  // 2026-10-22 v9.4 第 19 批 C-04：起草前提交论点与依据、读取律师确认版
  "outline.submit",
  "outline.get",
  // 2026-10-22 v9.4 第 19 批 C-01：表格审阅（读表、逐格填值与引文；律师已核的格子不覆盖）
  "table.get",
  "table.fill",
  // 2026-10-22 v9.4 第 20 批：劳动经济补偿与违法解除赔偿金（确定性计算，附过程）
  "calc.labor",
  // 2026-10-22 v9.4 第 21 批：诉讼费用（受理费、执行与保全申请费、支付令；确定性计算，附过程）
  "calc.court_fee",
  // 2026-10-22 v9.4 第 22 批：从范本起草本事项的审查要点（只存草稿，律师审定启用后才用于审查）
  "rules.propose",
  // 2026-10-28 第 28 批：在律师上传的 Word 原件副本上写修订（修订稿 + 清洁稿，写本事项草稿；原件不变）
  "docx.revise",
] as const;

export type LegalMcpToolName = (typeof LEGAL_MCP_TOOLS)[number];
