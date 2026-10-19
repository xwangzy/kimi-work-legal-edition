/**
 * 跨边界确认卡（v9 第 03 篇 §8.2；第 02 篇 §9.5）：卡片内容由内核按待决审批与事项记录重算——不采信 Agent 宿主或模型的说法。
 * 卡片写明要做什么、为什么、数据会去哪里、预计费用；检索卡给出“原文放行 / 改写后”各自将发出的查询（由与闸门同一份筛查代码算出）。
 * 同时给出批准时应签发的出站凭据规格（检索、新域名抓取、图像原样送模型）；其余卡片只是宿主层面的确认，不签发出站凭据。
 */
import { basename } from "node:path";
import { egressDigest, type ApprovalPurpose } from "@zr-legal/egress-gate";

/** kap-host 的 run.approval_requested 载荷（内核侧保存的待决项）。 */
export interface PendingApproval {
  approval_id: string;
  tool: string;
  action?: string | null;
  display?: Record<string, unknown> | null;
  input?: { query?: string; url?: string; path?: string; command?: string; file_path?: string } | null;
  object_hash: string;
  nonce: string;
  expires_at: string;
  reason: string;
  cross_boundary: string | null;
  scope_options: ("once" | "task")[];
  agent_id?: string;
  /** Agent 在这一步的说明（模型自述，令牌形态）。 */
  agent_note?: string | null;
  /** 超预算询问（复核 B4-B06）：本次要派出的子任务数与询问时的余额（宿主策略记下）。 */
  budget?: { members?: unknown; tool_calls_left?: unknown; subagents_left?: unknown } | null;
}

export interface ApprovalCardView {
  approval_id: string;
  kind: "plan" | "search" | "fetch" | "image" | "budget" | "schedule" | "stop" | "manual" | "connector" | "other";
  tool: string;
  reason: string;
  title: string;
  why: string;
  /** 为什么要问我：机制说明（界面折叠显示；Z3 评审 3.3）。 */
  why_detail?: string;
  destination: string;
  cost: string | null;
  preview: { send_original?: string; send_generalized?: string; url?: string; host?: string; plan?: string; detail?: string };
  scope_options: ("once" | "task")[];
  variants?: ("original" | "generalized")[];
  /** “本任务内允许”放行的变体（检索只能是改写后——第 02 篇 §8.3）。 */
  task_variant?: "generalized";
  /** Agent 在这一步的说明（模型自述，仅供参考；第 03 篇 §8.2“为什么”）。 */
  agent_note?: string | null;
  object_hash: string;
  nonce: string;
  expires_at: string;
}

/** 批准时签发出站凭据的规格（闸门据此独立核验）。 */
export interface CredentialSpec {
  purpose: ApprovalPurpose;
  /** “本次”时的出站内容摘要（图像为 null，首次使用时绑定）。 */
  onceDigest: string | null;
  dest: string;
  variants: ("original" | "generalized")[];
  taskAllowed: boolean;
}

export interface CardContext {
  dataLevel: string;
  /** 事项的模型端点（确认卡写明数据实际去向——复核 S5-A06）。 */
  modelEndpoint?: string;
  /** 本任务预算（超预算卡写明上限）。 */
  budget?: { maxToolCalls: number; maxSubagents: number };
  /** 检索筛查（与闸门同一份代码）：给定变体时返回将实际发出的查询；不给变体时返回是否须确认。 */
  screenSearch(query: string, variant?: "original" | "generalized"): { decision: "pass" | "generalized" | "deny"; reason?: string; sent?: string };
}

const TOOL_LABELS: Record<string, string> = {
  Read: "读取材料",
  Glob: "查找文件",
  Grep: "检索材料内容",
  Write: "写入工作区草稿",
  Edit: "修改工作区草稿",
  Bash: "在这台电脑上做计算（不能联网）",
  WebSearch: "联网检索",
  FetchURL: "抓取网页",
  Agent: "启动子任务",
  AgentSwarm: "启动子任务集群",
  ReadMediaFile: "读取图像",
  TaskStop: "停止后台任务",
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function buildApprovalCard(p: PendingApproval, ctx: CardContext): { card: ApprovalCardView; credential: CredentialSpec | null } {
  const base = {
    approval_id: p.approval_id,
    tool: p.tool,
    reason: p.reason,
    object_hash: p.object_hash,
    nonce: p.nonce,
    expires_at: p.expires_at,
    scope_options: p.scope_options,
    ...(p.agent_note ? { agent_note: p.agent_note } : {}),
  };
  const display = (p.display ?? {}) as Record<string, unknown>;
  const input = p.input ?? {};
  const reason = p.reason.replace(/^tool_confirmation:/, "");

  if (p.tool === "ExitPlanMode") {
    return {
      card: {
        ...base,
        kind: "plan",
        title: "确认执行计划",
        why: "已开启“先出计划”：计划经你确认后才执行。",
        destination: "—",
        cost: null,
        preview: { plan: str(display.plan) ?? "" },
        scope_options: ["once"],
      },
      credential: null,
    };
  }

  if (p.tool === "WebSearch") {
    const query = str(input.query) ?? str(display.query) ?? "";
    const screen = ctx.screenSearch(query);
    const l3a = ctx.dataLevel === "L3a";
    const needsCredential = screen.decision === "deny" && (screen.reason === "search_entity_requires_confirmation" || screen.reason === "search_l3a_each_query");
    const variants: ("original" | "generalized")[] = !needsCredential ? [] : l3a ? ["generalized"] : ["original", "generalized"];
    const sendOriginal = needsCredential && !l3a ? ctx.screenSearch(query, "original").sent : screen.sent;
    const sendGeneralized = needsCredential ? ctx.screenSearch(query, "generalized").sent : undefined;
    // 首屏只放一句话（Z3 评审 3.3、#5）；原来的机制说明原样放进 why_detail，界面收在“为什么要问我”折叠里
    const why = l3a
      ? "这是敏感事项：每一条检索都要你确认，而且只能换成一般说法再查。"
      : needsCredential
        ? "检索词里有当事人名称或代号，建议换成一般说法（如“某公司”）再查。"
        : reason === "manual_mode"
          ? "手动档：每一次联网检索都先问你。"
          : "这一次检索需要你确认。";
    const whyDetail = l3a
      ? "敏感事项（L3a）的每一条检索都须你确认；只能以改写后的一般性查询发出。"
      : needsCredential
        ? "检索式中含有当事人名称（或其简称、其他写法）、自然人姓名或事项代号：可逐条确认按原文发出（保留机构当事人名称；已识别的自然人姓名改为“某人”，证件号、账号等标识符去除——识别可能遗漏，请核对检索式），或改写为不含当事人的一般性查询。"
        : null;
    // “本任务内允许”只放行改写后的一般性查询（第 02 篇 §8.3；复核 S5-A02/B01）；原文放行只能逐条
    const taskAllowed = !l3a && p.scope_options.includes("task");
    return {
      card: {
        ...base,
        kind: "search",
        title: `联网检索：“${query}”`,
        why,
        ...(whyDetail ? { why_detail: whyDetail } : {}),
        // 去向如实写全（主审更正 I2 的简化稿）：查询经中软检索服务转给月之暗面检索；不带事项编号，中软不保存查询原文——但查询文字本身（含按原文放行时的机构当事人名称）会到达月之暗面
        destination: "中软检索服务 → 月之暗面检索（不带是哪个事项；中软不保存查询原文，查询文字会发给月之暗面）",
        cost: "1 次检索 · 计入本所用量",
        preview: { ...(sendOriginal !== undefined ? { send_original: sendOriginal } : {}), ...(sendGeneralized !== undefined ? { send_generalized: sendGeneralized } : {}) },
        scope_options: taskAllowed ? p.scope_options : ["once"],
        ...(variants.length ? { variants } : {}),
        ...(taskAllowed && needsCredential ? { task_variant: "generalized" as const } : {}),
      },
      credential: needsCredential
        ? { purpose: "search", onceDigest: egressDigest("WebSearch", query), dest: "search_service", variants, taskAllowed }
        : null,
    };
  }

  if (p.tool === "FetchURL") {
    const url = str(input.url) ?? str(display.url) ?? "";
    const host = hostOf(url) ?? "";
    const newDomain = reason === "fetch_new_domain";
    return {
      card: {
        ...base,
        kind: "fetch",
        title: `抓取网页：${url}`,
        why: newDomain ? `${host} 不在常用官方网站名单里：第一次打开要你确认。` : reason === "manual_mode" ? "手动档：每一次打开网页都先问你。" : "这一次打开网页需要你确认。",
        destination: `公开网站 ${host}（由这台电脑直接打开；网址里没有当事人和事项信息；跳到其他没确认过的网站会被拦下）`,
        cost: "不计入用量",
        preview: { url, host },
      },
      credential: newDomain && host ? { purpose: "fetch", onceDigest: egressDigest("FetchURL", url), dest: host, variants: [], taskAllowed: p.scope_options.includes("task") } : null,
    };
  }

  if (p.tool === "ReadMediaFile" && reason === "image_to_model") {
    const path = str(input.path) ?? str(input.file_path) ?? str(display.path) ?? "";
    return {
      card: {
        ...base,
        kind: "image",
        title: `把图片“${basename(path) || "（未知文件）"}”原样发给模型`,
        why: "默认改走本机 OCR（只发送识别出的文字，并经令牌化）。原样发送时，图片中的姓名、证件号等无法替换为代号。",
        destination: `${modelDestination(ctx.modelEndpoint)}；本运行内重发同一张图片无需再次确认`,
        cost: "按 AI 用量计入本所用量",
        preview: { detail: "批准只放行本任务接下来的一张新图片。" },
        scope_options: ["once"],
      },
      credential: { purpose: "media", onceDigest: null, dest: "model", variants: [], taskAllowed: false },
    };
  }

  const kind: ApprovalCardView["kind"] =
    reason === "over_budget" ? "budget" : reason === "schedule_requires_confirmation" ? "schedule" : reason === "stop_task_requires_confirmation" ? "stop" : reason === "manual_mode" ? "manual" : p.tool.startsWith("mcp__") ? "connector" : "other";
  const label = TOOL_LABELS[p.tool] ?? (p.tool.startsWith("mcp__") ? `调用连接器 ${p.tool.slice(5)}` : p.tool);
  const detail = str(input.command) ?? str(input.path) ?? str(input.file_path) ?? str(display.description) ?? undefined;
  // 超预算卡写明本次要派出的子任务数与余额（复核 B4-B06；Y3 §3.1“这一步要同时派出 {n} 个子任务”）
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 100_000) : null);
  const members = kind === "budget" ? count(p.budget?.members) : null;
  const subLeft = count(p.budget?.subagents_left);
  const why: Record<string, string> = {
    budget:
      members !== null && members > 0
        ? `本任务的子任务额度${subLeft !== null ? `还剩 ${subLeft} 个` : "已用完"}${ctx.budget ? `（上限 ${ctx.budget.maxSubagents} 个）` : ""}，这一步要派出 ${members} 个：继续执行须你确认。批准后按实际派出数计入额度，之后再超出仍会逐次问你。`
        : `本任务的工具调用已达预算上限${ctx.budget ? `（工具调用 ${ctx.budget.maxToolCalls} 次、子任务 ${ctx.budget.maxSubagents} 个）` : ""}：继续执行须你确认。`,
    schedule: "创建定时任务须你确认（定时任务按“定时”渠道权限运行，遇确认即暂停）。",
    stop: "停止后台任务须你确认。",
    manual: "手动档：每一步都先问你。",
    connector: "写入或按次计费的连接器调用须你确认。",
    other: "这一步需要你确认。",
  };
  return {
    card: {
      ...base,
      kind,
      title: members !== null && members > 0 ? `这一步要同时派出 ${members} 个子任务` : label,
      why: why[kind] ?? why.other!,
      destination: p.tool.startsWith("mcp__") ? "律所批准的连接器" : "这台电脑（不联网）",
      cost: kind === "budget" ? "继续做会按实际用量计入本所用量（AI 按用量、检索按次）" : null,
      preview: detail ? { detail } : {},
    },
    credential: null,
  };
}

/** 模型请求的实际去向（按事项端点）。 */
function modelDestination(endpoint: string | undefined): string {
  switch (endpoint) {
    case "byok":
      return "Kimi 模型（律所自带密钥，直连月之暗面，不经中软）";
    case "private":
      return "律所私有模型（不经中软）";
    case "none":
      return "（本事项设置为不使用模型）";
    default:
      return "Kimi 模型（经中软网关）";
  }
}
