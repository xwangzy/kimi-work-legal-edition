/**
 * 任务执行态（第 03 篇 §4.3 三栏：左 材料与覆盖；中 计划、进度、澄清、确认卡、子任务；右 成果预览与文件历史；§8.3 执行域徽标；§8.4 数据去向卡）。
 * 事件先落本机事项账本，本页按游标续读；离开本页不会取消任务。确认卡独立于聊天文本（模型文本里的“已批准”不触发权限）。
 */
import { downloadPlan } from "../lib/download.ts";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, onKernelEvent, type ApprovalCard, type QuestionCard, type RunEvent, type RunMode, type RunProgress, type SendSummaryView, type UnresolvedOperation } from "../api.ts";
import { SendSummary } from "../components/SendSummary.tsx";
import { nav } from "../App.tsx";
import { ApprovalCardView, QuestionCardView } from "../components/Cards.tsx";
import { DataFlowCard, reasonLabel } from "../components/DataFlow.tsx";
import { Icon } from "../components/Icons.tsx";
import { Markdown, tokens as renderTokens } from "../components/Markdown.tsx";
import { SafePreview } from "../components/SafePreview.tsx";
import { ReviewWorkbench } from "../components/ReviewWorkbench.tsx";
import { ARTIFACT_STATUS_LABELS, artifactName, CITE_STATE_LABELS, EFFECTIVENESS_LABELS, fmtShortTime, fmtTime, jurisdictionLabel, MODE_LABELS, RUN_STATUS_LABELS, SCENARIO_LABELS, stanceLabel, stepTime, stripMarkdownInline, TERMINAL_STATUSES } from "../lib/labels.ts";
import { cutKeepingTokens, forgetRestored, restoredPlain, restoreTokens } from "../lib/tokens.ts";
import { nextScenarios, scenarioOfRun, type BusinessLine } from "../lib/scenarios.ts";
import { currentBadges } from "../lib/badges.ts";
import { engineHeartbeatMs, hasProgress, mergeProgress, phaseLine, progressActivityKey, progressTexts, retryStoppable, silenceMs, stallThresholdMs, progressView, type ProgressViewModel } from "../lib/progress.ts";
import { buildSteps, groupSubtaskSteps, keyStepKeys, mergeRepeatSteps, sentByToolCall, toolLabel, type SentInfo, type Step } from "../lib/timeline.ts";
import { busyRunOfError } from "../lib/start-block.ts";
import { methodLine, methodShort } from "../lib/run-method.ts";
import { Select } from "../components/Select.tsx";
import { rightCollapsed, rightTabs, type RightTab } from "../lib/run-pane.ts";
import { previewCites, previewFactMarks, type ArtifactCitations, type FactMarkView } from "../lib/citation-review.ts";
import { CitationClaims } from "../components/CitationClaims.tsx";
import { Breadcrumb } from "../components/Breadcrumb.tsx";
import { OutlineConfirm } from "../components/OutlineConfirm.tsx";
import { confirmAndAnswer, outlineAnswer, outlineQuestion, type OutlineView } from "../lib/outline.ts";

/** 页面标题：任务目标前 24 字（律师能区分多个任务）；没有目标时用场景名。 */
function runTitle(run: any): string {
  const goal = String(run?.goal ?? run?.input_snapshot?.goal ?? "").replace(/\s+/g, " ").trim();
  // 任务名太长时只显示目标的前 30 个字，悬停看全文（Z3 #21、V-g）；标题允许完整折行
  if (goal) return goal.length > 30 ? `${goal.slice(0, 30)}…` : goal;
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


/** 正文前三行（去掉 Markdown 标题、列表、表格与行内记号），用于中栏摘要（UIUX 增量评审 D-1；v9.4 走查：摘要里露出“**须核验**”）。 */
function summaryLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*[-:| ]{3,}\s*$/.test(l))
    .map((l) => stripMarkdownInline(l.replace(/^\s*(#+\s*|[-*+]\s+|>\s*)/, "")).trim())
    .filter((l) => l.length > 0)
    .slice(0, 3)
    .map((l) => cutKeepingTokens(l, 80));
}

/** 律师在首页选的业务线（只读本机偏好；读不到返回 null）。 */
function homeLine(): BusinessLine | null {
  try {
    const v = window.localStorage.getItem("kwl.home.line");
    return v === "litigation" || v === "transactional" || v === "inhouse" ? v : null;
  } catch {
    return null;
  }
}

/** 下载按钮按文件类型说清下载的是什么（D-2）；Markdown 成果下载成 Word（B-4）。 */
function downloadLabel(filename: string): string {
  return downloadPlan(filename).label;
}

export function RunView({ runId, matterId }: { runId: string; matterId: string }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState("queued");
  const [run, setRun] = useState<any>(null);
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [docs, setDocs] = useState<any[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedOperation[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [questions, setQuestions] = useState<QuestionCard[]>([]);
  // 起草前的论点与依据（C-04）：本任务待确认的提纲
  const [outline, setOutline] = useState<OutlineView | null>(null);
  const [stateVersion, setStateVersion] = useState<number | null>(null);
  const [egressInflight, setEgressInflight] = useState<{ model: number; search: number; fetch: number } | null>(null);
  const [matter, setMatter] = useState<any>(null);
  const [tab, setTab] = useState<RightTab>("artifact");
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ filename: string; text: string; office?: boolean } | null>(null);
  // 本任务提交的风险卡（按合同分组）；打开审查工作台时整页切换
  const [risk, setRisk] = useState<{ total: number; highOpen: number; decided: number; docs: string[]; unlinked: number; bySeverity: { high: number; mid: number; low: number }; top: { severity: string; issue: string }[] } | null>(null);
  // 中栏“审查意见”入口带主按钮时，同屏其余动作都降为次按钮（每屏最多一个主按钮，Y4 V-5）
  const hasRiskEntry = !!risk && risk.docs.length > 0;
  // 本任务最新的 Word 修订稿（审查意见全部处理完后，首屏主按钮下载它；Z3 评审 #3）
  const revision = useMemo(() => [...artifacts].filter((a) => a.kind === "revision_draft").sort((a, b) => Number(b.version) - Number(a.version))[0] ?? null, [artifacts]);
  // 成果是否已取过一次（D-5：区分“加载中”与“确实没有”）
  const [artifactsLoaded, setArtifactsLoaded] = useState(false);
  // 律师是否自己点过右栏标签（有风险卡时缺省显示审查摘要，D-3；点过之后不再自动切换）
  const tabTouched = useRef(false);
  /** 律师手动展开过收起的右栏（Z3 #11）。 */
  const [paneOpened, setPaneOpened] = useState(false);
  // 窄屏材料弹出层（N-1）
  const [matsOpen, setMatsOpen] = useState(false);
  /** 打开的审查工作台：doc 为 null 表示“未关联合同的意见”。 */
  const [workbench, setWorkbench] = useState<{ doc: string | null } | null>(null);
  // 正在生成的回复（流式；运行中每秒随待决卡片一起取）
  const [liveText, setLiveText] = useState<string>("");
  // 过程快照（K7-P：工作清单、子任务、后台任务、上下文整理、模型重试）
  const [progress, setProgress] = useState<RunProgress | null>(null);
  // 引擎心跳单独保存（复核 S6B-01：过程快照内容不变时保留旧对象，心跳不能跟着被丢掉）
  const [heartbeat, setHeartbeat] = useState(0);
  // 方法模板名 → 中文名（时间线“已按方法模板《…》执行”）
  const [skillTitles, setSkillTitles] = useState<Record<string, string>>({});
  // 方法模板版本（Z3 评审 D-7 / §8.2 #26：数据去向底部写“方法：审合同 v1.1.0”）
  const [skillVersions, setSkillVersions] = useState<Record<string, string>>({});
  useEffect(() => {
    api
      .listSkills()
      .then((r: any) => {
        const list = (r?.skills ?? []) as any[];
        setSkillTitles(Object.fromEntries(list.map((k) => [String(k.id), String(k.title ?? k.id)])));
        setSkillVersions(Object.fromEntries(list.map((k) => [String(k.id), String(k.version ?? "")])));
      })
      .catch(() => {});
  }, []);
  const [followText, setFollowText] = useState("");
  /** 追问前的一行确认（复核 B3-B10）：沿用的档位、估价与内容去向；问答档要写入草稿须明确勾选（复核 B3-B09）。 */
  const [followConfirm, setFollowConfirm] = useState<{ estimate_id: string; points_display: string; preview: string; warning: string | null; blocked: boolean; busyRunId: string | null; sendSummary?: SendSummaryView; mustReview: boolean } | null>(null);
  const [followRaise, setFollowRaise] = useState(false);
  const [tokenMap, setTokenMap] = useState<Map<string, string | null>>(new Map());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [exitMode, setExitMode] = useState<string | null>(null);
  const cursor = useRef(0);
  const inflight = useRef(false);
  const terminal = TERMINAL_STATUSES.includes(status);
  const downloadOne = (a: any) =>
    void api
      .downloadArtifact(a.artifact_version_id, a.filename)
      .then((saved) => (saved ? api.deliver({ artifact_version_id: a.artifact_version_id, action: "download" }) : undefined))
      .catch((e) => setErr(e.message));
  const submitOne = async (a: any) => {
    try {
      await api.submitReview(a.artifact_version_id);
      nav(`/review/${a.artifact_version_id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

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
      setArtifactsLoaded(true);
      setEgressInflight(g.inflight ?? null);
      setUnresolved(g.unresolved_operations ?? []);
      const rc = await api.riskCards(matterId, { run_id: runId }).catch(() => null);
      if (rc && rc.cards.length > 0) {
        const docsOf = [...new Set(rc.cards.map((c) => c.document_version_id).filter((x): x is string => !!x))];
        const rank: Record<string, number> = { high: 0, mid: 1, low: 2 };
        const top = [...rc.cards].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || a.seq - b.seq).slice(0, 3).map((c) => ({ severity: c.severity, issue: c.issue }));
        const count = (sev: string) => rc.cards.filter((c) => c.severity === sev).length;
        setRisk({ total: rc.progress.total, highOpen: rc.progress.high_open, decided: rc.progress.decided, docs: docsOf, unlinked: rc.cards.filter((c) => !c.document_version_id).length, bySeverity: { high: count("high"), mid: count("mid"), low: count("low") }, top });
        if (!tabTouched.current) setTab("review");
      } else setRisk(null);
      if (!TERMINAL_STATUSES.includes(r.run_status)) {
        const i = await api.interactions(runId).catch(() => ({ approvals: [], questions: [], state_version: null, live_text: null, progress: null }));
        setApprovals(i.approvals);
        setQuestions(i.questions);
        const ol = await api.outlines(matterId, runId).catch(() => null);
        setOutline(ol?.outlines.find((o) => o.status === "proposed") ?? null);
        setStateVersion(i.state_version ?? null);
        setLiveText(i.live_text ?? "");
        // 内容不变时保留原对象（复核 B4-B20：每秒轮询都会反序列化出新对象，引用变化让静默看门狗永远被重置）
        const next = i.progress ?? null;
        setProgress((prev) => mergeProgress(prev, next).progress);
        setHeartbeat(engineHeartbeatMs(next));
      } else {
        setApprovals([]);
        setQuestions([]);
        setOutline(null);
        setLiveText("");
        setProgress(null);
        setHeartbeat(0);
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

  // 代号只在界面还原（标题、计划、提问、预览；事实角标的悬停文字）
  const [factText, setFactText] = useState("");
  const texts = useMemo(
    () => [preview?.text ?? "", factText, liveText, ...progressTexts(progress), ...approvals.flatMap((a) => [a.title, a.preview.plan ?? "", a.preview.detail ?? ""]), ...questions.flatMap((q) => q.questions.flatMap((x) => [x.question, ...x.options.map((o) => o.label)])), ...events.map((e) => String(e.payload?.description ?? "")), ...artifacts.map((a) => String(a.title ?? "")), ...(risk?.top.map((t) => t.issue) ?? []), ...(outline?.items.flatMap((x) => [x.claim, x.counter ?? "", ...x.basis.map((b) => b.note ?? ""), ...x.facts.map((f) => f.statement)]) ?? [])].join("\n"),
    [preview, factText, liveText, progress, approvals, questions, events, artifacts, risk, outline],
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
  // 论断—依据（v9.4 第 20 批 C-03）：选中成果的逐处引用；预览加角标、右栏“引用”列对照
  const [claims, setClaims] = useState<{ id: string; c: ArtifactCitations | null; facts?: FactMarkView[] } | null>(null);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    api
      .artifactCitations(selected)
      .then((r) => live && setClaims({ id: selected, c: r.citations, ...(r.facts ? { facts: r.facts } : {}) }))
      .catch(() => live && setClaims({ id: selected, c: null }));
    return () => {
      live = false;
    };
  }, [selected]);
  const selClaims = claims && claims.id === selected ? claims.c : null;
  // 事实角标（v9.4 第 21 批，C1 §4.3）与引用角标一起加在预览里
  const selFacts = claims && claims.id === selected ? claims.facts : undefined;
  useEffect(() => setFactText((selFacts ?? []).flatMap((m) => m.facts.flatMap((f) => [f.statement, f.quote ?? ""])).join("\n")), [selFacts]);
  const previewMarks = useMemo(() => {
    const marks = [...(selClaims?.checked ? previewCites(selClaims.items ?? [], (t) => restoredPlain(t, tokenMap)) : []), ...previewFactMarks(selFacts, (t) => restoredPlain(t, tokenMap))];
    return marks.length > 0 ? marks : undefined;
  }, [selClaims, selFacts, tokenMap]);

  // 退出模式下排队与恢复中的任务暂停（复核 S6-C12、S6-C22）：随任务状态变化重新读取，徽标如实显示
  useEffect(() => {
    api
      .kernelStatus()
      .then((k) => setExitMode(k?.control_plane?.exit_mode?.code ?? null))
      .catch(() => {});
  }, [status]);
  // 联网步骤实际发出的内容（v9.2 Y4 P0-A）：联网工具每有一步结束，从本机去向记录重新取一次
  const [sent, setSent] = useState<Map<string, SentInfo>>(new Map());
  const networkDone = useMemo(() => {
    const ids = new Set(events.filter((e) => e.type === "agent.tool_started" && /^(WebSearch|FetchURL)$/.test(String(e.payload?.tool ?? ""))).map((e) => String(e.payload?.tool_call_id)));
    return ids.size + events.filter((e) => e.type === "agent.tool_result" && ids.has(String(e.payload?.tool_call_id))).length;
  }, [events]);
  useEffect(() => {
    if (networkDone === 0) return;
    api
      .egressRecords({ runId })
      .then((r) => setSent(sentByToolCall(r.records)))
      .catch(() => {});
  }, [networkDone, runId]);
  const allSteps = useMemo(() => mergeRepeatSteps(buildSteps(events, skillTitles, sent), risk?.total), [events, skillTitles, sent, risk?.total]);
  // 律师层只在关键步骤显示时刻（Y4 R-12，复核 S7B-06）
  const keySteps = useMemo(() => keyStepKeys(allSteps), [allSteps]);
  const pv = useMemo(() => progressView(progress), [progress]);
  // 进展通知在任务结束后仍可回看（复核 S5B-02）：只保留在本页内存，内核终态后不再返回过程快照
  const [lastNotes, setLastNotes] = useState<{ text: string; source: string }[]>([]);
  useEffect(() => {
    if (pv.notes.length > 0) setLastNotes(pv.notes);
  }, [pv.notes]);
  // 静默看门狗（UIUX 增量评审 P0-D）：运行中 90 秒没有任何新进展（时间线、正在起草的文字、过程信息、待你确认）时如实提示。
  // 过程信息按内容取键（复核 B4-B20：按对象引用时每秒轮询都算“有进展”，有过程快照的任务永远不会提示）
  const [lastActivity, setLastActivity] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const progressKey = useMemo(() => progressActivityKey(progress), [progress]);
  useEffect(() => setLastActivity(Date.now()), [events.length, liveText, progressKey, approvals.length, questions.length]);
  useEffect(() => {
    // 终态后也慢速刷新：步骤的相对时间（“2 分钟前”）要随时间更新
    const t = setInterval(() => setNow(Date.now()), terminal ? 30_000 : 5000);
    return () => clearInterval(t);
  }, [terminal]);
  // 引擎心跳（宿主转来）也算“还活着”：长时间思考或执行工具时不误报“没有新进展”
  const silentFor = !terminal && approvals.length === 0 && questions.length === 0 ? silenceMs(now, lastActivity, heartbeat) : 0;
  // 提纲卡在时，Agent 为它提的那道确认题并进提纲卡（不让律师答两遍）
  const outlineQ = useMemo(() => (outline ? outlineQuestion(questions) : null), [outline, questions]);
  const pendingCards = useMemo(
    () => [...approvals.map((card) => ({ kind: "approval" as const, card })), ...questions.filter((q) => q.question_id !== outlineQ?.question_id).map((card) => ({ kind: "question" as const, card }))],
    [approvals, questions, outlineQ],
  );
  const [showAllCards, setShowAllCards] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const unreviewed = artifacts.filter((a) => a.status === "draft" || a.status === "pending_review").length;
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
  const paneCollapsed = rightCollapsed({ artifactsLoaded, artifactCount: artifacts.length, hasRisk: !!risk, hasCitations: !!citationEvent, userExpanded: paneOpened });
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

  /** 重新运行被拒：同一事项另有进行中的任务（复核 B4-B12：409 带那个任务的编号）。 */
  const [retryBusyRun, setRetryBusyRun] = useState<string | null>(null);
  const retry = async () => {
    setBusy(true);
    setErr("");
    setRetryBusyRun(null);
    try {
      const cur = await api.getRun(runId);
      await api.retryRun(runId, cur.run.status_version);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
      setRetryBusyRun(busyRunOfError(e));
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
      // 事项里另有进行中的任务（复核 B4-B13）：与开始面板同样给出“查看进行中的任务”
      const busyRunId = dw.block_kind === "busy" && typeof dw.busy_run_id === "string" ? dw.busy_run_id : null;
      setFollowConfirm({ estimate_id: est.estimate_id, points_display: est.points_display, preview: String(dw.preview ?? ""), warning: dw.warning ?? null, blocked: !!dw.start_blocked, busyRunId, ...(dw.send_summary ? { sendSummary: dw.send_summary } : {}), mustReview: dw.block_kind === "suspects" });
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
      // 估价时不忙、发起时 409（并发发起）：同样给出入口
      const other = busyRunOfError(e);
      if (other) setFollowConfirm((c) => (c ? { ...c, blocked: true, busyRunId: other } : c));
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

  // 确认提纲：先记下律师的逐条决定，再替律师答 Agent 的确认题（选“已确认”）；没有确认题时 Agent 下次读取 outline.get 即得确认版
  const confirmOutline = async (decisions: Parameters<typeof api.decideOutline>[2], note: string) => {
    if (!outline) return;
    setBusy(true);
    setErr("");
    try {
      await confirmAndAnswer({
        decide: () => api.decideOutline(matterId, outline.outline_id, decisions, note),
        answer: outlineQ ? () => api.answer(runId, outlineQ.question_id, outlineAnswer(outlineQ, true), stateVersion) : null,
      });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stopOutline = async () => {
    if (!outlineQ) return;
    setBusy(true);
    setErr("");
    try {
      await api.answer(runId, outlineQ.question_id, outlineAnswer(outlineQ, false), stateVersion);
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
        agreement={{ stance: matter?.stance ? stanceLabel(matter.stance) : null, method: methodShort(run, skillTitles, skillVersions), jurisdiction: matter?.jurisdiction ? jurisdictionLabel(matter.jurisdiction) : null }}
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
    <div className={`exec${paneCollapsed ? " exec-pane-collapsed" : ""}`}>
      {/* 两栏（v9.4 第 20 批，U1 §3.2 页面模板“工作台”）：过程在左、成果在右；材料收成标题下的“材料 n 份 ▾” */}

      <section className="exec-mid">
        <Breadcrumb items={[{ label: "事项", href: "/matters" }, { label: matter?.title ?? "事项", href: `/matter/${matterId}` }, { label: "任务" }]} />
        <div className="exec-head">
          <div>
            <h1 className="page-title" title={run?.goal ?? run?.input_snapshot?.goal ?? undefined}>{runTitle(run)}</h1>
            <div className="exec-sub">
              {/* 完成但草稿还没复核时，胶囊写下一步（v9.4 U1 §1.4：原来一律“已完成”，下面却是 6 份待复核） */}
              {status === "succeeded" && unreviewed > 0 ? (
                <span className="pill pill-orange" title="任务已完成；成果都是草稿，等你复核">{unreviewed} 份待复核</span>
              ) : (
                <span className={`pill ${terminal ? (status === "succeeded" ? "pill-green" : "pill-gray") : status.startsWith("waiting") ? "pill-orange" : "pill-blue"}`}>{RUN_STATUS_LABELS[status] ?? status}</span>
              )}
              {!status.startsWith("waiting") && badges.map((b) => <span key={b.label} className={`pill pill-${b.tone}`} title={b.title}>{b.label}</span>)}
              {/* 原左栏“在哪里处理”每个任务都一样，收成一枚胶囊（Z3 #29） */}
              <span className="pill pill-gray" title="原件不会被修改；结果都是草稿，须律师复核">原件不改 · 结果是草稿</span>
              {/* 材料入口（UIUX 增量评审 N-1；第 20 批起各种宽度都用两栏，不再有左栏） */}
              <span className="mats-chip-wrap">
                <button className="pill pill-gray" aria-expanded={matsOpen} onClick={() => setMatsOpen((v) => !v)}>
                  材料 {inputDocs.length} 份 ▾
                </button>
                {matsOpen && (
                  <div className="mats-pop" role="dialog" aria-label="本次用到的材料">
                    {inputDocs.length === 0 && <div className="muted">没有指定材料：会按需读取本事项的材料。</div>}
                    {inputDocs.map((d) => (
                      <div key={d.document_version_id} className="mat-row">
                        <Icon.file />
                        <span className="mat-name" title={d.filename}>{d.filename}</span>
                      </div>
                    ))}
                    {loaded && <div className="muted">已读 {loaded.loaded}/{loaded.requested} 份{loaded.failed ? `，${loaded.failed} 份读不了（已列出，可换成 Word 或 PDF）` : ""}。</div>}
                    <div className="muted">在这台电脑上处理 · 原件不会被修改 · 结果都是草稿</div>
                  </div>
                )}
              </span>
            </div>
          </div>
          {!terminal && run && (
            // 误点可撤回（UIUX 增量评审 R-10）；危险操作红字描边、原位二次确认（Y4 V-5，复核 S7B-04）
            <ConfirmButton
              label="取消任务"
              question="停止这个任务？停止后可以重新运行。"
              confirmLabel="停止任务"
              keepLabel="继续运行"
              onConfirm={async () => {
                try {
                  const cur = await api.getRun(runId);
                  await api.cancelRun(runId, cur.run.status_version);
                  await refresh();
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            />
          )}
        </div>
        {run?.input_snapshot?.followup_of && (
          <button className="btn-link followup-of" onClick={() => nav(`/run/${run.input_snapshot.followup_of}/${matterId}`)}>
            ← 接着上一轮
          </button>
        )}
        {/* 标题已是律师原话时不再用气泡重复一遍（v9.4 U1 §1.4）；原话超过 30 字被截断时才显示全文 */}
        {(run?.goal ?? run?.input_snapshot?.goal) && String(run.goal ?? run.input_snapshot.goal).replace(/\s+/g, " ").trim().length > 30 && <div className="goal-bubble">{renderTokens(String(run.goal ?? run.input_snapshot.goal), tokenMap)}</div>}
        <div className="timeline">
          {groupSubtaskSteps(steps).map((it) =>
            it.kind === "step" ? (
              <StepRow key={it.step.key} s={it.step} now={now} tokenMap={tokenMap} label={it.label} showTime={it.step.level === "detail" || keySteps.has(it.step.key)} />
            ) : (
              // 子任务折叠（Y4 #33，复核 S7B-05）：同一子任务的步骤只显示一行，展开看逐步
              <details key={it.key} className={`step step-${it.failed ? "fail" : it.done ? "ok" : "wait"} step-sub step-group`}>
                <summary>
                  <span className="step-dot">{it.failed ? <Icon.x /> : it.done ? <Icon.check /> : null}</span>
                  <span className="step-body">
                    <span className="step-title">
                      <span className="tag tag-sub">{it.label}</span>
                      {it.failed ? "有一步没有完成" : it.done ? "已完成" : `进行中：${it.steps.at(-1)!.title}`}
                      <span className="muted"> · 共 {it.steps.length} 步 · 展开</span>
                    </span>
                  </span>
                </summary>
                {it.steps.map((s) => (
                  <StepRow key={s.key} s={s} now={now} tokenMap={tokenMap} showTime={s.level === "detail" || keySteps.has(s.key)} />
                ))}
              </details>
            ),
          )}
          {!terminal && approvals.length === 0 && questions.length === 0 && !liveText && (
            <div className={`step step-wait${pv.retry ? " step-retry" : ""}`}>
              <span className="step-dot" />
              <div className="step-body muted">
                {pv.retry ?? (silentFor > stallThresholdMs(progress) ? "已经有一阵子没有新进展了。任务仍在运行；如果长时间没有变化，可以取消后重新运行。" : phaseLine(progress, now, toolLabel) ?? "正在处理…")}
                {retryStoppable(pv) && run && (
                  <div className="banner-actions">
                    <ConfirmButton
                      label="停止，稍后再试"
                      question="先停止这个任务？已完成的部分不会丢，稍后可以重新运行。"
                      confirmLabel="停止"
                      keepLabel="继续等"
                      onConfirm={async () => {
                        try {
                          const cur = await api.getRun(runId);
                          await api.cancelRun(runId, cur.run.status_version);
                          await refresh();
                        } catch (e) {
                          setErr((e as Error).message);
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
          {hiddenSteps > 0 && (
            <button className="btn-link step-toggle" onClick={() => setShowDetail((v) => !v)}>
              {showDetail ? "收起处理细节" : `处理细节（${hiddenSteps} 条）`}
            </button>
          )}
        </div>
        {!terminal && hasProgress(pv) && <ProgressPanel vm={pv} tokenMap={tokenMap} />}
        {terminal && lastNotes.length > 0 && (
          <details className="progress-panel">
            <summary className="muted">助手在过程中的进展说明（{lastNotes.length} 条）</summary>
            {lastNotes.map((n, i) => (
              <div key={i} className="progress-note">
                <div className="muted">{n.source}</div>
                <Markdown text={n.text} tokenMap={tokenMap} />
              </div>
            ))}
          </details>
        )}
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
            <div className="card-actions">
              <button className="btn-primary" disabled={busy} onClick={() => void retry()}>
                重新运行
              </button>
              {retryBusyRun && (
                <button className="btn-ghost" onClick={() => nav(`/run/${retryBusyRun}/${matterId}`)}>
                  查看进行中的任务
                </button>
              )}
            </div>
          </div>
        )}
        {risk && (risk.docs.length > 0 || risk.unlinked > 0) && (
          <div className="card risk-entry">
            <div className="title">
              本任务提出了 {risk.total} 项审查意见{risk.highOpen > 0 ? `，其中 ${risk.highOpen} 项重大风险待你处理` : ""}
            </div>
            <p className="muted">
              {risk.decided >= risk.total
                ? revision
                  ? `${risk.total} 项意见都已处理，修订稿已生成，可以下载或提交复核。`
                  : `${risk.total} 项意见都已处理：在审查工作台生成带修订痕迹的 Word 修订稿（原件不改动）。`
                : `逐项接受、修改或不采纳后，可一键生成带修订痕迹和批注的 Word 修订稿（原件不改动）。已处理 ${risk.decided}/${risk.total}。`}
            </p>
            {/* 全部处理完且已有修订稿：首屏主按钮换成“下载修订稿（Word）”，次按钮“提交复核”（Z3 评审 #3） */}
            {risk.decided >= risk.total && revision && (
              <div className="card-actions">
                <button className="btn-primary" onClick={() => downloadOne(revision)}>下载修订稿（Word）</button>
                {revision.status === "draft" && (
                  <button className="btn-ghost" onClick={() => void submitOne(revision)}>提交复核</button>
                )}
                {revision.status === "pending_review" && (
                  <button className="btn-ghost" onClick={() => nav(`/review/${revision.artifact_version_id}`)}>去复核 / 签发</button>
                )}
              </div>
            )}
            <div className="card-actions">
              {risk.docs.map((d, i) => (
                // 每屏最多一个黑色主按钮（Y4 V-5）：多份文书时只有第一份用主按钮
                <button key={d} className={i === 0 && !(risk.decided >= risk.total && revision) ? "btn-primary" : "btn-ghost"} onClick={() => setWorkbench({ doc: d })}>
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
        {outline && !terminal && (
          <OutlineConfirm
            key={outline.outline_id}
            outline={outline}
            plain={(t) => (t ? restoredPlain(t, tokenMap) : "")}
            busy={busy}
            canStop={!!outlineQ}
            onConfirm={(d, n) => void confirmOutline(d, n)}
            onStop={() => void stopOutline()}
          />
        )}
        <div className="interactions">
          {/* 同一时间只展开一张（UIUX 增量评审 P0-F）：先到的先处理，其余折叠为“还有 N 项待确认”，可展开 */}
          {pendingCards.slice(0, showAllCards ? pendingCards.length : 1).map((c) =>
            c.kind === "approval" ? (
              <ApprovalCardView key={c.card.approval_id} card={c.card} tokenMap={tokenMap} busy={busy} onDecide={(d) => void decide(c.card, d)} />
            ) : (
              <QuestionCardView key={c.card.question_id} card={c.card} tokenMap={tokenMap} busy={busy} onAnswer={(ans) => void answer(c.card, ans)} />
            ),
          )}
          {pendingCards.length > 1 && (
            <button className="btn-link interactions-more" onClick={() => setShowAllCards((v) => !v)}>
              {showAllCards ? "只显示第一项" : `还有 ${pendingCards.length - 1} 项待确认`}
            </button>
          )}
        </div>
        {/* 有交付件时中栏只放摘要，全文在右栏（UIUX 增量评审 D-1：同一份内容不读两遍） */}
        {terminal && preview && preview.text && !preview.office && String(artifacts.find((a) => a.artifact_version_id === selected)?.kind ?? "").startsWith("a1_agent_draft") && (
          <div className="answer answer-summary">
            <div className="pane-title">回复（草稿）· 摘要</div>
            {summaryLines(preview.text).map((l, i) => (
              <p key={i}>{renderTokens(l, tokenMap)}</p>
            ))}
            <button
              className="btn-link"
              onClick={() => {
                tabTouched.current = true;
                setTab("artifact");
              }}
            >
              在右侧查看全文 →
            </button>
          </div>
        )}
        {/* 首屏下载入口（Z3 评审 #3）：没有审查意见的任务，完成后在中栏直接列出成果，不必先切右栏 */}
        {terminal && !hasRiskEntry && (status === "succeeded" || status === "partial") && artifacts.length > 0 && (
          <div className="card done-files">
            <div className="title">本任务生成了 {artifacts.length} 份文件（草稿）</div>
            <ul className="done-file-list">
              {/* 份数与列出的行数一致（v9.4 U1 #8）：多于 6 份时先列 6 份，其余点“全部”展开 */}
              {(showAllFiles ? artifacts : artifacts.slice(0, 6)).map((a) => (
                <li key={a.artifact_version_id}>
                  <button
                    className="btn-link"
                    onClick={() => {
                      tabTouched.current = true;
                      setSelected(a.artifact_version_id);
                      setTab("artifact");
                    }}
                  >
                    {artifactName(a, (t) => restoredPlain(t, tokenMap))}
                  </button>
                  <span className="spacer" />
                  <button className="btn-ghost btn-sm" onClick={() => downloadOne(a)}>
                    {downloadLabel(String(a.filename ?? ""))}
                  </button>
                </li>
              ))}
            </ul>
            {artifacts.length > 6 && !showAllFiles && (
              <button className="btn-link" onClick={() => setShowAllFiles(true)}>
                全部 {artifacts.length} 份 →
              </button>
            )}
          </div>
        )}
        {/* 接着做（D-4）：同一事项下打开下一场景的开始面板 */}
        {(status === "succeeded" || status === "partial") && (matter?.lifecycle ?? "active") === "active" && nextScenarios(scenarioOfRun(run, homeLine())).length > 0 && (
          <div className="next-steps">
            <span className="muted">接着做：</span>
            {nextScenarios(scenarioOfRun(run, homeLine())).map((c) => (
              <button key={c.id} className="pill pill-link" onClick={() => nav(`/start/${c.id}/${matterId}`)}>
                {c.title} →
              </button>
            ))}
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
                // 每屏最多一个主按钮（Y4 V-5，复核 S7B-01）：有待处理的审查意见时主按钮是“打开审查工作台”，追问降为次按钮
                <button className={hasRiskEntry ? "btn-ghost" : "btn-primary"} disabled={busy || !followText.trim()} onClick={() => void prepareFollowUp()}>
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
                {followConfirm.sendSummary && (
                  <SendSummary matterId={matterId} summary={followConfirm.sendSummary} documentIds={inputDocs.map((d) => d.document_version_id)} goal={followText} mustReview={followConfirm.mustReview} onReviewed={() => void prepareFollowUp()} followup />
                )}
                {followConfirm.warning && <div className="banner banner-orange">{followConfirm.warning}</div>}
                {followConfirm.busyRunId && followConfirm.busyRunId !== runId && (
                  <div className="banner-actions">
                    <button className="btn btn-sm" onClick={() => nav(`/run/${followConfirm.busyRunId}/${matterId}`)}>
                      查看进行中的任务
                    </button>
                  </div>
                )}
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

      {paneCollapsed ? (
        <aside className="exec-right exec-right-collapsed">
          <button className="pane-strip" onClick={() => setPaneOpened(true)} title="展开右栏：成果、引用与数据去向" aria-label="展开右栏（成果 0）">
            <Icon.file />
            <span>成果 0</span>
          </button>
        </aside>
      ) : (
      <aside className="exec-right">
        <div className="tabs">
          {rightTabs({ hasRisk: !!risk, intercepted: Number(citationEvent?.payload?.intercepted ?? 0) }).map(([k, l]) => (
            <button
              key={k}
              className={`tab${tab === k ? " active" : ""}`}
              onClick={() => {
                tabTouched.current = true;
                setTab(k);
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="tab-body">
          {tab === "review" && risk && (
            <div className="review-summary">
              <div className="sev-row">
                <span className="pill pill-red">重大 {risk.bySeverity.high}</span>
                <span className="pill pill-orange">一般 {risk.bySeverity.mid}</span>
                <span className="pill pill-gray">提示 {risk.bySeverity.low}</span>
                <span className="muted">已处理 {risk.decided}/{risk.total}</span>
              </div>
              <ol className="review-top">
                {risk.top.map((t, i) => (
                  <li key={i}>{renderTokens(cutKeepingTokens(t.issue, 60), tokenMap)}</li>
                ))}
              </ol>
              {risk.docs.length > 0 && (
                // 中栏已有同一动作的主按钮：右栏这里只用次按钮（复核 S7B-01）
                <button className="btn-ghost" onClick={() => setWorkbench({ doc: risk.docs[0]! })}>
                  打开审查工作台
                </button>
              )}
            </div>
          )}
          {tab === "artifact" && (
            <>
              {!artifactsLoaded && (
                <div className="skeleton" aria-busy="true" aria-label="正在载入成果">
                  <div className="skeleton-line" />
                  <div className="skeleton-line short" />
                </div>
              )}
              {artifactsLoaded && artifacts.length === 0 && <p className="muted">{terminal ? "本任务没有生成文件；结论见左侧回复。" : "任务完成后，生成的文件会出现在这里。"}</p>}
              {artifacts.length > 0 && (
                <Select
                  className="artifact-select"
                  value={selected ?? ""}
                  onChange={setSelected}
                  aria-label="选择交付件"
                  options={artifacts.map((a) => ({ value: a.artifact_version_id, label: `${artifactName(a, (t) => restoredPlain(t, tokenMap))} · v${a.version}` }))}
                />
              )}
              {selected && preview && <SafePreview filename={preview.filename} text={preview.text} tokenMap={tokenMap} office={preview.office} {...(previewMarks ? { cites: previewMarks } : {})} />}
              {selected && <ArtifactActions artifact={artifacts.find((a) => a.artifact_version_id === selected)} onError={setErr} primary={!hasRiskEntry} />}
              {artifacts.length > 1 && (
                // 原“文件历史”标签并入这里（Z3 #11）
                <details className="pane-fold">
                  <summary>本任务的文件（{artifacts.length}）</summary>
                  {artifacts.map((a) => (
                    <div key={a.artifact_version_id} className="hist-row">
                      <div>
                        <b>{artifactName(a, (t) => restoredPlain(t, tokenMap))}</b> <span className="tag tag-gray">v{a.version}</span> <span className="tag tag-gray">{ARTIFACT_STATUS_LABELS[a.status] ?? "状态未知"}</span>
                      </div>
                      <div className="muted">{fmtTime(a.created_at)}</div>
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
          {tab === "egress" && (
            <>
              <DataFlowCard runId={runId} tokenMap={tokenMap} refreshKey={events.length} />
              {methodLine(run, skillTitles, skillVersions) && <p className="muted run-method">{methodLine(run, skillTitles, skillVersions)}</p>}
              {run && (
                // 原“记录”标签并入这里（Z3 #11）
                <details className="pane-fold">
                  <summary>任务记录</summary>
                  <table className="data">
                    <tbody>
                      <tr><th>任务编号</th><td className="mono">{run.run_id}</td></tr>
                      <tr><th>状态</th><td>{RUN_STATUS_LABELS[run.status] ?? run.status}</td></tr>
                      <tr><th>点数</th><td>预留 {run.points_reserved} / 已扣 {run.points_charged}</td></tr>
                      <tr><th>发起</th><td>{fmtTime(run.created_at)}</td></tr>
                      {run.reason && <tr><th>原因</th><td>{reasonLabel(String(run.reason))}</td></tr>}
                    </tbody>
                  </table>
                </details>
              )}
            </>
          )}
          {tab === "citations" && (
            <>
              {/* 论断—依据（C-03，替换原来只列引用的清单）：选中成果里的每处引用；材料的核验结果放在下面 */}
              {selected && (
                <CitationClaims
                  artifactVersionId={selected}
                  citations={selClaims}
                  tokenMap={tokenMap}
                  readOnly={!["draft", "pending_review", "pending_verification"].includes(String(artifacts.find((a) => a.artifact_version_id === selected)?.status ?? ""))}
                  onChanged={(c) => setClaims({ id: selected, c })}
                />
              )}
              {citationEvent && (
                <details className="pane-fold">
                  <summary>材料里的引用核验</summary>
                  <Citations ev={citationEvent} />
                </details>
              )}
            </>
          )}
        </div>
      </aside>
      )}
    </div>
  );
}

/** primary=false：同屏已有主按钮（待处理的审查意见），这里的动作降为次按钮（复核 S7B-01）。 */
function ArtifactActions({ artifact, onError, primary = true }: { artifact: any; onError: (m: string) => void; primary?: boolean }) {
  if (!artifact) return null;
  return (
    <div className="artifact-actions">
      <button
        className="btn-ghost"
        title="下载会记录在事项日志里"
        onClick={() =>
          void api
            .downloadArtifact(artifact.artifact_version_id, artifact.filename)
            .then((saved) => (saved ? api.deliver({ artifact_version_id: artifact.artifact_version_id, action: "download" }) : undefined))
            .catch((e) => onError(e.message))
        }
      >
        {downloadLabel(String(artifact.filename ?? ""))}
      </button>
      {artifact.status === "draft" && (
        <button
          className={primary ? "btn-primary" : "btn-ghost"}
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
      {artifact.status === "pending_review" && <button className={primary ? "btn-primary" : "btn-ghost"} onClick={() => nav(`/review/${artifact.artifact_version_id}`)}>去复核 / 签发</button>}
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

/** 时间线的一步：律师层显示相对时间、处理细节显示时分秒，悬停看完整时间（Y4 R-12）。 */
function StepRow({ s, now, tokenMap, label, showTime }: { s: Step; now: number; tokenMap: Map<string, string | null>; label?: string; showTime: boolean }) {
  const t = showTime ? stepTime(s.at, s.level, now) : null;
  return (
    <div className={`step step-${s.icon}${s.agent ? " step-sub" : ""}`}>
      <span className="step-dot">{s.icon === "ok" ? <Icon.check /> : s.icon === "fail" ? <Icon.x /> : null}</span>
      <div className="step-body">
        <div className="step-title">
          {label ? <span className="tag tag-sub">{label}</span> : null}
          {s.title}
        </div>
        {s.detail && <div className="step-detail">{renderTokens(s.detail, tokenMap)}</div>}
        {(t || s.meta) && (
          <div className="step-meta">
            {t && <time dateTime={s.at} title={t.title}>{t.text}</time>}
            {t && s.meta ? " · " : ""}
            {s.meta}
          </div>
        )}
      </div>
    </div>
  );
}

/** 执行态过程面板（K7-P）：工作清单、子任务、后台任务、进展通知、上下文整理。 */
function ProgressPanel({ vm, tokenMap }: { vm: ProgressViewModel; tokenMap: Map<string, string | null> }) {
  return (
    <div className="progress-panel" aria-live="polite">
      {vm.todo && (
        <div className="progress-block">
          <div className="pane-title">{vm.todo.title}</div>
          <ul className="todo-list">
            {vm.todo.items.map((t, i) => (
              <li key={i} className={`todo-${t.state}`}>
                <span className="todo-mark" aria-hidden="true">{t.mark}</span>
                <span className="sr-only">{t.state === "done" ? "已完成：" : t.state === "doing" ? "进行中：" : "待做："}</span>
                {renderTokens(t.text, tokenMap)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {vm.subagents && (
        <div className="progress-block">
          <div className="pane-title">{vm.subagents.title}</div>
          <ul className="sub-list">
            {vm.subagents.items.map((x, i) => (
              <li key={i} className={x.failed ? "sub-failed" : undefined}>
                <span className="tag tag-sub">{x.state}</span> {renderTokens(x.text, tokenMap)}
                {x.summary && (
                  <details>
                    <summary>子任务的结论摘要</summary>
                    <div className="muted">{renderTokens(x.summary, tokenMap)}</div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {vm.tasks && (
        <div className="progress-block muted">
          {/* 后台任务描述是模型写的文字（令牌形态）：逐项还原代号（复核 B4-B03） */}
          {vm.tasks.title}：
          {vm.tasks.items.map((t, i) => (
            <span key={i}>
              {i > 0 ? "；" : ""}
              {renderTokens(t, tokenMap)}
            </span>
          ))}
        </div>
      )}
      {vm.notes.length > 0 && (
        <div className="progress-block">
          {vm.notes.map((n, i) => (
            <div key={i} className="progress-note">
              <div className="muted">{n.source}的进展</div>
              <Markdown text={n.text} tokenMap={tokenMap} />
            </div>
          ))}
        </div>
      )}
      {vm.compaction && <div className="progress-block muted">{vm.compaction}</div>}
    </div>
  );
}

