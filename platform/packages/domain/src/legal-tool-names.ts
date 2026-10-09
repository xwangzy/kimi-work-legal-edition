/**
 * A1 法律 MCP 工具面（§4.2 工具层；探针 2）——kernel（local-server /mcp 白名单）与
 * agent-host（mcp.json enabledTools）同源的单一出处，避免双份漂移。
 * 外发、签发、删除类动作根本不在注册表内（§6.2），此处仅为「允许暴露给 Agent」的子集。
 */
export const LEGAL_MCP_TOOLS = [
  "materials.read_excerpt",
  "law.get_version",
  "law.search",
  "citations.verify",
  "calc.interest",
  "redact.scan",
] as const;

export type LegalMcpToolName = (typeof LEGAL_MCP_TOOLS)[number];
