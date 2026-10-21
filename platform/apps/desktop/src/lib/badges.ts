/**
 * 执行位置徽标（第 03 篇 §8.3）：由事实生成，不靠推断（复核 S5-A04）——
 * 运行状态（排队、恢复、预算暂停、等待律师、对账各有文案）、场景是否调用模型、事项端点、是否全部化名、
 * 宿主事件里在途的执行域与检索/抓取工具、闸门在途的模型请求（runs.get 的 inflight）。
 */
export interface BadgeFacts {
  status: string;
  /** 运行场景（a1.agent_task / s1.contract_review 调用模型；s1b/s2/s6 只在本机）。 */
  scenario: string | null;
  /** 事项模型端点：standard / byok / private / none / mock。 */
  endpoint: string | null;
  /** 机构名称也替换为代号（全部化名或 L3a）。 */
  fullPseudonym: boolean;
  /** 闸门在途请求（已预写、尚未补全的去向记录）。 */
  inflight: { model: number; search: number; fetch: number } | null;
  /** 宿主事件：在途的工具调用（工具名）与执行域是否在运行。 */
  openTools: string[];
  execOpen: boolean;
  /** 退出模式的原因码（许可到期或未取得、本设备被吊销、缺控制面地址）：排队与恢复中的任务暂停（复核 S6-C12、S6-C18）。 */
  exitMode?: string | null;
}

export interface Badge {
  /** 胶囊文字（v9.4：≤ 6 字；说明放 title，悬停可见）。 */
  label: string;
  tone: "green" | "blue" | "orange" | "gray";
  title?: string;
}

const TERMINAL = ["succeeded", "partial", "failed", "cancelled", "timed_out", "expired"];
const MODEL_SCENARIOS = new Set(["a1.agent_task", "s1.contract_review"]);

function modelScope(endpoint: string | null, fullPseudonym: boolean): string {
  const scope = fullPseudonym ? "姓名、证件、账号、联系方式和公司名称已换成代号" : "姓名、证件、账号、联系方式已换成代号";
  switch (endpoint) {
    case "byok":
      return `用律所自己的 Kimi 账号；${scope}`;
    case "private":
      return "用律所自己的 AI";
    case "mock":
      return "示例，没有发出";
    default:
      return `发给 Kimi AI；${scope}`;
  }
}

/** 退出模式下暂停的任务：按原因写明会不会自动继续（复核 S6-C18）。 */
function pausedLabel(code: string): string {
  if (code === "device_revoked") return "已暂停（这台电脑已被律所停用，不会继续）";
  if (code === "control_plane_unconfigured") return "暂停（还没连上律所的服务，请联系管理员）";
  return "暂停（退出模式：恢复许可后自动继续）";
}

export function currentBadges(f: BadgeFacts): Badge[] {
  if (TERMINAL.includes(f.status)) return [];
  if (f.exitMode && ["queued", "created", "validating", "recovering"].includes(f.status)) return [{ label: pausedLabel(f.exitMode), tone: "orange" }];
  switch (f.status) {
    case "waiting_approval":
      return [{ label: "等待你确认", tone: "orange" }];
    case "waiting_input":
      return [{ label: "等待你回答", tone: "orange" }];
    case "waiting_device":
      return [{ label: "等待电脑上线", tone: "orange" }];
    case "queued":
    case "created":
    case "validating":
      return [{ label: "排队中", tone: "gray" }];
    case "recovering":
      return [{ label: "恢复中", tone: "gray", title: "软件中断过，正从中断的地方继续" }];
    case "budget_paused":
      return [{ label: "用量已到上限", tone: "orange", title: "等你决定是否继续" }];
    case "reconciling":
      return [{ label: "待核实", tone: "orange", title: "有一次发送结果不确定，请在“数据去向”里核实" }];
    default:
      break;
  }
  const out: Badge[] = [];
  if (f.openTools.includes("Bash") || f.execOpen) out.push({ label: "本机计算中", tone: "green", title: "在这台电脑上计算，不联网" });
  if (f.openTools.includes("WebSearch") || (f.inflight?.search ?? 0) > 0) out.push({ label: "联网查询中", tone: "blue", title: "查询已去掉当事人名称" });
  if (f.openTools.includes("FetchURL") || (f.inflight?.fetch ?? 0) > 0) out.push({ label: "打开网页中", tone: "blue", title: "只打开公开网页" });
  if ((f.inflight?.model ?? 0) > 0) out.push({ label: "AI 处理中", tone: "blue", title: modelScope(f.endpoint, f.fullPseudonym) });
  if (out.length === 0) {
    const usesModel = f.scenario !== null && MODEL_SCENARIOS.has(f.scenario) && f.endpoint !== "none";
    // v9.4（U1 #7）：用 AI 的任务写“AI 处理中”，原来一律“本机处理中”，与正文“AI 服务重试”自相矛盾
    out.push(usesModel ? { label: "AI 处理中", tone: "blue", title: modelScope(f.endpoint, f.fullPseudonym) } : { label: "本机处理中", tone: "green", title: "这一步在这台电脑上完成，不用 AI、不联网" });
  }
  return out;
}
