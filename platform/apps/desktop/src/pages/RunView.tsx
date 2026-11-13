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
import { ARTIFACT_STATUS_LABELS, CITE_STATE_LABELS, fileListName, EFFECTIVENESS_LABELS, fmtShortTime, fmtTime, jurisdictionLabel, MODE_LABELS, RUN_STATUS_LABELS, runName, stanceLabel, stepTime, stripMarkdownInline, TERMINAL_STATUSES } from "../lib/labels.ts";
import { cutKeepingTokens, forgetRestored, restoredPlain, restoreTokens } from "../lib/tokens.ts";
import { followUpMaterialsText, nextScenarios, scenarioOfRun, type BusinessLine } from "../lib/scenarios.ts";
import { currentBadges } from "../lib/badges.ts";
import { engineHeartbeatMs, hasProgress, mergeProgress, phaseLine, progressActivityKey, progressTexts, retryStoppable, silenceMs, stallThresholdMs, progressView, type ProgressViewModel } from "../lib/progress.ts";
import { buildSteps, groupSubtaskSteps, keyStepKeys, mergeRepeatSteps, problemSteps, processSummary, reusedArtifacts, sentByToolCall, toolLabel, type SentInfo, type Step } from "../lib/timeline.ts";
import { busyRunOfError } from "../lib/start-block.ts";
import { methodLine, methodShort } from "../lib/run-method.ts";
import { Select } from "../components/Select.tsx";
import { artifactOptionOrder, currentFiles, queuedText, rightCollapsed, rightTabs, type RightTab } from "../lib/run-pane.ts";
import { isPrimaryFile } from "../lib/deliverables.ts";
import { FileTypeTag } from "../components/ArtifactRow.tsx";
import { previewCites, previewFactMarks, type ArtifactCitations, type FactMarkView } from "../lib/citation-review.ts";
import { CitationClaims } from "../components/CitationClaims.tsx";
import { Breadcrumb } from "../components/Breadcrumb.tsx";
import { OutlineConfirm } from "../components/OutlineConfirm.tsx";
import { confirmAndAnswer, outlineAnswer, outlineQuestion, type OutlineView } from "../lib/outline.ts";

/** 页面标题：场景卡名；律师自己描述的任务用描述前 30 字，悬停看全文（Z3 #21、V-g；第 26 批 runName）。 */
function runTitle(run: any): string {
  return runName(run);
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
  // 排队原因（V18 第 43 批）：前面有几个任务在等律师确认或回答
  const [waitingAhead, setWaitingAhead] = useState(0);
  const [run, setRun] = useState<any>(null);
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [docs, setDocs] = useState<any[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedOperation[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [questions, setQuestions] = useState<QuestionCard[]>([]);
  // 起草前的论点与依据（C-04）：本任务待确认的提纲
  const [outline, setOutline] = useState<OutlineView | null>(null);
  /** 本任务的提纲已确认、且没有新的待确认提纲（第 34 批：提问卡里的“已确认”题据此自动选上；原先只记待确认的提纲，一确认就变成 null，锁随之消失） */
  const [outlineConfirmed, setOutlineConfirmed] = useState(false);
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
  const revision = useMemo(() => [...artifacts].filter((a) => a.kind === "revision_draft").sort((a, b) => Number(b.kind_version ?? b.version) - Number(a.kind_version ?? a.version))[0] ?? null, [artifacts]);
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
  /** 追问时补勾的材料（上一轮没勾的）与勾选列表是否展开。 */
  const [followAdd, setFollowAdd] = useState<string[]>([]);
  const [followAddOpen, setFollowAddOpen] = useState(false);
  // 追问框在页面最底部：展开补充材料的列表、出现确认行时都在它下面、落在可视区之外——滚到底，免得律师点了之后看不到变化
  const followWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (followAddOpen || followConfirm) followWrapRef.current?.scrollIntoView?.({ block: "end" });
  }, [followAddOpen, followConfirm]);
  const [tokenMap, setTokenMap] = useState<Map<string, string | null>>(new Map());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [exitMode, setExitMode] = useState<string | null>(null);
  const cursor = useRef(0);
  const inflight = useRef(false);
  const terminal = TERMINAL_STATUSES.includes(status);
  // 结果与之前某次任务逐字相同、沿用了那次的文件（第 27 批，走查 W-5）：不再只写“成果 0”
  const reused = artifacts.length === 0 ? reusedArtifacts(events) : [];
  // 本任务的成果名用本任务的名字补（第 27 批走查：执行页取成果的接口不带任务名，没有内容标题的助手草稿仍显示“助手草稿”）
  const runSnap = (() => {
    try {
      return typeof run?.input_snapshot === "string" ? JSON.parse(run.input_snapshot) : (run?.input_snapshot ?? {});
    } catch {
      return {};
    }
  })();
  const withRun = (a: any) => ({ ...a, run_title: a.run_title ?? runSnap.title ?? null, run_goal: a.run_goal ?? runSnap.goal ?? run?.goal ?? null });
  // 成果名（V18 A2 统一命名：答复摘要、修订稿按文件名）；代号在界面还原
  const nameOf = (a: any) => fileListName(withRun(a), (t) => restoredPlain(t, tokenMap));
  // 右栏下拉的选项名：交付文件写名称（第 2 版起写版数），旧版注明“旧版”，过程文件前面写“过程文件”
  const optionLabel = (o: { row: any; group: "file" | "older" | "process"; old: boolean }) => {
    const v = o.old || Number(o.row.version) > 1 ? ` · 第 ${o.row.version} 版` : "";
    if (o.group === "process") return `过程文件 · ${nameOf(o.row)}${o.old ? `${v}（旧版）` : ""}`;
    return `${nameOf(o.row)}${v}${o.old ? "（旧版）" : ""}`;
  };
  // 本次的主交付物（方法或场景卡定义的文件名）：结果区与右栏都把它排第一
  const primaryName: string | null = typeof runSnap.skill_primary_output === "string" ? runSnap.skill_primary_output : (scenarioOfRun(run, homeLine())?.primary ?? null);
  const downloadOne = (a: any) =>
    void api
      .downloadArtifact(a.artifact_version_id, restoredPlain(String(a.filename ?? ""), tokenMap))
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
      setWaitingAhead(Number(g.waiting_ahead ?? 0));
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
        const list = ol?.outlines ?? [];
        setOutline(list.find((o) => o.status === "proposed") ?? null);
        setOutlineConfirmed(!list.some((o) => o.status === "proposed") && list.some((o) => o.status === "confirmed"));
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
        setOutlineConfirmed(false);
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
  // 结果区的一句话结论（V18 A1）：取最新一份答复摘要的正文，不再依赖右栏选中的是哪一份
  const [replyText, setReplyText] = useState("");
  const texts = useMemo(
    () => [preview?.text ?? "", replyText, factText, liveText, ...progressTexts(progress), ...approvals.flatMap((a) => [a.title, a.preview.plan ?? "", a.preview.detail ?? ""]), ...questions.flatMap((q) => q.questions.flatMap((x) => [x.question, ...x.options.map((o) => o.label)])), ...events.map((e) => String(e.payload?.description ?? "")), ...artifacts.map((a) => `${a.title ?? ""}\n${a.filename ?? ""}`), ...(risk?.top.map((t) => t.issue) ?? []), ...(outline?.items.flatMap((x) => [x.claim, x.counter ?? "", ...x.basis.map((b) => b.note ?? ""), ...x.facts.map((f) => f.statement)]) ?? [])].join("\n"),
    [preview, replyText, factText, liveText, progress, approvals, questions, events, artifacts, risk, outline],
  );
  useEffect(() => {
    if (!texts.includes("〔")) return;
    restoreTokens(matterId, texts).then(setTokenMap).catch(() => {});
  }, [texts, matterId]);

  // 右栏“成果”的顺序（V18 A1 #4）：交付文件最新版 → 旧版 → 过程文件；默认选中主交付物的最新版。
  // 律师自己选过（下拉、结果区、审查工作台生成修订稿）之后不再自动换
  const options = useMemo(() => artifactOptionOrder(artifacts, { primary: primaryName }), [artifacts, primaryName]);
  const selTouched = useRef(false);
  const pickArtifact = (id: string) => {
    selTouched.current = true;
    setSelected(id);
  };
  useEffect(() => {
    if (selTouched.current || options.length === 0) return;
    const best = options[0]!.row.artifact_version_id;
    if (best !== selected) setSelected(best);
  }, [options, selected]);
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
  const outlineQ = useMemo(() => (outline || outlineConfirmed ? outlineQuestion(questions) : null), [outline, outlineConfirmed, questions]);
  const pendingCards = useMemo(
    // 只有确认题单独一张卡时才整张并进提纲卡；和别的题同卡时卡照常显示，确认那一题跟着提纲卡走（第 31 批）
    () => [...approvals.map((card) => ({ kind: "approval" as const, card })), ...questions.filter((q) => !(outline && outlineQ && outlineQ.others === 0 && q.question_id === outlineQ.question_id)).map((card) => ({ kind: "question" as const, card }))],
    [approvals, questions, outlineQ, outline],
  );
  const [showAllCards, setShowAllCards] = useState(false);
  // V16 A3：确认卡、提问卡、提纲卡在时间线之后的正常文档流里（此前粘在中栏底部，卡片高于一屏时从页顶盖住标题与任务说明）；
  // 新卡出现时把卡片顶部滚到眼前（同一张卡刷新不再滚动）
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<HTMLDivElement | null>(null);
  const firstCardKey = pendingCards[0] ? (pendingCards[0].kind === "approval" ? pendingCards[0].card.approval_id : pendingCards[0].card.question_id) : null;
  useEffect(() => {
    if (firstCardKey) cardsRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [firstCardKey]);
  const outlineKey = outline && !terminal ? outline.outline_id : null;
  useEffect(() => {
    if (outlineKey) outlineRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [outlineKey]);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const doneFiles = useMemo(() => currentFiles(artifacts, { primary: primaryName }), [artifacts, primaryName]);
  const reply = doneFiles.process.find((a) => String(a.kind).startsWith("a1_agent_draft")) ?? null;
  const replyId = reply && /\.(md|txt|markdown)$/i.test(String(reply.filename)) ? String(reply.artifact_version_id) : null;
  useEffect(() => {
    if (!terminal || !replyId) return;
    let live = true;
    api
      .artifactText(replyId)
      .then((r) => live && setReplyText(new TextDecoder().decode(Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0)))))
      .catch(() => live && setReplyText(""));
    return () => {
      live = false;
    };
  }, [terminal, replyId]);
  /** 结束后的排法（V18 A1）：结果在上、过程收起；对账中仍要律师逐项核实，沿用运行中的排法。 */
  const doneLayout = terminal && status !== "reconciling";
  const [processOpen, setProcessOpen] = useState(false);
  // 待复核按文件数算（V18 A2）：旧版与过程文件不算
  const unreviewed = doneFiles.current.filter((a) => a.status === "draft" || a.status === "pending_review").length;
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
  // 追问补勾材料（V18 第 43 批续三）：勾选即边界之后，漏勾一份不必整单重来。只在上一轮勾了材料时提供（没勾的任务本来就可读全部）；
  // 可补的是本事项里上一轮没勾的材料。补勾的随追问一起估价、发起，内核据此放进新一轮的材料快照与读取范围
  const extraDocs = useMemo(() => {
    if (inputDocs.length === 0) return [];
    const had = new Set(inputDocs.map((d) => d.document_version_id));
    return docs.filter((d) => !had.has(d.document_version_id));
  }, [inputDocs, docs]);
  const followDocIds = useMemo(() => [...inputDocs.map((d) => d.document_version_id), ...extraDocs.filter((d) => followAdd.includes(d.document_version_id)).map((d) => d.document_version_id)], [inputDocs, extraDocs, followAdd]);
  const followAdded = followDocIds.length - inputDocs.length;
  // 本轮是追问且补过材料：材料清单里标出哪几份是这一轮补的
  const addedThisRound: string[] = useMemo(() => {
    try {
      const snap = typeof run?.input_snapshot === "string" ? JSON.parse(run.input_snapshot) : (run?.input_snapshot ?? {});
      return Array.isArray(snap.followup_added_document_version_ids) ? snap.followup_added_document_version_ids : [];
    } catch {
      return [];
    }
  }, [run]);

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
      const est = await api.estimate(matterId, { scenario: "a1.agent_task", document_version_ids: followDocIds, goal: text });
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
      setFollowAdd([]);
      setFollowAddOpen(false);
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
  const confirmOutline = async (decisions: Parameters<typeof api.decideOutline>[2], note: string, confirmFacts: boolean) => {
    if (!outline) return;
    setBusy(true);
    setErr("");
    try {
      await confirmAndAnswer({
        decide: () => api.decideOutline(matterId, outline.outline_id, decisions, note, confirmFacts),
        answer: outlineQ && outlineQ.others === 0 ? () => api.answer(runId, outlineQ.question_id, outlineAnswer(outlineQ, true), stateVersion) : null,
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
          pickArtifact(id);
          void refresh();
        }}
      />
    );
  }

  // ——— 页面各块（V18 A1：运行中与结束后两种排法共用）———
  const timelineEl = (
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
            {/* 排队中不是“没进展”（第 29 批：本机同时处理的任务有上限，排在后面的曾被提示“可以取消后重新运行”） */}
            {status === "queued"
              ? queuedText(waitingAhead)
              : (pv.retry ?? (silentFor > stallThresholdMs(progress) ? "已经有一阵子没有新进展了。任务仍在运行；如果长时间没有变化，可以取消后重新运行。" : phaseLine(progress, now, toolLabel) ?? "正在处理…"))}
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
  );
  const notesEl = terminal && lastNotes.length > 0 && (
    <details className="progress-panel">
      <summary className="muted">助手在过程中的进展说明（{lastNotes.length} 条）</summary>
      {lastNotes.map((n, i) => (
        <div key={i} className="progress-note">
          <div className="muted">{n.source}</div>
          <Markdown text={n.text} tokenMap={tokenMap} />
        </div>
      ))}
    </details>
  );
  const reconcileEl = (status === "reconciling" || (status === "failed" && unresolved.length > 0)) && (
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
  );
  // 哪里出了问题 / 还剩什么没做（V18 A1 #3）：部分完成、失败、取消、超时时放在结果区上方；没完成的那一步与说明露在外面，过程照样收起
  const issues = doneLayout && status !== "succeeded" ? problemSteps(allSteps) : [];
  const issueTitle: Record<string, string> = { partial: "部分完成：还有没做完的地方", failed: "任务未完成", cancelled: "任务已取消", timed_out: "任务超过时限，没有做完", expired: "任务已过期，没有做完" };
  const issueEl = doneLayout && status !== "succeeded" && issueTitle[status] && !(status === "failed" && unresolved.length > 0) && (
    <div className={`card done-issue${status === "partial" ? " done-issue-partial" : " retry-card"}`} role="status">
      <div className="title">{issueTitle[status]}</div>
      {issues.length > 0 && (
        <ul className="done-issue-list">
          {issues.map((s) => (
            <li key={s.key}>
              <span>{s.title}</span>
              {s.detail && <div className="muted">{renderTokens(s.detail, tokenMap)}</div>}
            </li>
          ))}
        </ul>
      )}
      {run?.terminal_reason && !issues.some((s) => s.title === String(run.terminal_reason) || s.detail === String(run.terminal_reason)) && <p className="muted">{String(run.terminal_reason)}</p>}
      {status === "failed" && run && (
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
      )}
    </div>
  );
  const riskEl = risk && (risk.docs.length > 0 || risk.unlinked > 0) && (
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
  );
  // ①一句话结论：最新一份答复摘要的前三行（UIUX 增量评审 D-1：全文在右栏，同一份内容不读两遍）
  const summaryEl = terminal && replyText.trim() && reply && (
    <div className="answer answer-summary done-summary">
      <div className="pane-title">结论 · 答复摘要（草稿）</div>
      {summaryLines(replyText).map((l, i) => (
        <p key={i}>{renderTokens(l, tokenMap)}</p>
      ))}
      <button
        className="btn-link"
        onClick={() => {
          tabTouched.current = true;
          pickArtifact(String(reply.artifact_version_id));
          setTab("artifact");
        }}
      >
        在右侧查看全文 →
      </button>
    </div>
  );
  const reusedEl = terminal && (status === "succeeded" || status === "partial") && reused.length > 0 && (
    <div className="card done-files">
      <div className="title">这次的结果与之前一次任务完全相同，沿用了那次的{reused.length > 1 ? ` ${reused.length} 份` : ""}文件</div>
      <p className="muted">内容一字不差时不另存一份新版本，复核与签发都在原来那份上进行。</p>
      <div className="banner-actions">
        <button className="btn-ghost btn-sm" onClick={() => nav(`/review/${reused[0]!.artifact_version_id}`)}>
          打开那份文件
        </button>
        {reused[0]!.first_run_id && (
          <button className="btn-link" onClick={() => nav(`/run/${reused[0]!.first_run_id}/${matterId}`)}>
            看那次任务
          </button>
        )}
      </div>
    </div>
  );
  // ②本次交付的文件：每份只列最新版，主交付物第一（V18 A1/A2，与成果页同一个分组函数）
  const openInPane = (a: any) => {
    tabTouched.current = true;
    pickArtifact(a.artifact_version_id);
    setTab("artifact");
  };
  const filesEl = terminal && doneFiles.current.length > 0 && (
    <div className="done-files">
      <div className="pane-title">本次交付的文件（草稿，{doneFiles.current.length} 份）</div>
      <ul className="done-file-list">
        {/* 多于 6 份时先列 6 份，其余点“全部”展开（v9.4 U1 #8） */}
        {(showAllFiles ? doneFiles.current : doneFiles.current.slice(0, 6)).map((a) => (
          <li key={a.artifact_version_id} className={selected === a.artifact_version_id ? "on" : undefined}>
            <FileTypeTag filename={String(a.filename ?? "")} />
            <button className="btn-link done-file-name" title={restoredPlain(String(a.filename ?? ""), tokenMap)} onClick={() => openInPane(a)}>
              {nameOf(a)}
            </button>
            {isPrimaryFile(String(a.filename ?? ""), primaryName) && <span className="tag tag-gray">主文书</span>}
            {Number(a.version) > 1 && <span className="muted done-file-ver">第 {a.version} 版</span>}
            <span className="spacer" />
            <button className="btn-ghost btn-sm" onClick={() => openInPane(a)}>
              预览
            </button>
            <button className="btn-ghost btn-sm" onClick={() => downloadOne(a)}>
              {downloadLabel(String(a.filename ?? ""))}
            </button>
          </li>
        ))}
      </ul>
      {doneFiles.current.length > 6 && !showAllFiles && (
        <button className="btn-link" onClick={() => setShowAllFiles(true)}>
          全部 {doneFiles.current.length} 份 →
        </button>
      )}
      {/* 同一份文件只列最新一版（第 31 批）：旧版在右栏“成果”里 */}
      {doneFiles.older > 0 && <div className="muted done-files-note">以前的 {doneFiles.older} 个版本在右侧“成果”里。</div>}
    </div>
  );
  // ③下一步：接着做（D-4）：同一事项下打开下一场景的开始面板
  const nextCards = (status === "succeeded" || status === "partial") && (matter?.lifecycle ?? "active") === "active" ? nextScenarios(scenarioOfRun(run, homeLine())) : [];
  const nextEl = nextCards.length > 0 && (
    <div className="next-steps">
      <span className="muted">接着做：</span>
      {nextCards.map((c) => (
        <button key={c.id} className="pill pill-link" onClick={() => nav(`/start/${c.id}/${matterId}`)}>
          {c.title} →
        </button>
      ))}
    </div>
  );

  return (
    // 第 27 批（评审 U3-11）：执行页也有 <main> 地标（读屏“跳到正文”；原来是唯一没有的主页面）
    <main className={`exec${paneCollapsed ? " exec-pane-collapsed" : ""}`}>
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
                // 运行中“执行中”与“AI 处理中”意思重复（V18 A1 #5）：有说明当前在做什么的徽标时只留徽标
                (terminal || status.startsWith("waiting") || badges.length === 0) && <span className={`pill ${terminal ? (status === "succeeded" ? "pill-green" : "pill-gray") : status.startsWith("waiting") ? "pill-orange" : "pill-blue"}`}>{RUN_STATUS_LABELS[status] ?? status}</span>
              )}
              {!status.startsWith("waiting") && badges.map((b) => <span key={b.label} className={`pill pill-${b.tone}`} title={b.title}>{b.label}</span>)}
              {/* 原左栏“在哪里处理”每个任务都一样，收成一枚胶囊（Z3 #29） */}
              <span className="pill pill-gray" title="原件不会被修改；结果都是草稿，须律师复核">原件不改 · 结果是草稿</span>
              {/* 材料入口（UIUX 增量评审 N-1；第 20 批起各种宽度都用两栏，不再有左栏） */}
              <span className="mats-chip-wrap">
                <button className="pill pill-gray" aria-expanded={matsOpen} onClick={() => setMatsOpen((v) => !v)}>
                  {/* 没指定材料时助手按需读取本事项的材料（第 31 批：原先显示“材料 0 份”，像是没给材料） */}
                  {inputDocs.length > 0 ? `材料 ${inputDocs.length} 份 ▾` : "材料：按需读取 ▾"}
                </button>
                {matsOpen && (
                  <div className="mats-pop" role="dialog" aria-label="本次用到的材料">
                    {inputDocs.length === 0 && <div className="muted">没有指定材料：会按需读取本事项的材料。</div>}
                    {inputDocs.map((d) => (
                      <div key={d.document_version_id} className="mat-row">
                        <Icon.file />
                        <span className="mat-name" title={d.filename}>{d.filename}</span>
                        {addedThisRound.includes(d.document_version_id) && <span className="tag tag-gray">本轮补充</span>}
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
        {/* 场景卡发起的任务（第 26 批）：标题是卡名，拼好的任务说明收进“任务说明”，要看再点开 */}
        {(run?.goal ?? run?.input_snapshot?.goal) &&
          (run?.input_snapshot?.title ? (
            <details className="quiet-details goal-details">
              <summary>任务说明</summary>
              <div className="goal-bubble">{renderTokens(String(run.goal ?? run.input_snapshot.goal), tokenMap)}</div>
            </details>
          ) : (
            String(run.goal ?? run.input_snapshot.goal).replace(/\s+/g, " ").trim().length > 30 && <div className="goal-bubble">{renderTokens(String(run.goal ?? run.input_snapshot.goal), tokenMap)}</div>
          ))}
        {doneLayout ? (
          <>
            {/* V18 A1：结束后“结果在上、过程收起”。①哪里出了问题（部分完成、失败、取消时）②结论 ③交付文件 ④下一步；过程收成一行 */}
            {issueEl}
            {reconcileEl}
            {(summaryEl || filesEl || reusedEl || riskEl || nextEl) && (
              <section className="done-result" aria-label="结果">
                {summaryEl}
                {filesEl}
                {reusedEl}
                {(riskEl || nextEl) && (
                  <div className="done-next">
                    {riskEl}
                    {nextEl}
                  </div>
                )}
              </section>
            )}
            {err && <div className="banner banner-red">{err}</div>}
            <div className="done-process">
              <button className="done-process-toggle" aria-expanded={processOpen} onClick={() => setProcessOpen((v) => !v)}>
                <span>{processSummary(allSteps, run?.created_at)}</span>
                <span className="done-process-chev" aria-hidden="true">›</span>
              </button>
              {processOpen && (
                <>
                  {timelineEl}
                  {notesEl}
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {timelineEl}
            {!terminal && hasProgress(pv) && <ProgressPanel vm={pv} tokenMap={tokenMap} />}
            {notesEl}
            {!terminal && liveText.trim() && (
              <div className="live-draft" aria-live="polite" aria-busy="true">
                <div className="pane-title">正在起草…</div>
                <Markdown text={liveText} tokenMap={tokenMap} />
              </div>
            )}
            {err && <div className="banner banner-red">{err}</div>}
            {reconcileEl}
            {issueEl}
            {riskEl}
            <div ref={outlineRef} className="card-anchor" />
            {outline && !terminal && (
              <OutlineConfirm
                key={outline.outline_id}
                outline={outline}
                plain={(t) => (t ? restoredPlain(t, tokenMap) : "")}
                busy={busy}
                canStop={!!outlineQ && outlineQ.others === 0}
                onConfirm={(d, n, f) => void confirmOutline(d, n, f)}
                onStop={() => void stopOutline()}
              />
            )}
            <div className="interactions" ref={cardsRef}>
              {/* 同一时间只展开一张（UIUX 增量评审 P0-F）：先到的先处理，其余折叠为“还有 N 项待确认”，可展开 */}
              {pendingCards.slice(0, showAllCards ? pendingCards.length : 1).map((c) =>
                c.kind === "approval" ? (
                  <ApprovalCardView key={c.card.approval_id} card={c.card} tokenMap={tokenMap} busy={busy} onDecide={(d) => void decide(c.card, d)} />
                ) : (
                  <QuestionCardView
                    key={c.card.question_id}
                    card={c.card}
                    tokenMap={tokenMap}
                    busy={busy}
                    onAnswer={(ans) => void answer(c.card, ans)}
                    {...(outlineQ && outlineQ.others > 0 && c.card.question_id === outlineQ.question_id ? { outlineLock: { qid: outlineQ.qid, confirm: outlineQ.confirm, confirmed: !outline && outlineConfirmed } } : {})}
                  />
                ),
              )}
              {pendingCards.length > 1 && (
                <button className="btn-link interactions-more" onClick={() => setShowAllCards((v) => !v)}>
                  {showAllCards ? "只显示第一项" : `还有 ${pendingCards.length - 1} 项待确认`}
                </button>
              )}
            </div>
            {summaryEl}
            {reusedEl}
            {filesEl}
            {nextEl}
          </>
        )}
        {run?.scenario === "a1.agent_task" && run?.is_mine && (matter?.lifecycle ?? "active") === "active" && (status === "succeeded" || status === "partial") && (
          <div className="followup-wrap" ref={followWrapRef}>
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
            {extraDocs.length > 0 && (
              <div className="followup-mats">
                <button className="btn-link" aria-expanded={followAddOpen} onClick={() => setFollowAddOpen((v) => !v)}>
                  {followAdded > 0 ? `补充材料：已勾 ${followAdded} 份` : "补充材料"} {followAddOpen ? "▴" : "▾"}
                </button>
                {followAddOpen && (
                  <div className="ss-docs" role="group" aria-label="补充材料">
                    {extraDocs.map((d) => {
                      const on = followAdd.includes(d.document_version_id);
                      return (
                        <label key={d.document_version_id} className={`ss-doc${on ? " on" : ""}`}>
                          <input
                            type="checkbox"
                            aria-label={d.filename}
                            checked={on}
                            disabled={busy}
                            onChange={() => {
                              setFollowAdd((ids) => (on ? ids.filter((x) => x !== d.document_version_id) : [...ids, d.document_version_id]));
                              setFollowConfirm(null);
                            }}
                          />
                          <span className="ss-doc-name">{d.filename}</span>
                        </label>
                      );
                    })}
                    <div className="ss-scope muted">{followUpMaterialsText(inputDocs.length, followAdded, extraDocs.length)}</div>
                  </div>
                )}
              </div>
            )}
            {followConfirm && (
              <div className="followup-confirm" role="group" aria-label="追问前确认">
                <div>
                  沿用上一轮：<b>{MODE_LABELS[prevMode]}</b> · 再次使用 {inputDocs.length} 份材料{followAdded > 0 ? `，补充 ${followAdded} 份` : ""} · {followConfirm.points_display}
                </div>
                <div className="muted">{followConfirm.preview}</div>
                {followConfirm.sendSummary && (
                  <SendSummary matterId={matterId} summary={followConfirm.sendSummary} documentIds={followDocIds} goal={followText} mustReview={followConfirm.mustReview} onReviewed={() => void prepareFollowUp()} followup />
                )}
                {followConfirm.warning && <div className="banner banner-orange">{followConfirm.warning}</div>}
                {followConfirm.busyRunId && followConfirm.busyRunId !== runId && (
                  <div className="banner-actions">
                    <button className="btn-ghost btn-sm" onClick={() => nav(`/run/${followConfirm.busyRunId}/${matterId}`)}>
                      查看进行中的任务
                    </button>
                  </div>
                )}
                {prevMode === "chat" && (
                  <label className="lifecycle-check">
                    <input type="checkbox" aria-label="本轮允许写入草稿" checked={followRaise} onChange={(e) => setFollowRaise(e.target.checked)} />
                    本轮允许写入草稿（风险卡、事实、文书草稿），改用“标准”档（留痕）
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
                // 中栏已有同一动作的主按钮：右栏只放一条文字链接，不再是第二个同名按钮（复核 S7B-01；第 26 批评审 U2-32①）
                <button className="btn-link review-summary-link" onClick={() => setWorkbench({ doc: risk.docs[0]! })}>
                  全部 {risk.total} 条意见在审查工作台 →
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
              {artifactsLoaded && artifacts.length === 0 && <p className="muted">{terminal ? (reused.length > 0 ? "结果与之前一次任务相同，沿用了那次的文件（见左侧）。" : "本任务没有生成文件；结论见左侧回复。") : "任务完成后，生成的文件会出现在这里。"}</p>}
              {artifacts.length > 0 && (
                <Select
                  className="artifact-select"
                  value={selected ?? ""}
                  onChange={pickArtifact}
                  aria-label="选择成果"
                  options={options.map((o) => ({ value: o.row.artifact_version_id, label: optionLabel(o) }))}
                />
              )}
              {selected && preview && <SafePreview filename={preview.filename} text={preview.text} tokenMap={tokenMap} office={preview.office} {...(previewMarks ? { cites: previewMarks } : {})} />}
              {/* 旧版与过程文件只给下载，不给“提交复核”（V18 A2）；提交复核对着的仍是那一个版本 */}
              {selected && <ArtifactActions artifact={artifacts.find((a) => a.artifact_version_id === selected)} restore={(t) => restoredPlain(t, tokenMap)} onError={setErr} primary={!hasRiskEntry} review={options.some((o) => o.row.artifact_version_id === selected && o.group === "file")} />}
              {artifacts.length > 1 && (
                // 原“文件历史”标签并入这里（Z3 #11）
                <details className="pane-fold">
                  <summary>本任务的文件（{artifacts.length}）</summary>
                  {options.map(({ row: a }) => (
                    <div key={a.artifact_version_id} className="hist-row">
                      <div>
                        <b>{nameOf(a)}</b> <span className="tag tag-gray">第 {a.version} 版</span> <span className="tag tag-gray">{ARTIFACT_STATUS_LABELS[a.status] ?? "状态未知"}</span>
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
                      <tr><th>用量</th><td>{run.usage_display ?? "—"}</td></tr>
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
    </main>
  );
}

/** primary=false：同屏已有主按钮（待处理的审查意见），这里的动作降为次按钮（复核 S7B-01）。 */
function ArtifactActions({ artifact, restore, onError, primary = true, review = true }: { artifact: any; restore: (t: string) => string; onError: (m: string) => void; primary?: boolean; review?: boolean }) {
  if (!artifact) return null;
  return (
    <div className="artifact-actions">
      <button
        className="btn-ghost"
        title="下载会记录在事项日志里"
        onClick={() =>
          void api
            .downloadArtifact(artifact.artifact_version_id, restore(String(artifact.filename ?? "")))
            .then((saved) => (saved ? api.deliver({ artifact_version_id: artifact.artifact_version_id, action: "download" }) : undefined))
            .catch((e) => onError(e.message))
        }
      >
        {downloadLabel(String(artifact.filename ?? ""))}
      </button>
      {review && artifact.status === "draft" && (
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
      {review && artifact.status === "pending_review" && <button className={primary ? "btn-primary" : "btn-ghost"} onClick={() => nav(`/review/${artifact.artifact_version_id}`)}>去复核 / 签发</button>}
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

