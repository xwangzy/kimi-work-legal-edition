/**
 * 任务执行态（第 03 篇 §4.3 三栏：左 材料与覆盖；中 计划、进度、澄清、确认卡、子任务；右 成果预览与文件历史；§8.3 执行域徽标；§8.4 数据去向卡）。
 * 事件先落本机事项账本，本页按游标续读；离开本页不会取消任务。确认卡独立于聊天文本（模型文本里的“已批准”不触发权限）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, onKernelEvent, type ApprovalCard, type QuestionCard, type RunEvent, type RunMode, type UnresolvedOperation } from "../api.ts";
import { nav } from "../App.tsx";
import { ApprovalCardView, QuestionCardView } from "../components/Cards.tsx";
import { DataFlowCard, reasonLabel } from "../components/DataFlow.tsx";
import { Icon } from "../components/Icons.tsx";
import { Markdown, tokens as renderTokens } from "../components/Markdown.tsx";
import { SafePreview } from "../components/SafePreview.tsx";
import { ReviewWorkbench } from "../components/ReviewWorkbench.tsx";
import { ARTIFACT_LABELS, artifactName, CITE_STATE_LABELS, EFFECTIVENESS_LABELS, fmtShortTime, fmtTime, MODE_LABELS, RUN_STATUS_LABELS, SCENARIO_LABELS, TERMINAL_STATUSES } from "../lib/labels.ts";
import { forgetRestored, restoreTokens } from "../lib/tokens.ts";
import { currentBadges } from "../lib/badges.ts";

const TOOL_LABELS: Record<string, string> = {
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

function toolLabel(name: string): string {
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
  instructions: "Agent 指令文件，不作为交付件",
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

interface Step {
  key: string;
  /** 律师层（默认可见）或处理细节（默认收起；UIUX P0-4）。 */
  level: "lawyer" | "detail";
  icon: "ok" | "fail" | "dot" | "wait";
  title: string;
  meta?: string;
  agent?: string;
  detail?: string;
}

/** 事件 → 时间线步骤（只说事实）。 */
function buildSteps(events: RunEvent[]): Step[] {
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
        steps.push({ key: `${e.event_id}`, icon: "ok", level: "detail", title: "Agent 引擎已启动（本机）", meta: at });
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
        if (name === "AskUserQuestion" || name === "ExitPlanMode" || name === "EnterPlanMode") break;
        toolIndex.set(String(p.tool_call_id), steps.length);
        steps.push({ key: `${e.event_id}`, level: "lawyer", icon: "wait", title: toolLabel(name), meta: at, agent: p.agent_id && p.agent_id !== "main" ? String(p.agent_id) : undefined, detail: p.description ? String(p.description) : undefined });
        break;
      }
      case "agent.tool_result": {
        const i = toolIndex.get(String(p.tool_call_id));
        if (i !== undefined && steps[i]) steps[i] = { ...steps[i]!, icon: p.is_error ? "fail" : "ok" };
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
        steps.push({ key: `${e.event_id}`, level: "lawyer", icon: "fail", title: "确认已超时，Agent 跳过了这一步", meta: at });
        break;
      }
      case "agent.question":
        questionIndex.set(String(p.question_id), steps.length);
        steps.push({ key: `${e.event_id}`, level: "lawyer", icon: "wait", title: "Agent 想先问你", meta: at });
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
        steps.push({ key: `${e.event_id}`, level: "detail", icon: "fail", title: "Agent 报告了一个错误", meta: at, detail: String(p.message ?? p.error ?? "") });
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
        steps.push({ key: `${e.event_id}`, icon: p.status === "succeeded" ? "ok" : p.status === "partial" ? "dot" : "fail", level: "detail", title: `Agent 结束：${RUN_STATUS_LABELS[String(p.status)] ?? p.status}${p.reason ? `（${p.reason}）` : ""}`, meta: at });
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

/** 页面标题：任务目标前 24 字（律师能区分多个任务）；没有目标时用场景名。 */
function runTitle(run: any): string {
  const goal = String(run?.goal ?? run?.input_snapshot?.goal ?? "").replace(/\s+/g, " ").trim();
  if (goal) return goal.length > 24 ? `${goal.slice(0, 24)}…` : goal;
  return SCENARIO_LABELS[run?.scenario] ?? "任务";
}

/** 宿主事件中在途的工具与执行域（执行位置徽标的事实之一）。 */
function openToolsOf(events: RunEvent[]): { openTools: string[]; execOpen: boolean } {
  const open = new Map<string, string>();
  let execOpen = false;
  for (const e of events) {
    if (e.type === "agent.tool_started") open.set(String(e.payload.tool_call_id), String(e.payload.tool));
    if (e.type === "agent.tool_result") open.delete(String(e.payload.tool_call_id));
    if (e.type === "agent.exec.queued") execOpen = true;
    if (e.type === "agent.exec.finished") execOpen = false;
  }
  return { openTools: [...open.values()], execOpen };
}

type RightTab = "artifact" | "history" | "egress" | "citations" | "record";

export function RunView({ runId, matterId }: { runId: string; matterId: string }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState("queued");
  const [run, setRun] = useState<any>(null);
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [docs, setDocs] = useState<any[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedOperation[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [questions, setQuestions] = useState<QuestionCard[]>([]);
  const [stateVersion, setStateVersion] = useState<number | null>(null);
  const [egressInflight, setEgressInflight] = useState<{ model: number; search: number; fetch: number } | null>(null);
  const [matter, setMatter] = useState<any>(null);
  const [tab, setTab] = useState<RightTab>("artifact");
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ filename: string; text: string; office?: boolean } | null>(null);
  // 本任务提交的风险卡（按合同分组）；打开审查工作台时整页切换
  const [risk, setRisk] = useState<{ total: number; highOpen: number; decided: number; docs: string[]; unlinked: number } | null>(null);
  /** 打开的审查工作台：doc 为 null 表示“未关联合同的意见”。 */
  const [workbench, setWorkbench] = useState<{ doc: string | null } | null>(null);
  // 正在生成的回复（流式；运行中每秒随待决卡片一起取）
  const [liveText, setLiveText] = useState<string>("");
  const [followText, setFollowText] = useState("");
  /** 追问前的一行确认（复核 B3-B10）：沿用的档位、估价与内容去向；问答档要写入草稿须明确勾选（复核 B3-B09）。 */
  const [followConfirm, setFollowConfirm] = useState<{ estimate_id: string; points_display: string; preview: string; warning: string | null; blocked: boolean } | null>(null);
  const [followRaise, setFollowRaise] = useState(false);
  const [tokenMap, setTokenMap] = useState<Map<string, string | null>>(new Map());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [exitMode, setExitMode] = useState<string | null>(null);
  const cursor = useRef(0);
  const inflight = useRef(false);
  const terminal = TERMINAL_STATUSES.includes(status);

  const refresh = useCallback(async () => {
    // 单飞：定时器与内核广播可能同时触发；同一游标只取一次，按事件 ID 去重
    if (inflight.current) return;
    inflight.current = true;
    try {
      const r = await api.runEvents(runId, cursor.current);
      if (r.events.length > 0) {
        cursor.current = r.next_cursor;
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.event_id));
          return [...prev, ...r.events.filter((e) => !seen.has(e.event_id))];
        });
      }
      setStatus(r.run_status);
      const g = await api.getRun(runId);
      setRun(g.run);
      setArtifacts(g.artifacts);
      setEgressInflight(g.inflight ?? null);
      setUnresolved(g.unresolved_operations ?? []);
      const rc = await api.riskCards(matterId, { run_id: runId }).catch(() => null);
      if (rc && rc.cards.length > 0) {
        const docsOf = [...new Set(rc.cards.map((c) => c.document_version_id).filter((x): x is string => !!x))];
        setRisk({ total: rc.progress.total, highOpen: rc.progress.high_open, decided: rc.progress.decided, docs: docsOf, unlinked: rc.cards.filter((c) => !c.document_version_id).length });
      } else setRisk(null);
      if (!TERMINAL_STATUSES.includes(r.run_status)) {
        const i = await api.interactions(runId).catch(() => ({ approvals: [], questions: [], state_version: null, live_text: null }));
        setApprovals(i.approvals);
        setQuestions(i.questions);
        setStateVersion(i.state_version ?? null);
        setLiveText(i.live_text ?? "");
      } else {
        setApprovals([]);
        setQuestions([]);
        setLiveText("");
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      inflight.current = false;
    }
  }, [runId, matterId]);

  useEffect(() => {
    forgetRestored(matterId);
    cursor.current = 0;
    void refresh();
    api
      .getMatter(matterId)
      .then((r) => {
        setDocs(r.documents);
        setMatter(r.matter);
      })
      .catch(() => {});
    const off = onKernelEvent((m) => {
      if (m?.run_id === runId) void refresh();
    });
    return off;
  }, [runId, matterId, refresh]);
  useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [terminal, refresh]);

  // 代号只在界面还原（标题、计划、提问、预览）
  const texts = useMemo(
    () => [preview?.text ?? "", liveText, ...approvals.flatMap((a) => [a.title, a.preview.plan ?? "", a.preview.detail ?? ""]), ...questions.flatMap((q) => q.questions.flatMap((x) => [x.question, ...x.options.map((o) => o.label)])), ...events.map((e) => String(e.payload?.description ?? ""))].join("\n"),
    [preview, liveText, approvals, questions, events],
  );
  useEffect(() => {
    if (!texts.includes("〔")) return;
    restoreTokens(matterId, texts).then(setTokenMap).catch(() => {});
  }, [texts, matterId]);

  // 默认预览：Agent 回复或第一份成果
  useEffect(() => {
    if (selected || artifacts.length === 0) return;
    const first = artifacts.find((a) => a.kind === "a1_agent_draft" || a.kind === "final_message") ?? artifacts[0];
    if (first) setSelected(first.artifact_version_id);
  }, [artifacts, selected]);
  useEffect(() => {
    if (!selected) return;
    const a = artifacts.find((x) => x.artifact_version_id === selected);
    if (!a) return;
    if (/\.(docx|xlsx)$/i.test(a.filename)) {
      // Office 成果：内核渲染为白名单 HTML（修订显示为插入/删除），在隔离框架中预览
      api
        .artifactHtml(selected)
        .then((r) => setPreview({ filename: a.filename, text: r.html, office: true }))
        .catch(() => setPreview({ filename: a.filename, text: "" }));
      return;
    }
    if (!/\.(md|txt|markdown|html?|json)$/i.test(a.filename)) {
      setPreview({ filename: a.filename, text: "" });
      return;
    }
    api
      .artifactText(selected)
      .then((r) => setPreview({ filename: a.filename, text: new TextDecoder().decode(Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0))) }))
      .catch((e) => setErr(e.message));
  }, [selected, artifacts]);

  // 退出模式下排队与恢复中的任务暂停（复核 S6-C12、S6-C22）：随任务状态变化重新读取，徽标如实显示
  useEffect(() => {
    api
      .kernelStatus()
      .then((k) => setExitMode(k?.control_plane?.exit_mode?.code ?? null))
      .catch(() => {});
  }, [status]);
  const allSteps = useMemo(() => buildSteps(events), [events]);
  const [showDetail, setShowDetail] = useState(false);
  const steps = showDetail ? allSteps : allSteps.filter((x) => x.level === "lawyer");
  const hiddenSteps = allSteps.length - allSteps.filter((x) => x.level === "lawyer").length;
  const toolFacts = useMemo(() => openToolsOf(events), [events]);
  const badges = currentBadges({
    status,
    scenario: run?.scenario ?? null,
    endpoint: matter?.model_endpoint ?? null,
    fullPseudonym: !!matter?.full_pseudonym || matter?.data_level === "L3a",
    inflight: egressInflight,
    ...toolFacts,
    exitMode,
  });
  const citationEvent = useMemo(() => [...events].reverse().find((e) => e.type === "citations.verified"), [events]);
  const inputDocs = useMemo(() => {
    let ids: string[] = [];
    try {
      const snap = typeof run?.input_snapshot === "string" ? JSON.parse(run.input_snapshot) : (run?.input_snapshot ?? {});
      ids = Array.isArray(snap.document_version_ids) ? snap.document_version_ids : [];
    } catch {
      ids = [];
    }
    return ids.map((id) => docs.find((d) => d.document_version_id === id) ?? { document_version_id: id, filename: id });
  }, [run, docs]);
  const loaded = useMemo(() => [...events].reverse().find((e) => e.type === "materials.loaded")?.payload, [events]);

  const reconcile = async (op: UnresolvedOperation, resolution: "applied" | "not_applied") => {
    setBusy(true);
    setErr("");
    try {
      await api.reconcileOperation(runId, op.tool_operation_id, resolution);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    setErr("");
    try {
      const cur = await api.getRun(runId);
      await api.retryRun(runId, cur.run.status_version);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 追问：在同一 Agent 会话上开新一轮（上下文连续；新一轮有自己的记录、确认与成果）。先估价、显示一行确认，再发起。 */
  const prevMode: RunMode = (run?.input_snapshot?.run_options?.mode as RunMode | undefined) ?? "default";
  const prepareFollowUp = async () => {
    const text = followText.trim();
    if (!text) return;
    setBusy(true);
    setErr("");
    try {
      const docIds = inputDocs.map((d) => d.document_version_id);
      const est = await api.estimate(matterId, { scenario: "a1.agent_task", document_version_ids: docIds, goal: text });
      const dw = est.data_where ?? { preview: "", warning: null, start_blocked: false };
      setFollowConfirm({ estimate_id: est.estimate_id, points_display: est.points_display, preview: String(dw.preview ?? ""), warning: dw.warning ?? null, blocked: !!dw.start_blocked });
      setFollowRaise(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const followUp = async () => {
    const text = followText.trim();
    if (!text || !followConfirm) return;
    setBusy(true);
    setErr("");
    try {
      // 档位沿用上一轮（内核同样强制）；问答档只有勾选“本轮允许写入草稿”才改为默认档，并留痕
      const raise = prevMode === "chat" && followRaise;
      const r = await api.startRun(matterId, {
        estimate_id: followConfirm.estimate_id,
        idempotency_key: `${runId}-followup-${Date.now()}`,
        goal: text,
        plan_first: false,
        followup_of: runId,
        ...(raise ? { mode: "default" as RunMode, mode_raise_confirmed: true } : {}),
      });
      setFollowText("");
      setFollowConfirm(null);
      nav(`/run/${r.run_id}/${matterId}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (card: ApprovalCard, d: { decision: "approve" | "reject"; scope?: "once" | "task"; variant?: "original" | "generalized"; feedback?: string }) => {
    setBusy(true);
    setErr("");
    try {
      await api.decide(runId, card, d);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const answer = async (q: QuestionCard, answers: Parameters<typeof api.answer>[2]) => {
    setBusy(true);
    setErr("");
    try {
      await api.answer(runId, q.question_id, answers, stateVersion);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (workbench) {
    return (
      <ReviewWorkbench
        matterId={matterId}
        documentVersionId={workbench.doc}
        runId={runId}
        readOnly={(matter?.lifecycle ?? "active") !== "active"}
        onClose={() => {
          setWorkbench(null);
          void refresh();
        }}
        onRedline={(id) => {
          setSelected(id);
          void refresh();
        }}
      />
    );
  }

  return (
    <div className="exec">
      <aside className="exec-left">
        <button className="btn-link back" onClick={() => nav(`/matter/${matterId}`)}>← 返回事项</button>
        <div className="pane-title">本次用到的材料</div>
        {inputDocs.length === 0 && <p className="muted">没有指定材料：会按需读取本事项的材料。</p>}
        {inputDocs.map((d) => (
          <div key={d.document_version_id} className="mat-row">
            <Icon.file />
            <span className="mat-name" title={d.filename}>{d.filename}</span>
          </div>
        ))}
        {loaded && (
          <p className="muted">已读 {loaded.loaded}/{loaded.requested} 份{loaded.failed ? `，${loaded.failed} 份无法解析（未静默跳过）` : ""}。</p>
        )}
        <div className="pane-title">在哪里处理</div>
        <p className="muted">在这台电脑上处理 · 原件不会被修改 · 结果都是草稿</p>
      </aside>

      <section className="exec-mid">
        <div className="exec-head">
          <div>
            <h1 className="page-title" title={run?.goal ?? run?.input_snapshot?.goal ?? undefined}>{runTitle(run)}</h1>
            <div className="exec-sub">
              <span className={`pill ${terminal ? (status === "succeeded" ? "pill-green" : "pill-gray") : status.startsWith("waiting") ? "pill-orange" : "pill-blue"}`}>{RUN_STATUS_LABELS[status] ?? status}</span>
              {!status.startsWith("waiting") && badges.map((b) => <span key={b.label} className={`pill pill-${b.tone}`}>{b.label}</span>)}
            </div>
          </div>
          {!terminal && run && (
            <button
              className="btn-ghost"
              onClick={async () => {
                try {
                  const cur = await api.getRun(runId);
                  await api.cancelRun(runId, cur.run.status_version);
                  await refresh();
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              取消任务
            </button>
          )}
        </div>
        {run?.input_snapshot?.followup_of && (
          <button className="btn-link followup-of" onClick={() => nav(`/run/${run.input_snapshot.followup_of}/${matterId}`)}>
            ← 接着上一轮
          </button>
        )}
        {(run?.goal ?? run?.input_snapshot?.goal) && <div className="goal-bubble">{renderTokens(String(run.goal ?? run.input_snapshot.goal), tokenMap)}</div>}
        <div className="timeline">
          {steps.map((s) => (
            <div key={s.key} className={`step step-${s.icon}${s.agent ? " step-sub" : ""}`}>
              <span className="step-dot">{s.icon === "ok" ? <Icon.check /> : s.icon === "fail" ? <Icon.x /> : null}</span>
              <div className="step-body">
                <div className="step-title">
                  {s.agent ? <span className="tag tag-sub">子任务 {s.agent}</span> : null}
                  {s.title}
                </div>
                {s.detail && <div className="step-detail">{renderTokens(s.detail, tokenMap)}</div>}
                {s.meta && <div className="step-meta">{s.meta}</div>}
              </div>
            </div>
          ))}
          {!terminal && approvals.length === 0 && questions.length === 0 && !liveText && <div className="step step-wait"><span className="step-dot" /><div className="step-body muted">正在处理…</div></div>}
          {hiddenSteps > 0 && (
            <button className="btn-link step-toggle" onClick={() => setShowDetail((v) => !v)}>
              {showDetail ? "收起处理细节" : `处理细节（${hiddenSteps} 条）`}
            </button>
          )}
        </div>
        {!terminal && liveText.trim() && (
          <div className="live-draft" aria-live="polite" aria-busy="true">
            <div className="pane-title">正在起草…</div>
            <Markdown text={liveText} tokenMap={tokenMap} />
          </div>
        )}
        {err && <div className="banner banner-red">{err}</div>}
        {(status === "reconciling" || (status === "failed" && unresolved.length > 0)) && (
          <div className="card reconcile-card">
            <div className="title">有 {unresolved.length} 个操作无法确认是否已完成</div>
            <p className="muted">
              任务中断时（例如应用意外退出）这些操作正在进行。为避免重复执行（如重复生成或覆盖文件），请您到对应位置看一眼，再逐项告诉我们结果；全部确认后即可重新运行，已完成的操作不会再做一遍。
            </p>
            {unresolved.map((op) => (
              <div key={op.tool_operation_id} className="reconcile-row">
                <span>
                  {op.operation || op.tool}
                  <span className="muted">（{fmtShortTime(op.created_at)}）</span>
                </span>
                <span className="reconcile-actions">
                  <button className="btn-ghost" disabled={busy} onClick={() => void reconcile(op, "applied")}>已完成</button>
                  <button className="btn-ghost" disabled={busy} onClick={() => void reconcile(op, "not_applied")}>未完成</button>
                </span>
              </div>
            ))}
          </div>
        )}
        {status === "failed" && unresolved.length === 0 && run && (
          <div className="card retry-card">
            <div className="title">任务未完成</div>
            {run.terminal_reason && <p className="muted">{String(run.terminal_reason)}</p>}
            <button className="btn-primary" disabled={busy} onClick={() => void retry()}>
              重新运行
            </button>
          </div>
        )}
        {risk && (risk.docs.length > 0 || risk.unlinked > 0) && (
          <div className="card risk-entry">
            <div className="title">
              本任务提出了 {risk.total} 项审查意见{risk.highOpen > 0 ? `，其中 ${risk.highOpen} 项重大风险待你处理` : ""}
            </div>
            <p className="muted">逐项接受、修改或不采纳后，可一键生成带修订痕迹和批注的 Word 修订稿（原件不改动）。已处理 {risk.decided}/{risk.total}。</p>
            <div className="card-actions">
              {risk.docs.map((d) => (
                <button key={d} className="btn-primary" onClick={() => setWorkbench({ doc: d })}>
                  打开审查工作台{risk.docs.length > 1 ? `：${docs.find((x) => x.document_version_id === d)?.filename ?? ""}` : ""}
                </button>
              ))}
              {risk.unlinked > 0 && (
                <button className="btn-ghost" onClick={() => setWorkbench({ doc: null })}>
                  未关联合同的意见（{risk.unlinked}）
                </button>
              )}
            </div>
          </div>
        )}
        <div className="interactions">
          {approvals.map((a) => (
            <ApprovalCardView key={a.approval_id} card={a} tokenMap={tokenMap} busy={busy} onDecide={(d) => void decide(a, d)} />
          ))}
          {questions.map((q) => (
            <QuestionCardView key={q.question_id} card={q} tokenMap={tokenMap} busy={busy} onAnswer={(ans) => void answer(q, ans)} />
          ))}
        </div>
        {terminal && preview && preview.text && !preview.office && (
          <div className="answer">
            <div className="pane-title">回复（草稿）</div>
            <Markdown text={preview.text} tokenMap={tokenMap} />
          </div>
        )}
        {run?.scenario === "a1.agent_task" && run?.is_mine && (matter?.lifecycle ?? "active") === "active" && (status === "succeeded" || status === "partial") && (
          <div className="followup-wrap">
            <div className="followup">
              <textarea
                rows={2}
                value={followText}
                placeholder="追问或补充要求，例如：把第 7 条的违约金按三种情形再算一遍"
                aria-label="追问或补充要求"
                onChange={(e) => {
                  setFollowText(e.target.value);
                  setFollowConfirm(null);
                }}
                onKeyDown={(e) => {
                  // 快捷键与按钮同一口径（复核 C-B13）：依据不齐等被禁用时不能用 Ctrl/⌘+Enter 绕过
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
                    if (!followConfirm) void prepareFollowUp();
                    else if (!followConfirm.blocked) void followUp();
                  }
                }}
              />
              {!followConfirm && (
                <button className="btn-primary" disabled={busy || !followText.trim()} onClick={() => void prepareFollowUp()}>
                  追问
                </button>
              )}
            </div>
            {followConfirm && (
              <div className="followup-confirm" role="group" aria-label="追问前确认">
                <div>
                  沿用上一轮：<b>{MODE_LABELS[prevMode]}</b> · 再次使用 {inputDocs.length} 份材料 · {followConfirm.points_display}
                </div>
                <div className="muted">{followConfirm.preview}</div>
                {followConfirm.warning && <div className="banner banner-orange">{followConfirm.warning}</div>}
                {prevMode === "chat" && (
                  <label className="lifecycle-check">
                    <input type="checkbox" aria-label="本轮允许写入草稿" checked={followRaise} onChange={(e) => setFollowRaise(e.target.checked)} />
                    本轮允许写入草稿（风险卡、事实、文书草稿），改为“默认”档（留痕）
                  </label>
                )}
                <div className="modal-actions">
                  <button className="btn-ghost" disabled={busy} onClick={() => setFollowConfirm(null)}>取消</button>
                  <button className="btn-primary" disabled={busy || followConfirm.blocked} onClick={() => void followUp()}>确认追问</button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <aside className="exec-right">
        <div className="tabs">
          {(
            [
              ["artifact", "成果"],
              ["history", "文件历史"],
              ["egress", "数据去向"],
              ["citations", `引用${Number(citationEvent?.payload?.intercepted ?? 0) > 0 ? `（拦截 ${citationEvent!.payload.intercepted}）` : ""}`],
              ["record", "记录"],
            ] as [RightTab, string][]
          ).map(([k, l]) => (
            <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="tab-body">
          {tab === "artifact" && (
            <>
              {artifacts.length === 0 && <p className="muted">尚无成果。</p>}
              {artifacts.length > 0 && (
                <select className="artifact-select" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
                  {artifacts.map((a) => <option key={a.artifact_version_id} value={a.artifact_version_id}>{artifactName(a)} · v{a.version}</option>)}
                </select>
              )}
              {selected && preview && <SafePreview filename={preview.filename} text={preview.text} tokenMap={tokenMap} office={preview.office} />}
              {selected && <ArtifactActions artifact={artifacts.find((a) => a.artifact_version_id === selected)} onError={setErr} />}
            </>
          )}
          {tab === "history" && (
            <>
              {artifacts.length === 0 && <p className="muted">尚无文件。</p>}
              {artifacts.map((a) => (
                <div key={a.artifact_version_id} className="hist-row">
                  <div><b>{a.filename}</b> <span className="tag tag-gray">v{a.version}</span> <span className="tag tag-gray">{a.status}</span></div>
                  <div className="muted mono">{String(a.sha256 ?? "").slice(0, 16)}… · {fmtTime(a.created_at)}</div>
                </div>
              ))}
            </>
          )}
          {tab === "egress" && <DataFlowCard runId={runId} tokenMap={tokenMap} refreshKey={events.length} />}
          {tab === "citations" && <Citations ev={citationEvent} />}
          {tab === "record" && run && (
            <table className="data">
              <tbody>
                <tr><th>任务</th><td className="mono">{run.run_id}</td></tr>
                <tr><th>状态</th><td>{RUN_STATUS_LABELS[run.status] ?? run.status}</td></tr>
                <tr><th>点数</th><td>预留 {run.points_reserved} / 已扣 {run.points_charged}</td></tr>
                <tr><th>发起</th><td>{fmtTime(run.created_at)}</td></tr>
                {run.reason && <tr><th>原因</th><td>{reasonLabel(String(run.reason))}</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </aside>
    </div>
  );
}

function ArtifactActions({ artifact, onError }: { artifact: any; onError: (m: string) => void }) {
  if (!artifact) return null;
  return (
    <div className="artifact-actions">
      <button
        className="btn-ghost"
        onClick={() =>
          void api
            .downloadArtifact(artifact.artifact_version_id, artifact.filename)
            .then(() => api.deliver({ artifact_version_id: artifact.artifact_version_id, action: "download" }))
            .catch((e) => onError(e.message))
        }
      >
        下载（留痕）
      </button>
      {artifact.status === "draft" && (
        <button
          className="btn-primary"
          onClick={async () => {
            try {
              await api.submitReview(artifact.artifact_version_id);
              nav(`/review/${artifact.artifact_version_id}`);
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          提交复核
        </button>
      )}
      {artifact.status === "pending_review" && <button className="btn-primary" onClick={() => nav(`/review/${artifact.artifact_version_id}`)}>去复核 / 签发</button>}
    </div>
  );
}

function Citations({ ev }: { ev: RunEvent | undefined }) {
  const verdicts: any[] = ev?.payload?.verdicts ?? [];
  const intercepted: any[] = ev?.payload?.intercepted_items ?? [];
  if (!ev) return <p className="muted">本任务没有引用核验结果。</p>;
  return (
    <>
      {intercepted.length > 0 && <div className="banner banner-red">本次拦截 {intercepted.length} 条无法核实的引用（不静默删除，复核确认前不得作为依据）。</div>}
      {verdicts.map((v, i) => (
        <div className="verdict" key={i}>
          <div>
            <span className="raw">{v.raw}</span> <span className={`cite-state cite-${v.state}`}>{CITE_STATE_LABELS[v.state] ?? v.state}</span>
          </div>
          <div className="row">{v.matched_law_name ?? "未匹配法源"}{v.effectiveness ? `〔${EFFECTIVENESS_LABELS[v.effectiveness] ?? v.effectiveness}〕` : ""}</div>
          {v.reasons?.map((r: string, j: number) => <div className="row" key={j}>{r}</div>)}
          {v.suggestion && <div className="row suggestion">建议：{v.suggestion}</div>}
        </div>
      ))}
    </>
  );
}
