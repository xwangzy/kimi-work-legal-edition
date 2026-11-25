/**
 * 首页（第 03 篇 §4.2；用户拍板按律师业务线组织；UIUX P0-2 / Demo 融合 §4.1–4.2）。
 * 2026-11 对照 Kimi 首页重做版式：居中品牌字标 → 任务输入框（上方“等你处理”提示条、下方事项 / 方法 / 材料托盘）→ 业务线切换 +
 * 场景胶囊（Kimi 能力胶囊同款；每线先列 6 个，其余“更多”）→ 今天（近期期限、继续工作）→ 页脚一行。
 * 描述任务即可，命中业务场景时给出建议、不自动切换；点胶囊是两段式开始面板（“给什么 → 得到什么”的完整口径在面板里与悬停提示里）。
 * 所有场景尚未通过法律质量门槛：胶囊上不逐张标“试用”，页脚统一写一行（Z3 #16、V-a）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Matter, type MaterialFile, type QuotaStatus, type ReminderItem, type RunPolicyView } from "../api.ts";
import { modelChoices } from "../lib/model-choices.ts";
import { useModelCatalog } from "../components/ModelPicker.tsx";
import { consumeNewMatterRequest, nav, NEW_MATTER } from "../App.tsx";
import { quotaNotice } from "../lib/quota-notice.ts";
import { importResultText, visibleMaterials, type MaterialLike } from "../lib/material-folder.ts";
import { recommendedCards } from "../lib/recommend.ts";
import { Composer, type ComposerValue } from "../components/Composer.tsx";
import { defaultChoice } from "../components/ModeSelector.tsx";
import { NewMatterDialog } from "../components/NewMatter.tsx";
import { GuideChecklist } from "../components/GuideChecklist.tsx";
import { prepareStart, RunSheet, type PendingStart } from "../components/RunSheet.tsx";
import { ScenarioStart } from "../components/ScenarioStart.tsx";
import { cardGets, cardGives, COMING_SOON, getsPlain, LINE_LABELS, SCENARIOS, suggestScenario, type BusinessLine, type ScenarioCard, startMatterFor } from "../lib/scenarios.ts";
import { Icon } from "../components/Icons.tsx";
import { backendDownText, importFailText } from "../lib/errors.ts";
import { dueText, dueTone, reminderKindLabel, upcomingDeadlines } from "../lib/reminders.ts";
import { WaitBlock } from "../components/Loading.tsx";
import { countProgress } from "../lib/waiting.ts";

const LINE_KEY = "kwl.home.line";
/** 额度提示条关掉后记住的键（同一周期同一情形不再提示；lib/quota-notice.ts）。 */
const QUOTA_DISMISS_KEY = "kwl.home.quota-dismissed";
/**
 * 首页能力胶囊（第 47 批对照 Kimi 首页“推荐 / PPT / 专业研究 …”一行胶囊）：推荐 + 三条业务线 + 三线都常用的“通用”（v9.4 S1 §5.5）。
 * 点胶囊在下方列出该组场景（标题 + 得到什么），点一行打开开始面板。
 */
type HomeTab = "recommended" | BusinessLine | "general";
const HOME_TABS: HomeTab[] = ["recommended", "litigation", "transactional", "inhouse", "general"];
const TAB_LABELS: Record<HomeTab, string> = { recommended: "推荐", litigation: "诉讼仲裁", transactional: "非诉交易", inhouse: "企业法务", general: "通用" };
/** 每组先列几行（多出的点“更多”）。 */
const CHIP_LIMIT = 6;
function savedLine(): HomeTab {
  try {
    const v = localStorage.getItem(LINE_KEY);
    if (v === "recommended" || v === "litigation" || v === "transactional" || v === "inhouse" || v === "general") return v;
  } catch {
    // 无本地存储时用缺省
  }
  return "recommended";
}
function tabIcon(t: HomeTab): ReactNode {
  if (t === "recommended") return Icon.sparkle();
  if (t === "litigation") return Icon.scale();
  if (t === "transactional") return Icon.fileCheck();
  if (t === "inhouse") return Icon.shield();
  return Icon.compass();
}


import { scenarioIcon } from "../components/ScenarioIcon.tsx";
export { scenarioIcon };

export function Home({ presetMatterId, startScenario }: { presetMatterId?: string | undefined; startScenario?: string | undefined }) {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [matterId, setMatterId] = useState<string | null>(presetMatterId ?? null);
  const [docs, setDocs] = useState<{ document_version_id: string; filename: string }[]>([]);
  // docs 属于哪个事项（开始面板切换事项时据此判断新事项的材料是否已到）
  const [docsFor, setDocsFor] = useState<string | null>(null);
  const [mattersLoaded, setMattersLoaded] = useState(false);
  const [policy, setPolicy] = useState<RunPolicyView | null>(null);
  const [value, setValue] = useState<ComposerValue>({ goal: "", scenario: "a1.agent_task", documentIds: [], choice: defaultChoice(null) });
  const [pendingReview, setPendingReview] = useState<any[]>([]);
  // 等你处理 / 继续工作（UIUX 增量评审 H-1）
  const [recent, setRecent] = useState<{ run_id: string; matter_id: string; matter_title: string; scenario: string; status: string; updated_at: string; goal: string; skill?: string | null }[]>([]);
  // 额度提示条（第 47 批，Kimi 输入框上方“月额度已不足 10%……”同位）
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [quotaDismissed, setQuotaDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(QUOTA_DISMISS_KEY);
    } catch {
      return null;
    }
  });
  const [waiting, setWaiting] = useState<{ run_id: string; matter_id: string }[]>([]);
  // 今天（v9.4 U1 #3）：近期期限也放到首页首屏
  const [deadlines, setDeadlines] = useState<ReminderItem[]>([]);
  // 读期限失败时不能说“14 天内没有期限”（复核 Q1-17）
  const [deadlinesFailed, setDeadlinesFailed] = useState(false);
  const [newMatter, setNewMatter] = useState(false);
  const [sheet, setSheet] = useState<PendingStart | null>(null);
  const [msg, setMsg] = useState("");
  // 导入没成功的文件单列、红色（第 27 批，评审 U3-04：原来与成功的混在一段灰字里，英文报错直接上屏）
  const [failMsg, setFailMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // 正在导入材料（第 51 批）：逐份导入时的真实计数与当前文件名；原来只把发送键灰掉，提示还错写成“正在发起…”
  const [importing, setImporting] = useState<{ done: number; total: number; name: string; since: number } | null>(null);
  const [line, setLine] = useState<HomeTab>(savedLine);
  const [moreOpen, setMoreOpen] = useState(false);
  // 开始面板：事项在面板里可切换（Z3 评审 #1）；matterId 为 null 表示默认“新建事项”
  const [starting, setStarting] = useState<{ card: ScenarioCard; extra?: string; matterId: string | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggested = value.scenario === "a1.agent_task" ? suggestScenario(value.goal) : null;
  const suggestion = suggested && suggested.id !== dismissed ? suggested : null;
  const chooseLine = (l: HomeTab) => {
    setLine(l);
    setMoreOpen(false);
    try {
      localStorage.setItem(LINE_KEY, l);
    } catch {
      // 忽略
    }
  };
  // 默认事项按卡片业务线挑（Z3 评审 #1：非诉卡不默认挂到诉讼事项上）；keep = 指定了事项（“接着做”）时照用
  // 律师亲手选过事项（首页事项下拉、新建、从事项页进来）：开卡时照用，不按业务线换（第 34 批 T1b）
  const matterChosen = useRef(!!presetMatterId);
  const openCard = (card: ScenarioCard, extra?: string, keep?: string, typed = false) => {
    const { matterId: pick, missing } = startMatterFor(keep, matters, matterId, card, matterChosen.current || typed);
    if (pick && pick !== matterId) setMatterId(pick);
    if (missing) setMsg("原来的事项已结案或不在最近的事项里，没有替你换成别的事项：请在下面选择事项，或新建一个。");
    setStarting({ card, ...(extra ? { extra } : {}), matterId: pick });
  };
  const switchStartMatter = (id: string) => {
    matterChosen.current = true;
    setMatterId(id);
    setStarting((s) => (s ? { ...s, matterId: id } : s));
  };
  // 从“方法与模板”页进入（#/start/<场景>）：事项载入后打开该场景的开始面板一次，并把地址还原为首页
  const startedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (!startScenario || startedFrom.current === startScenario || !mattersLoaded) return;
    const card = SCENARIOS.find((c) => c.id === startScenario);
    startedFrom.current = startScenario;
    if (card) {
      setLine(card.general ? "general" : card.line);
      openCard(card, undefined, presetMatterId);
    }
    window.history.replaceState(null, "", "#/");
  }, [startScenario, mattersLoaded, matters]);

  const sampleTried = useRef(false);
  const loadMatters = useCallback(() => {
    api
      .listMatters()
      .then((r) => {
        // 首页只用于发起任务：已结案（只读）的事项不在可选之列
        const open = r.matters.filter((m) => (m.lifecycle ?? "active") === "active");
        // 第一次使用、还没有任何事项：只有演示形态（内核开着演示开关）才放入虚构的示例事项；正式产品不放演示数据，
        // 新律师由首次上手指南带着建第一个事项（2026-11）
        if (r.matters.length === 0 && !sampleTried.current) {
          sampleTried.current = true;
          void api
            .kernelStatus()
            .then((st: any) => (st?.demo_samples === true ? api.installSample() : null))
            .then((s) => {
              if (s?.installed) loadMatters();
            })
            .catch(() => {});
        }
        setMatters(open);
        setMattersLoaded(true);
        // 第 66 批：缺省停在上次用过的事项（原来一律停在第一个，导入的文件容易放错事项）
        setMatterId((cur) => (cur && open.some((m) => m.matter_id === cur) ? cur : lastMatterOf(open) ?? open[0]?.matter_id ?? null));
      })
      .catch(() => setMsg(backendDownText(import.meta.env.DEV)));
  }, []);
  // 上手指南最后一步“新建第一个事项”；侧栏“事项 +”（从别的页面过来时首页挂载后取走请求）
  useEffect(() => {
    const on = () => {
      consumeNewMatterRequest();
      setNewMatter(true);
    };
    window.addEventListener(NEW_MATTER, on);
    if (consumeNewMatterRequest()) setNewMatter(true);
    return () => window.removeEventListener(NEW_MATTER, on);
  }, []);
  useEffect(() => {
    void api.quotaStatus().then(setQuota).catch(() => setQuota(null));
  }, []);
  // 第 66 批（V40 P0-4）：任务模型来自云端模型目录（套餐与路由决定哪些可选）；选了记在本机，发起任务时带给内核
  const [taskModels, setTaskModels] = useModelCatalog("task");
  const [modelMsg, setModelMsg] = useState("");
  const unavail = taskModels?.selected_unavailable;
  useEffect(() => {
    if (unavail) setModelMsg(`上次选的「${unavail.label}」暂时不能用（${unavail.reason_text ?? "云端已调整"}），已换回「${taskModels?.models.find((m) => m.id === taskModels.default)?.label ?? "缺省模型"}」。`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unavail?.id]);
  const chooseTaskModel = (id: string) => {
    setModelMsg("");
    void api
      .modelsSelect("task", id)
      .then(() => setTaskModels((v) => (v ? { ...v, selected: id } : v)))
      .catch((e) => setModelMsg((e as Error).message));
  };
  useEffect(() => {
    loadMatters();
    api.pending().then((r) => setPendingReview(r.pending)).catch(() => {});
    api
      .reminders()
      .then((r) => {
        setDeadlines(upcomingDeadlines(r.reminders));
        setDeadlinesFailed(false);
      })
      .catch(() => {
        setDeadlines([]);
        setDeadlinesFailed(true);
      });
    api
      .recentRuns(5)
      .then((r) => {
        setRecent(r.runs);
        setWaiting(r.waiting);
      })
      .catch(() => {});
  }, [loadMatters]);
  const loadMatter = useCallback((id: string) => {
    api
      .getMatter(id)
      .then((r) => {
        setDocs(r.documents.filter((d: any) => !d.quarantined_at));
        setDocsFor(id);
        setPolicy(r.run_policy ?? null);
        setValue((v) => ({ ...v, documentIds: v.documentIds.filter((d) => r.documents.some((x: any) => x.document_version_id === d)), choice: defaultChoice(r.run_policy) }));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (matterId) loadMatter(matterId);
  }, [matterId, loadMatter]);
  // 材料弹层只列当前有效的那一版（同一位置被新版本取代的旧版不列，与开始面板同一口径）
  const visibleDocs = useMemo(() => visibleMaterials(docs as MaterialLike[], { hideOldVersions: true }), [docs]);
  const submit = async () => {
    const matter = matters.find((m) => m.matter_id === matterId);
    if (!matter) return setNewMatter(true);
    setBusy(true);
    setMsg("");
    try {
      // 没勾材料 = 全部材料（第 48 批：不含被同一位置新版本取代的旧版本）
      const old = new Set(docs.map((d) => (d as { supersedes?: string | null }).supersedes).filter((x): x is string => !!x));
      const v = value.documentIds.length === 0 && value.scenario !== "a1.agent_task" ? { ...value, documentIds: docs.filter((d) => !old.has(d.document_version_id)).map((d) => d.document_version_id) } : value;
      setSheet(await prepareStart(matter, v, { docNames: docs.filter((d) => v.documentIds.includes(d.document_version_id)).map((d) => d.filename), ...(taskModels?.selected ? { model: taskModels.selected } : {}) }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importFiles = async (files: FileList | MaterialFile[] | File[]) => {
    if (!matterId) return;
    const title = matters.find((m) => m.matter_id === matterId)?.title ?? "本事项";
    setBusy(true);
    // 逐个导入：一份失败（例如带密级标志被拒）不影响其余文件，结果逐条告诉律师
    const lines: string[] = [];
    const fails: string[] = [];
    setFailMsg("");
    const list = Array.from(files);
    const since = Date.now();
    try {
      for (const [i, f] of list.entries()) {
        setImporting({ done: i, total: list.length, name: f.name, since });
        try {
          const r = (await api.importMaterial(matterId, f as MaterialFile)) as Awaited<ReturnType<typeof api.importMaterial>> & { duplicate?: boolean; filename?: string };
          setValue((v) => ({ ...v, documentIds: v.documentIds.includes(r.document_version_id) ? v.documentIds : [...v.documentIds, r.document_version_id] }));
          // 第 66 批：写明存进了哪个事项；同一份内容已在本事项时不重复保存（内核按内容摘要去重）
          lines.push(`「${title}」· ${f.name}：${importResultText(f.name, r)}`);
        } catch (e) {
          fails.push(importFailText(f.name, (e as Error).message));
        }
      }
      setMsg(lines.join("\n"));
      setFailMsg(fails.join("\n"));
      loadMatter(matterId);
    } finally {
      setBusy(false);
      setImporting(null);
    }
  };

  // 输入框上方提示条（Kimi 同位）：额度提示（不足 10%、用完、到上限、放缓）在上；等你确认的任务、待复核的草稿在下
  const qn = quotaNotice(quota);
  const showQuota = qn && (qn.tone === "stop" || quotaDismissed !== qn.key);
  const dismissQuota = () => {
    if (!qn) return;
    setQuotaDismissed(qn.key);
    try {
      localStorage.setItem(QUOTA_DISMISS_KEY, qn.key);
    } catch {
      // 记不住时只在本次打开期间生效
    }
  };
  const waitingRow =
    waiting.length > 0 || pendingReview.length > 0 ? (
      <div className="notice-row">
        <span className="act-dot act-wait" aria-hidden="true" />
        {waiting.length > 0 && (
          <button className="btn-link notice-strong" onClick={() => nav(`/run/${waiting[0]!.run_id}/${waiting[0]!.matter_id}`)}>
            {waiting.length} 个任务等你确认或回答
          </button>
        )}
        {waiting.length > 0 && pendingReview.length > 0 && <span aria-hidden="true">·</span>}
        {pendingReview.length > 0 && (
          <button className="btn-link" onClick={() => nav(pendingReview.length === 1 ? `/review/${pendingReview[0].artifact_version_id}` : "/deliverables")}>
            {pendingReview.length} 份草稿待你复核
          </button>
        )}
      </div>
    ) : null;
  const notice =
    showQuota || waitingRow ? (
      <>
        {showQuota && qn && (
          <div className={`notice-row notice-quota${qn.tone === "stop" ? " is-stop" : ""}`} role="status">
            <span className="notice-icon" aria-hidden="true">{Icon.chart()}</span>
            <span className="notice-text">{qn.text}</span>
            <button className="btn-link" onClick={() => nav("/connections/usage")}>
              查看用量
            </button>
            <span className="spacer" />
            {qn.tone === "warn" && (
              <button className="notice-x" onClick={dismissQuota} aria-label="关闭额度提示" title="本期不再提示">
                <Icon.x />
              </button>
            )}
          </div>
        )}
        {waitingRow}
      </>
    ) : null;
  const tabCards = (t: HomeTab) => (t === "recommended" ? recommendedCards(recent) : t === "general" ? SCENARIOS.filter((c) => c.general) : SCENARIOS.filter((c) => c.line === t && !c.general));
  const cards = tabCards(line);
  const shown = moreOpen ? cards : cards.slice(0, CHIP_LIMIT);
  // 近期期限（v9.4 U1 #3）：有期限或读不出来时显示；“继续工作”已由侧栏“任务”分组承担（第 47 批）
  const showToday = deadlines.length > 0 || deadlinesFailed;

  return (
    <main className="main main-home">
      <div className="home">
        <div className="home-center">
          {/* Kimi Work 首页同款：居中粗体字标 + 右上黑色小标（Kimi 为“KIMI”+“WORK”，我方为“Kimi Work”+“法律版”，与侧栏字标、安装包与快捷方式名称一致，第 49 批）+ 输入框 + 托盘 + 能力胶囊 */}
          <h1 className="home-wordmark" aria-label="Kimi Work 法律版">
            {/* 字宽按 textLength 定死（只调字距），各系统字体下宽度一致，右上小标不会离开字标 */}
            <svg className="home-wordmark-svg" viewBox="0 0 236 52" role="presentation" aria-hidden="true">
              <text x="0" y="44" fill="currentColor" fontSize="50" fontWeight="800" textLength="234" lengthAdjust="spacing" fontFamily="inherit">
                Kimi Work
              </text>
            </svg>
            <span className="home-wordmark-tag">法律版</span>
          </h1>
          <Composer
            matters={matters}
            matterId={matterId}
            onMatterChange={(id) => {
              matterChosen.current = true;
              setMatterId(id);
              rememberMatter(id);
            }}
            onNewMatter={() => setNewMatter(true)}
            documents={visibleDocs}
            policy={policy}
            value={value}
            onChange={setValue}
            onImport={(f) => void importFiles(f)}
            importOne={(f) => api.importMaterial(matterId!, f)}
            onImported={() => matterId && loadMatter(matterId)}
            {...(taskModels ? { models: modelChoices(taskModels), model: taskModels.selected, onModelChange: chooseTaskModel } : {})}
            onToggleDoc={(id, on) => setValue((v) => ({ ...v, goal: v.goal.replace(/@$/, ""), documentIds: on ? (v.documentIds.includes(id) ? v.documentIds : [...v.documentIds, id]) : v.documentIds.filter((x) => x !== id) }))}
            onSubmit={() => void submit()}
            busy={busy}
            {...(importing ? { busyText: "正在导入材料…" } : {})}
            notice={notice}
            onPickScenario={(c) => openCard(c, value.goal.replace(/\/$/, "").trim() || undefined)}
            suggestion={
              suggestion
                ? {
                    title: suggestion.title,
                    gets: getsPlain(suggestion).join("、"),
                    onUse: () => openCard(suggestion, value.goal, undefined, true),
                    onDismiss: () => setDismissed(suggestion.id),
                  }
                : null
            }
          />
          {importing && (
            <WaitBlock
              title={importing.total > 1 ? `正在导入第 ${countProgress(importing.done + 1, importing.total)?.text ?? ""} 份…` : "正在导入材料…"}
              hint={importing.name}
              since={importing.since}
              longHint="扫描件、图片要先识别文字，会慢一些；导入完会在这里逐份列出结果。"
            />
          )}
          {modelMsg && <p className="muted home-msg" role="status">{modelMsg}</p>}
          {msg && <p className="muted home-msg" role="status" style={{ whiteSpace: "pre-line" }}>{msg}</p>}
          {failMsg && <div className="banner banner-red home-msg" role="alert" style={{ whiteSpace: "pre-line" }}>{failMsg}</div>}
          {/* 能力胶囊（第 47 批对照 Kimi 首页一行胶囊）：推荐 + 三条业务线 + 通用；下方列出该组场景（标题 + 得到什么），点一行打开开始面板 */}
          <section className="home-scenes" aria-label="从业务场景开始" data-tour="scenarios">
            <div className="scene-chips" role="tablist" aria-label="场景分组">
              {HOME_TABS.map((t) => (
                <button key={t} role="tab" aria-selected={line === t} className={`scene-chip${line === t ? " active" : ""}`} onClick={() => chooseLine(t)}>
                  <span className="scene-chip-icon" aria-hidden="true">{tabIcon(t)}</span>
                  {t === "recommended" || t === "general" ? TAB_LABELS[t] : LINE_LABELS[t]}
                </button>
              ))}
              <button className="scene-chip scene-chip-more" onClick={() => nav("/methods")}>
                全部方法 →
              </button>
            </div>
            <div className="scene-list" role="tabpanel" aria-label={TAB_LABELS[line]}>
              {shown.map((c) => (
                <button key={c.id} className="scene-row" title={`需要：${cardGives(c)}`} aria-label={`${c.title}：给 ${c.gives}；得到 ${c.gets.join("、")}`} onClick={() => openCard(c)}>
                  <span className="scene-row-icon" aria-hidden="true">{scenarioIcon(c)}</span>
                  <span className="scene-row-title">{c.title}</span>
                  <span className="scene-row-gets">得到：{cardGets(c)}</span>
                </button>
              ))}
              {cards.length > CHIP_LIMIT && (
                <button className="scene-row scene-row-more" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
                  {moreOpen ? "收起" : `还有 ${cards.length - CHIP_LIMIT} 个场景`}
                </button>
              )}
              {/* 即将推出（v9.4 第 20 批，S1 §5.1 第 4 条）：灰显、不能点，不挂到相近的方法上 */}
              {line !== "general" && line !== "recommended" && COMING_SOON.some((x) => x.line === line) && (
                <div className="coming-row muted" aria-label="即将推出">
                  即将推出：{COMING_SOON.filter((x) => x.line === line).map((x) => x.title).join(" · ")}
                </div>
              )}
            </div>
          </section>
          {/* 上手清单（第 46 批；第 47 批收成一行）：新律师第一次进首页时出现，四步按真实数据自动打勾，可展开、可收起 */}
          {mattersLoaded && <GuideChecklist onNewMatter={() => setNewMatter(true)} />}
        </div>

        {/* 近期期限（v9.4 U1 #3）：“等你处理”在输入框上方提示条，“继续工作”在侧栏“任务”分组；没有期限时不显示 */}
        {showToday && (
          <section className="today today-single" aria-label="近期期限">
            <div className="today-col">
              <div className="today-h">近期期限</div>
              {deadlinesFailed ? (
                <p className="today-empty">
                  期限暂时读不出来。<button className="btn-link" onClick={() => nav("/reminders")}>去期限提醒查看</button>
                </p>
              ) : deadlines.length === 0 ? (
                <p className="today-empty">
                  14 天内没有期限。<button className="btn-link" onClick={() => nav("/reminders")}>设期限</button>
                </p>
              ) : (
                deadlines.slice(0, 3).map((d) => (
                  <button key={d.reminder_id} className="today-row" onClick={() => nav(`/matter/${d.matter_id}`)} title={`${d.due_date} · ${d.matter_title}`}>
                    <span className={`pill pill-${dueTone(d.due_date) === "red" ? "red" : dueTone(d.due_date) === "orange" ? "orange" : "gray"}`}>{dueText(d.due_date)}</span>
                    <span className="today-text">{d.note || reminderKindLabel(d.kind)} · {d.matter_title}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        )}
        {/* Kimi 首页页脚同位：一行灰字 */}
        {/* 第 66 批：去掉固定页脚（试用中 / 须复核 / 数据去向）。这些说明在开始面板右栏、成果复核与“设置 · 数据去向”里按场景出现 */}
      </div>
      {sheet && <RunSheet pending={sheet} onClose={() => setSheet(null)} />}
      {starting && (
        <ScenarioStart
          // 换卡（例如“改用劳动仲裁应对”）时重新挂载，上一张卡填的字段不带过去
          key={starting.card.id}
          card={starting.card}
          matter={matters.find((m) => m.matter_id === starting.matterId) ?? null}
          matters={matters}
          onMatterChange={switchStartMatter}
          onNewMatter={() => setNewMatter(true)}
          documentsFor={docsFor}
          documents={docs}
          policy={policy}
          {...(starting.extra ? { initialExtra: starting.extra } : {})}
          onImport={(f) => importFiles(f)}
          onDocsChanged={() => starting.matterId && loadMatter(starting.matterId)}
          onClose={() => setStarting(null)}
        />
      )}
      {/* 新建事项放在开始面板之后渲染：从面板里“新建事项”时盖在面板上面，建好后面板直接选中它 */}
      {newMatter && (
        <NewMatterDialog
          onClose={() => setNewMatter(false)}
          onCreated={(m) => {
            setNewMatter(false);
            setMatters((ms) => [m, ...ms]);
            matterChosen.current = true;
            setMatterId(m.matter_id);
            rememberMatter(m.matter_id);
            setStarting((st) => (st ? { ...st, matterId: m.matter_id } : st));
          }}
        />
      )}
    </main>
  );
}

/** 上次在首页用过的事项（第 66 批）：只存事项编号，读写失败时退回缺省。 */
const LAST_MATTER_KEY = "kwl.home.lastMatter";
function lastMatterOf(open: readonly { matter_id: string }[]): string | null {
  try {
    const id = localStorage.getItem(LAST_MATTER_KEY);
    return id && open.some((m) => m.matter_id === id) ? id : null;
  } catch {
    return null;
  }
}
function rememberMatter(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_MATTER_KEY, id);
  } catch {
    // 记不住时下次按缺省
  }
}
