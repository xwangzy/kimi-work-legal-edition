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
  label: string;
  tone: "green" | "blue" | "orange" | "gray";
}

const TERMINAL = ["succeeded", "partial", "failed", "cancelled", "timed_out", "expired"];
const MODEL_SCENARIOS = new Set(["a1.agent_task", "s1.contract_review"]);

function modelBadge(endpoint: string | null, fullPseudonym: boolean): string {
  const scope = fullPseudonym ? "证件、账户、联系方式、自然人姓名与机构名称已替换为代号" : "证件、账户、联系方式与自然人姓名已替换为代号";
  switch (endpoint) {
    case "byok":
      return `AI 正在处理（用律所自己的 Kimi 账号，不经中软；${scope}）`;
    case "private":
      return "AI 正在处理（律所私有模型，不经中软）";
    case "mock":
      return "AI 正在处理（本机示例，不外发）";
    default:
      return `AI 正在处理（经中软；${scope}）`;
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
      return [{ label: "恢复中（从最后检查点继续）", tone: "gray" }];
    case "budget_paused":
      return [{ label: "预算暂停（等你决定）", tone: "orange" }];
    case "reconciling":
      return [{ label: "发送结果不确定，待核实", tone: "orange" }];
    default:
      break;
  }
  const out: Badge[] = [];
  if (f.openTools.includes("Bash") || f.execOpen) out.push({ label: "在这台电脑上计算（不联网）", tone: "green" });
  if (f.openTools.includes("WebSearch") || (f.inflight?.search ?? 0) > 0) out.push({ label: "联网检索中（去标识查询经中软检索服务）", tone: "blue" });
  if (f.openTools.includes("FetchURL") || (f.inflight?.fetch ?? 0) > 0) out.push({ label: "正在打开公开网页", tone: "blue" });
  if ((f.inflight?.model ?? 0) > 0) out.push({ label: modelBadge(f.endpoint, f.fullPseudonym), tone: "blue" });
  if (out.length === 0) {
    const usesModel = f.scenario !== null && MODEL_SCENARIOS.has(f.scenario) && f.endpoint !== "none";
    out.push({ label: usesModel ? "本机处理中" : "本机处理中（本场景不调用模型、不联网）", tone: "green" });
  }
  return out;
}
