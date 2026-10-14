/**
 * Kimi Code 内置工具分级（v9 第 02 篇 §9.4，与锁版 2.1.1 的内置工具一一对应）。
 *
 * 级别决定“默认”模式下是自动、询问还是拒绝；跨边界动作（§9.5）另行判定。
 * 表外的工具（含上游新增工具、实验开关锁死的 Tower*、select_tools）一律拒绝——上游新增能力默认不可用，
 * 由能力账本评审后再登记（第 04 篇 §2）。
 */

export type ToolGrade =
  | "T0" // 读：读工作区（令牌化视图）、法规库、本所知识；任务状态
  | "T0'" // 图像原样送模型（跨边界）
  | "T1" // 写工作区草稿（可回滚）
  | "T2" // 执行域内 Shell / Python
  | "T2-stop" // 停止后台任务（能力账本：须确认）
  | "T3" // 编排：子 Agent、集群、目标、计划
  | "T4" // 联网检索（经闸门）
  | "T5" // 抓取公开网页（经闸门）
  | "T6" // 数据源与律所连接器（MCP）
  | "T7" // 跨事项
  | "T8" // 定时
  | "plan" // 计划审批（ExitPlanMode：计划审批走业务审批卡，能力账本“计划模式”行）
  | "UI"; // 交互：提问、进度通知、待办（无副作用）

export interface BuiltinToolSpec {
  grade: ToolGrade;
  /** 参数中携带路径的字段名（用于区域检查）。 */
  pathArgs?: readonly string[];
  /** 写入类：路径必须落在工作区。 */
  writes?: boolean;
}

export const BUILTIN_TOOLS: Readonly<Record<string, BuiltinToolSpec>> = Object.freeze({
  Read: { grade: "T0", pathArgs: ["path", "file_path"] },
  Glob: { grade: "T0", pathArgs: ["path", "directory"] },
  Grep: { grade: "T0", pathArgs: ["path", "directory"] },
  Skill: { grade: "T0" },
  TaskList: { grade: "T0" },
  TaskOutput: { grade: "T0" },
  WaitFor: { grade: "T0" },
  CronList: { grade: "T0" },
  ReadMediaFile: { grade: "T0'", pathArgs: ["path", "file_path"] },
  Write: { grade: "T1", pathArgs: ["path", "file_path"], writes: true },
  Edit: { grade: "T1", pathArgs: ["path", "file_path"], writes: true },
  Bash: { grade: "T2", pathArgs: ["cwd"] },
  TaskStop: { grade: "T2-stop" },
  Agent: { grade: "T3" },
  AgentSwarm: { grade: "T3" },
  CreateGoal: { grade: "T3" },
  GetGoal: { grade: "T3" },
  SetGoalBudget: { grade: "T3" },
  UpdateGoal: { grade: "T3" },
  EnterPlanMode: { grade: "UI" },
  ExitPlanMode: { grade: "plan" },
  TodoList: { grade: "UI" },
  SetTodoList: { grade: "UI" },
  AskUserQuestion: { grade: "UI" },
  NotifyUser: { grade: "UI" },
  WebSearch: { grade: "T4" },
  FetchURL: { grade: "T5" },
  CronCreate: { grade: "T8" },
  CronDelete: { grade: "T8" },
});

/** 实验开关锁死的工具（ZP-13）：即使上游注册也拒绝。 */
export const LOCKED_OFF_TOOLS = new Set([
  "TowerInit",
  "TowerMission",
  "TowerPlan",
  "TowerSpawn",
  "TowerSend",
  "TowerInbox",
  "TowerStatus",
  "TowerReview",
  "TowerMerge",
  "TowerFinding",
  "TowerTeardown",
  "select_tools",
]);

/** 第 02 篇 §9.5 跨边界动作编号（确认卡上的“为什么要确认”）。 */
export const CROSS_BOUNDARY = {
  searchEntity: "①检索查询可能含当事人实体（未经闸门泛化）",
  fetchNewDomain: "②抓取新域名",
  connectorWrite: "③连接器写入或按次计费",
  crossMatter: "④跨事项读取",
  schedule: "⑤创建定时任务",
  budget: "⑥超出任务预算",
  imageToModel: "⑦图像原样送模型",
  lowerTrustDestination: "⑧交给可接收级别更低的去向",
  migrateToCloud: "⑨迁移为云端事项",
  widenMaterials: "⑩扩大材料范围",
  stopTask: "停止后台任务（能力账本：须确认）",
} as const;

/** Agent 的工具（文件工具、可信 rg、执行域）可寻址的 broker 区域；其余区域（如引擎内部状态 engine）只供引擎自身使用。 */
export const TOOL_ZONES: ReadonlySet<string> = new Set(["materials", "work", "trusted"]);
