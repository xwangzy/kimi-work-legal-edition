/**
 * 执行态时间线（第 03 篇 §4.3）：事件 → 律师看得懂的步骤（只说事实）。纯函数，可单测（复核 B4-B07/B4-B21/B4-B23 抽出自 RunView）。
 * 律师层（默认可见）与处理细节（默认收起；UIUX P0-4）分开；工程原因码经映射表转中文。
 */
import type { RunEvent } from "../api.ts";
import { ARTIFACT_LABELS, fmtShortTime, MODE_LABELS, RUN_STATUS_LABELS } from "./labels.ts";

export const TOOL_LABELS: Record<string, string> = {
  Read: "读取材料",
  Glob: "查找文件",
  Grep: "检索材料内容",
  Write: "写草稿",
  Edit: "修改草稿",
  Bash: "在本机计算 / 整理数据",
  WebSearch: "联网查资料",
  FetchURL: "打开网页",
  Agent: "子任务",
  AgentSwarm: "子任务集群",
  TodoList: "任务清单",
  TaskList: "后台任务",
  TaskOutput: "后台任务输出",
  TaskStop: "停止后台任务",
  EnterPlanMode: "制定计划",
  ExitPlanMode: "提交计划",
  AskUserQuestion: "向你提问",
  ReadMediaFile: "查看图片",
  Skill: "使用方法模板",
};

export function toolLabel(name: string): string {
  if (name.startsWith("mcp__legal__")) {
    // 引擎里的工具名把第一个点写成下划线（materials.read_excerpt → mcp__legal__materials_read_excerpt）
    const raw = name.slice("mcp__legal__".length);
    return LEGAL_TOOL_LABELS[raw] ?? LEGAL_TOOL_LABELS[raw.replace("_", ".")] ?? "法律工具";
  }
  if (name.startsWith("mcp__")) return "外部资料库";
  return TOOL_LABELS[name] ?? name;
}

const SKIP_REASONS: Record<string, string> = {
  format: "格式不支持",
  too_large: "文件过大",
  limit: "超过数量上限",
  instructions: "助手指令文件，不作为交付件",
  unreadable: "无法解密读取（文件损坏，或不是经本软件写入的）",
};

/** 法律工具的中文名（律师层；原始工具名只在“处理细节”里出现）。 */
const LEGAL_TOOL_LABELS: Record<string, string> = {
  "materials.read_excerpt": "查阅材料原文",
  "law.get_version": "查法条版本",
  "law.search": "检索法规",
  "citations.verify": "核对引用",
  "calc.interest": "计算利息与违约金",
  "redact.scan": "检查个人信息",
  "materials.list": "查看材料目录",
  "riskcards.submit": "提交风险项",
  "riskcards.list": "查看审查结论",
  "facts.submit": "整理事实",
  "facts.list": "查看事实",
  "xlsx.render_table": "生成表格",
  "docx.render_report": "生成 Word 文书",
  "docx.compare": "比对两版合同",
};

export interface Step {
  key: string;
  /** 律师层（默认可见）或处理细节（默认收起；UIUX P0-4）。 */
  level: "lawyer" | "detail";
  icon: "ok" | "fail" | "dot" | "wait";
  title: string;
  meta?: string;
  agent?: string;
  detail?: string;
}

/** 联网检索/抓取实际发出的内容（来自本机去向记录，按工具调用编号关联；v9.2 Y4 P0-A）。 */
export interface SentInfo {
  kind: "search" | "fetch";
  /** 实际发出的查询或网址；未发出为 null。 */
  text: string | null;
  /** 检索：pass（令牌化后原样）/ generalized（去掉了当事人名称）/ confirmed_original（经你确认按原文）/ deny。 */
  decision: string | null;
  outcome: string;
}

/** 去向记录 → 工具调用编号 → 实际发出的内容（同一调用的预写与补全以补全为准）。纯函数。 */
export function sentByToolCall(records: readonly { note: string | null; outcome?: string }[]): Map<string, SentInfo> {
  const out = new Map<string, SentInfo>();
  for (const r of records) {
    let n: any;
    try {
      n = r.note ? JSON.parse(r.note) : null;
    } catch {
      n = null;
    }
    const id = typeof n?.tool_call_id === "string" ? n.tool_call_id : null;
    if (!id || (n.purpose !== "search" && n.purpose !== "fetch")) continue;
    const prev = out.get(id);
    if (prev && n.phase === "start") continue;
    out.set(id, {
      kind: n.purpose,
      text: n.purpose === "search" ? (typeof n.query?.sent === "string" ? n.query.sent : null) : typeof n.url?.requested === "string" && r.outcome !== "blocked" ? n.url.requested : null,
      decision: n.purpose === "search" ? (typeof n.query?.decision === "string" ? n.query.decision : null) : null,
      outcome: String(r.outcome ?? "sent"),
    });
  }
  return out;
}

function sentDetail(s: SentInfo): string {
  if (!s.text || s.outcome === "blocked") return s.kind === "search" ? "这次检索没有发出" : "这个网址没有打开";
  if (s.kind === "fetch") return `打开：${s.text}`;
  // 复核 S5B-11：“按原文”只保留机构名称，个人信息与标识符仍会替换
  const note = s.decision === "generalized" ? "（已去掉当事人名称）" : s.decision === "confirmed_original" ? "（经你确认保留机构名称发出，个人信息仍已替换）" : "";
  return `发出：${s.text}${note}`;
}

/** 事件 → 时间线步骤（只说事实）。sent：联网步骤实际发出的内容（没有则只提示去“数据去向”看）。 */
export function buildSteps(events: RunEvent[], skillTitles: Record<string, string> = {}, sent: ReadonlyMap<string, SentInfo> = new Map()): Step[] {
  const steps: Step[] = [];
  const toolIndex = new Map<string, number>();
  const approvalIndex = new Map<string, number>();
  const questionIndex = new Map<string, number>();
  for (const e of events) {
    const p = e.payload ?? {};
    const at = fmtShortTime(e.created_at);
    switch (e.type) {
      case "run.started":
        steps.push({ key: `${e.event_id}`, level: "detail", icon: "ok", title: "任务受理", meta: at });
        break;
      case "agent.task_started":
        steps.push({ key: `${e.event_id}`, icon: "ok", level: "detail", title: "助手已在本机启动", meta: at });
        break;
      case "agent.started":
        steps.push({ key: `${e.event_id}`, level: "detail", icon: "ok", title: `运行模式：${MODE_LABELS[p.mode as keyof typeof MODE_LABELS] ?? p.mode}${p.plan_first ? " · 先出计划" : ""}`, meta: `${at} · 数据级别 ${p.data_level ?? "—"}` });
        break;
      case "materials.loaded":
        steps.push({ key: `${e.event_id}`, level: "lawyer", icon: p.failed ? "fail" : "ok", title: Number(p.requested) === 0 ? "开始处理" : `已读完 ${p.loaded}/${p.requested} 份材料${p.failed ? `，${p.failed} 份无法读取` : ""}`, meta: at });
        break;
      case "plan.created":
        steps.push({ key: `${e.event_id}`, level: "detail", icon: "ok", title: "内部步骤已排定", meta: at, detail: (p.steps ?? []).join(" → ") });
        break;
      case "agent.tool_started": {
        const name = String(p.tool ?? "");
        // 进展通知只在“进展”面板显示（复核 S5B-01：上游每隔几次工具调用会催一次通知，不能每条都成为时间线步骤）
        if (name === "AskUserQuestion" || name === "ExitPlanMode" || name === "EnterPlanMode" || name === "NotifyUser") break;
        toolIndex.set(String(p.tool_call_id), steps.length);
        // 联网检索与抓取：不显示 Agent 自述（可能是改写前、含当事人名称的检索式，UIUX 增量评审 P0-A）——实际发出的内容见“数据去向”
        const network = name === "WebSearch" || name === "FetchURL";
        // 引擎的英文自述（“Reading file …”）不给律师看（复核 S5B-12）：只保留含中文的说明
        const rawDesc = !network && p.description ? String(p.description).replace(/^[A-Z][A-Za-z ]{1,24}:\s*/, "") : undefined;
        const desc = rawDesc && /[\u4e00-\u9fff]/.test(rawDesc) ? rawDesc : undefined;
        // 联网步骤显示实际发出的内容（改写后的查询或打开的网址），不显示改写前的检索式
        const s = network ? sent.get(String(p.tool_call_id)) : undefined;
        steps.push({
          key: `${e.event_id}`,
          level: "lawyer",
          icon: "wait",
          title: toolLabel(name),
          meta: network && !s ? `${at} · 实际发出的内容见右侧“数据去向”` : at,
          agent: p.agent_id && p.agent_id !== "main" ? String(p.agent_id) : undefined,
          detail: s ? sentDetail(s) : desc,
        });
        break;
      }
      case "agent.tool_result": {
        const i = toolIndex.get(String(p.tool_call_id));
        if (i !== undefined && steps[i]) {
          const st = steps[i]!;
          // 联网步骤已结束却没有任何去向记录：这一步没有离开电脑（例如你拒绝了确认卡，复核 S5B-11），不再指向“数据去向”
          const noRecord = (st.title === toolLabel("WebSearch") || st.title === toolLabel("FetchURL")) && !sent.has(String(p.tool_call_id));
          steps[i] = { ...st, icon: p.is_error ? "fail" : "ok", ...(noRecord ? { detail: "这一步没有联网发出", meta: (st.meta ?? "").replace(/ · 实际发出的内容见右侧“数据去向”$/, "") } : {}) };
        }
        break;
      }
      case "agent.exec.queued":
        steps.push({ key: `${e.event_id}`, level: "detail", icon: "wait", title: `本机计算排队（第 ${Number(p.position ?? 0) + 1} 位）`, meta: at });
        break;
      case "agent.exec.finished":
        steps.push({
          key: `${e.event_id}`,
          level: "detail",
          icon: Number(p.exit_code ?? 0) === 0 ? "ok" : "fail",
          title: `本机计算结束（退出码 ${p.exit_code ?? "—"}${p.duration_ms ? `，${Math.round(Number(p.duration_ms))} ms` : ""}）`,
          meta: at,
          detail: p.commit ? `工作区提交：写入 ${p.commit.written ?? 0}，删除 ${p.commit.deleted ?? 0}${p.commit.conflicts ? `，冲突 ${p.commit.conflicts}` : ""}` : undefined,
        });
        break;
      case "agent.approval_requested":
        approvalIndex.set(String(p.approval_id), steps.length);
        steps.push({ key: `${e.event_id}`, icon: "wait", level: "lawyer", title: `需要你确认：${toolLabel(String(p.tool ?? ""))}`, meta: at });
        break;
      case "agent.approval_auto":
        steps.push({ key: `${e.event_id}`, icon: "ok", level: "detail", title: "未要求先看计划，直接执行", meta: at });
        break;
      case "agent.approval_decided": {
        const i = approvalIndex.get(String(p.approval_id));
        if (i !== undefined && steps[i]) steps[i] = { ...steps[i]!, icon: p.decision === "approve" ? "ok" : "fail" };
        steps.push({ key: `${e.event_id}`, icon: p.decision === "approve" ? "ok" : "fail", level: "lawyer", title: p.decision === "approve" ? `你已同意${p.scope === "task" ? "（本任务内同类不再询问）" : ""}` : "你没有同意，已跳过", meta: at });
        break;
      }
      case "agent.approval_expired": {
        const i = approvalIndex.get(String(p.approval_id));
        if (i !== undefined && steps[i]) steps[i] = { ...steps[i]!, icon: "fail" };
        steps.push({ key: `${e.event_id}`, level: "lawyer", icon: "fail", title: "确认已超时，已跳过这一步", meta: at });
        break;
      }
      case "agent.subagent":
        // 子任务起止：进展面板里逐项显示；时间线只在没有完成时提醒律师
        if (p.event === "failed") steps.push({ key: `${e.event_id}`, level: "lawyer", icon: "fail", title: "有一个子任务没有完成，主任务会继续", meta: at });
        else steps.push({ key: `${e.event_id}`, level: "detail", icon: p.event === "spawned" ? "wait" : "ok", title: p.event === "spawned" ? "开始一个子任务" : `子任务${p.event === "done" ? "完成" : p.event === "cancelled" ? "已停止" : "暂停"}`, meta: at });
        break;
      case "agent.compaction":
        steps.push(
          p.event === "failed"
            ? { key: `${e.event_id}`, level: "lawyer", icon: "fail", title: "对话过长，助手暂停整理。请把任务拆小，或新开一个任务继续。", meta: at }
            : { key: `${e.event_id}`, level: p.event === "completed" ? "lawyer" : "detail", icon: "ok", title: p.event === "completed" ? `对话较长，助手已把前面的内容整理成摘要继续工作（第 ${p.count ?? 1} 次）` : "上下文整理已取消", meta: at, detail: p.event === "completed" ? "材料原文仍在，结论请以引用的原文为准。" : undefined },
        );
        break;
      case "agent.skill":
        steps.push({ key: `${e.event_id}`, level: "lawyer", icon: "ok", title: `已按方法模板《${skillTitles[String(p.skill)] ?? String(p.skill)}》执行`, meta: at });
        break;
      case "agent.question":
        questionIndex.set(String(p.question_id), steps.length);
        steps.push({ key: `${e.event_id}`, level: "lawyer", icon: "wait", title: "需要你定一下", meta: at });
        break;
      case "agent.question_answered": {
        const i = questionIndex.get(String(p.question_id));
        if (i !== undefined && steps[i]) steps[i] = { ...steps[i]!, icon: "ok" };
        steps.push({ key: `${e.event_id}`, level: "lawyer", icon: "ok", title: "已回答", meta: at });
        break;
      }
      case "agent.workspace_skipped":
      case "agent.workspace_rejected": {
        const files = Array.isArray(p.files) ? p.files : [];
        steps.push({
          key: `${e.event_id}`,
          level: "lawyer",
          icon: "dot",
          title: `${files.length} 个文件没有收进交付件${e.type === "agent.workspace_rejected" ? "（含外部链接，已拦下）" : ""}`,
          meta: at,
          detail: files.map((f: any) => `${f.path ?? f.filename}${SKIP_REASONS[f.reason] ? `（${SKIP_REASONS[f.reason]}）` : ""}`).join("、"),
        });
        break;
      }
      case "agent.error":
        // 律师层只给一句可理解的说明（不显示英文错误与状态码）；原文进“处理细节”（UIUX 增量评审 P0-D）。
        // retryable 由内核保留（复核 B4-B21：此前被裁掉，“正在自动重试”永远不出现）
        steps.push({ key: `${e.event_id}-l`, level: "lawyer", icon: "fail", title: p.retryable === true ? "AI 服务出了点问题，正在自动重试" : "这一步没有完成，任务会尽量继续", meta: at });
        steps.push({ key: `${e.event_id}`, level: "detail", icon: "fail", title: "错误详情", meta: at, detail: String(p.message ?? p.error ?? "") });
        break;
      case "agent.cancel_unconfirmed":
        // 停止请求与强制停止都没有得到本机助手的确认（复核 B4-B07：原文案“已强制停止”与事实相反）
        steps.push({ key: `${e.event_id}`, level: "lawyer", icon: "fail", title: CANCEL_UNCONFIRMED_TEXT, meta: at });
        if (p.error || p.cause) steps.push({ key: `${e.event_id}-d`, level: "detail", icon: "fail", title: "停止请求的处理详情", meta: at, detail: [p.cause ? `原因：${cancelCauseLabel(String(p.cause))}` : "", p.error ? String(p.error) : ""].filter(Boolean).join("；") });
        break;
      case "agent.cancel_forced":
        steps.push({ key: `${e.event_id}`, level: "detail", icon: "ok", title: `停止请求经强制方式生效（${cancelCauseLabel(String(p.cause ?? ""))}）`, meta: at });
        break;
      case "citations.verified":
        steps.push({ key: `${e.event_id}`, icon: Number(p.intercepted) > 0 ? "fail" : "ok", level: "lawyer", title: Number(p.intercepted) > 0 ? `核对引用：${p.total} 条中 ${p.intercepted} 条有问题，已标出` : `核对引用：${p.total} 条均已核对`, meta: at });
        break;
      case "model.completed":
        steps.push({ key: `${e.event_id}`, level: "detail", icon: "ok", title: "AI 分析完成", meta: `${at} · ${p.route ?? ""}` });
        break;
      case "artifact.drafted":
        steps.push({ key: `${e.event_id}`, icon: "ok", level: "lawyer", title: `草稿已生成：${p.kind === "a1_workspace_file" ? p.filename : ARTIFACT_LABELS[p.kind] ?? p.filename ?? "成果"}（待复核）`, meta: at });
        break;
      case "agent.outcome":
        // 原因码转中文（复核 B4-B23：不直接显示英文原因码）
        steps.push({ key: `${e.event_id}`, icon: p.status === "succeeded" ? "ok" : p.status === "partial" ? "dot" : "fail", level: "detail", title: `助手结束：${RUN_STATUS_LABELS[String(p.status)] ?? p.status}${p.reason ? `（${outcomeReasonLabel(String(p.reason))}）` : ""}`, meta: at });
        break;
      case "run.succeeded":
      case "run.partial":
      case "run.failed":
      case "run.cancelled":
      case "run.timed_out":
      case "run.expired":
      case "run.reconciling":
        steps.push({
          key: `${e.event_id}`,
          level: "lawyer",
          icon: e.type === "run.succeeded" ? "ok" : e.type === "run.partial" ? "dot" : "fail",
          title: RUN_STATUS_LABELS[e.type.slice(4)] ?? e.type,
          meta: at,
          detail: e.type === "run.failed" ? String(p.error ?? p.reason ?? "") : undefined,
        });
        break;
      default:
        break;
    }
  }
  return steps;
}

/** 停止请求没有得到确认时律师看到的一句话（复核 B4-B07）。 */
export const CANCEL_UNCONFIRMED_TEXT = "停止请求没有得到本机助手的确认，它可能仍在运行；请重启应用";

const CANCEL_CAUSE_LABELS: Record<string, string> = {
  version_conflict: "停止时恰好有新的确认或提问到达",
  timeout: "本机助手没有及时响应",
  forbidden: "本机助手记录的发起人与当前不一致",
  not_found: "本机助手找不到这个任务",
  host_exited: "本机助手已退出",
  error: "停止请求出错",
};

/** 停止请求未按版本生效的原因（中文）。 */
export function cancelCauseLabel(cause: string): string {
  return CANCEL_CAUSE_LABELS[cause] ?? (cause ? "其他原因" : "原因未知");
}

/** 助手结束原因（resolveAgentOutcome 与宿主收尾原因）→ 中文；未登记的原因码不直接显示英文。 */
const OUTCOME_REASON_LABELS: Record<string, string> = {
  cancelled: "已取消",
  timed_out: "超过时限",
  expired: "已过期",
  host_reported_failure: "助手报告失败",
  missing_completion_record: "没有收到完成记录",
  unknown_status: "状态无法识别",
  exit_code_mismatch: "退出状态与报告不一致",
  artifact_hash_mismatch: "成果校验不一致",
  content_filtered: "内容被模型服务拦截",
  length_truncated: "回答在长度上限处被截断",
  host_reported_partial: "助手声明部分完成",
  turn_not_completed: "这一轮没有正常结束",
  missing_artifact: "没有产出可交付的内容",
  finish_reason_unknown: "模型没有给出确定的结束原因",
  finish_reason_unreported: "模型没有上报结束原因",
  workspace_commit_incomplete: "部分文件没有写入工作区",
  run_deadline_exceeded: "超过工作时限",
  run_wall_deadline_exceeded: "超过总时长上限",
  prompt_rejected: "任务没有被助手受理",
  host_exited: "本机助手进程退出",
  start_failed: "启动失败",
  unknown_task: "任务不存在",
};

export function outcomeReasonLabel(reason: string): string {
  if (OUTCOME_REASON_LABELS[reason]) return OUTCOME_REASON_LABELS[reason]!;
  // 宿主取消时的原因是人写的中文（例如“用户取消”）；英文原因码一律不直接显示
  return /^[\x00-\x7f]*$/.test(reason) ? "其他原因" : reason.slice(0, 40);
}
