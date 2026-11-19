/**
 * 首页（第 03 篇 §4.2；用户拍板按律师业务线组织；UIUX P0-2 / Demo 融合 §4.1–4.2）。
 * 2026-11 对照 Kimi 首页重做版式：居中品牌字标 → 任务输入框（上方“等你处理”提示条、下方事项 / 方法 / 材料托盘）→ 业务线切换 +
 * 场景胶囊（Kimi 能力胶囊同款；每线先列 6 个，其余“更多”）→ 今天（近期期限、继续工作）→ 页脚一行。
 * 描述任务即可，命中业务场景时给出建议、不自动切换；点胶囊是两段式开始面板（“给什么 → 得到什么”的完整口径在面板里与悬停提示里）。
 * 所有场景尚未通过法律质量门槛：胶囊上不逐张标“试用”，页脚统一写一行（Z3 #16、V-a）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Matter, type MaterialFile, type ReminderItem, type RunPolicyView } from "../api.ts";
import { nav, NEW_MATTER } from "../App.tsx";
import { Composer, type ComposerValue } from "../components/Composer.tsx";
import { defaultChoice } from "../components/ModeSelector.tsx";
import { NewMatterDialog } from "../components/NewMatter.tsx";
import { prepareStart, RunSheet, type PendingStart } from "../components/RunSheet.tsx";
import { ScenarioStart } from "../components/ScenarioStart.tsx";
import { cardGets, cardGives, COMING_SOON, getsPlain, LINE_LABELS, SCENARIOS, suggestScenario, type BusinessLine, type ScenarioCard, startMatterFor } from "../lib/scenarios.ts";
import { Icon } from "../components/Icons.tsx";
import { fmtTime, runName } from "../lib/labels.ts";
import { nextStepPill, type RunFacts } from "../lib/next-step.ts";
import { backendDownText, importFailText } from "../lib/errors.ts";
import { dueText, dueTone, reminderKindLabel, upcomingDeadlines } from "../lib/reminders.ts";

const LINE_KEY = "kwl.home.line";
/** 首页场景区的四个页签：三条业务线 + 三线都常用的“通用”（v9.4 S1 §5.5）。 */
type HomeTab = BusinessLine | "general";
const HOME_TABS: HomeTab[] = ["litigation", "transactional", "inhouse", "general"];
/** 每个页签先列几个胶囊（Kimi 首页一行约 7 个；多出的点“更多”）。 */
const CHIP_LIMIT = 6;
function savedLine(): HomeTab {
  try {
    const v = localStorage.getItem(LINE_KEY);
    if (v === "litigation" || v === "transactional" || v === "inhouse" || v === "general") return v;
  } catch {
    // 无本地存储时用缺省
  }
  return "litigation";
}

/** 场景胶囊的图标：按场景名里的动作挑一个（Kimi 能力胶囊每个都带线性图标）。 */
export function scenarioIcon(c: Pick<ScenarioCard, "title">): ReactNode {
  const t = c.title;
  if (/函|催告/.test(t)) return Icon.mail();
  if (/测算|计算/.test(t)) return Icon.calc();
  if (/审|核|比对|体检/.test(t)) return Icon.fileCheck();
  if (/起草|申请|决议|董事会|代理词|对外版|文件/.test(t)) return Icon.pen();
  if (/争点|分析|策略|评估|风险|质证|庭审/.test(t)) return Icon.scale();
  if (/研究|问答|答复|检索|法规/.test(t)) return Icon.book();
  if (/尽调|调查/.test(t)) return Icon.search();
  if (/清单|纪要|案卷|整理/.test(t)) return Icon.folder();
  if (/汇报|报告/.test(t)) return Icon.board();
  return Icon.compass();
}

export function Home({ presetMatterId, startScenario }: { presetMatterId?: string | undefined; startScenario?: string | undefined }) {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [matterId, setMatterId] = useState<string | null>(presetMatterId ?? null);
  const [docs, setDocs] = useState<{ document_version_id: string; filename: string }[]>([]);
  // docs 属于哪个事项（开始面板切换事项时据此判断新事项的材料是否已到）
  const [docsFor, setDocsFor] = useState<string | null>(null);
  const [mattersLoaded, setMattersLoaded] = useState(false);
  // 继续工作：每个已完成任务的“下一步”事实（未处理意见、待复核成果、成果份数）
  const [facts, setFacts] = useState<Record<string, RunFacts>>({});
  const [policy, setPolicy] = useState<RunPolicyView | null>(null);
  const [value, setValue] = useState<ComposerValue>({ goal: "", scenario: "a1.agent_task", documentIds: [], choice: defaultChoice(null) });
  const [pendingReview, setPendingReview] = useState<any[]>([]);
  // 等你处理 / 继续工作（UIUX 增量评审 H-1）
  const [recent, setRecent] = useState<{ run_id: string; matter_id: string; matter_title: string; scenario: string; status: string; updated_at: string; goal: string }[]>([]);
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
        setMatterId((cur) => (cur && open.some((m) => m.matter_id === cur) ? cur : open[0]?.matter_id ?? null));
      })
      .catch(() => setMsg(backendDownText(import.meta.env.DEV)));
  }, []);
  // 上手指南最后一步“新建第一个事项”
  useEffect(() => {
    const on = () => setNewMatter(true);
    window.addEventListener(NEW_MATTER, on);
    return () => window.removeEventListener(NEW_MATTER, on);
  }, []);
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
  // “下一步”胶囊的事实：已完成的任务再取审查意见进度与本任务成果（本机内核，最多 5 个任务）
  useEffect(() => {
    const done = recent.filter((r) => r.status === "succeeded" || r.status === "partial");
    if (done.length === 0) return;
    let live = true;
    void (async () => {
      const arts = new Map<string, any[]>();
      for (const mid of [...new Set(done.map((r) => r.matter_id))]) arts.set(mid, (await api.listArtifacts(mid).catch(() => ({ artifacts: [] as any[] }))).artifacts);
      const out: Record<string, RunFacts> = {};
      for (const r of done) {
        const rc = await api.riskCards(r.matter_id, { run_id: r.run_id }).catch(() => null);
        const mine = (arts.get(r.matter_id) ?? []).filter((a) => a.run_id === r.run_id);
        out[r.run_id] = {
          status: r.status,
          openOpinions: rc ? Math.max(0, rc.progress.total - rc.progress.decided) : 0,
          pendingReview: mine.filter((a) => a.status === "pending_review").length,
          artifacts: mine.length,
          drafts: mine.filter((a) => a.status === "draft").length,
          approved: mine.filter((a) => a.status === "approved").length,
        };
      }
      if (live) setFacts(out);
    })();
    return () => {
      live = false;
    };
  }, [recent]);

  const submit = async () => {
    const matter = matters.find((m) => m.matter_id === matterId);
    if (!matter) return setNewMatter(true);
    setBusy(true);
    setMsg("");
    try {
      const v = value.documentIds.length === 0 && value.scenario !== "a1.agent_task" ? { ...value, documentIds: docs.map((d) => d.document_version_id) } : value;
      setSheet(await prepareStart(matter, v, { docNames: docs.filter((d) => v.documentIds.includes(d.document_version_id)).map((d) => d.filename) }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importFiles = async (files: FileList | MaterialFile[]) => {
    if (!matterId) return;
    setBusy(true);
    // 逐个导入：一份失败（例如带密级标志被拒）不影响其余文件，结果逐条告诉律师
    const lines: string[] = [];
    const fails: string[] = [];
    setFailMsg("");
    try {
      for (const f of Array.from(files)) {
        try {
          const r = await api.importMaterial(matterId, f);
          setValue((v) => ({ ...v, documentIds: [...v.documentIds, r.document_version_id] }));
          lines.push(`已添加 ${f.name}（${r.chars.toLocaleString()} 字）${r.marking_notice ? `。${r.marking_notice}` : ""}`);
        } catch (e) {
          fails.push(importFailText(f.name, (e as Error).message));
        }
      }
      setMsg(lines.join("\n"));
      setFailMsg(fails.join("\n"));
      loadMatter(matterId);
    } finally {
      setBusy(false);
    }
  };

  // 等你处理（Kimi 输入框上方提示条同位）：等你确认的任务、待复核的草稿
  const notice =
    waiting.length > 0 || pendingReview.length > 0 ? (
      <>
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
      </>
    ) : null;
  const tabCards = (t: HomeTab) => (t === "general" ? SCENARIOS.filter((c) => c.general) : SCENARIOS.filter((c) => c.line === t && !c.general));
  const cards = tabCards(line);
  const shown = moreOpen ? cards : cards.slice(0, CHIP_LIMIT);
  const showToday = deadlines.length > 0 || deadlinesFailed || recent.length > 0;

  return (
    <main className="main main-home">
      <div className="home">
        <div className="home-center">
          {/* Kimi 首页同款：居中品牌字标 + 输入框 + 托盘 + 能力胶囊；首屏不放大块卡片 */}
          <h1 className="home-wordmark" aria-label="Kimi Work 法律版">
            <span className="brand-mark home-mark" aria-hidden="true">K</span>
            <span>Kimi Work</span>
            <span className="home-wordmark-tag">法律</span>
          </h1>
          <Composer
            matters={matters}
            matterId={matterId}
            onMatterChange={(id) => {
              matterChosen.current = true;
              setMatterId(id);
            }}
            onNewMatter={() => setNewMatter(true)}
            documents={docs}
            policy={policy}
            value={value}
            onChange={setValue}
            onImport={(f) => void importFiles(f)}
            onSubmit={() => void submit()}
            busy={busy}
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
          {msg && <p className="muted home-msg" role="status" style={{ whiteSpace: "pre-line" }}>{msg}</p>}
          {failMsg && <div className="banner banner-red home-msg" role="alert" style={{ whiteSpace: "pre-line" }}>{failMsg}</div>}
          {mattersLoaded && matters.length === 0 && (
            <p className="home-first">
              还没有事项。案卷、材料和成果都归在事项里，只存在这台电脑上。
              <button className="btn-link" onClick={() => setNewMatter(true)}>
                新建第一个事项
              </button>
            </p>
          )}

          {/* 业务场景（Kimi 能力胶囊同款）：按业务线切换，每线先列 6 个，其余点“更多”；完整说明在开始面板与“方法与模板”页 */}
          <section className="home-scenes" aria-label="从业务场景开始" data-tour="scenarios">
            <div className="scene-tabs" role="tablist" aria-label="业务线">
              {HOME_TABS.map((t) => (
                <button key={t} role="tab" aria-selected={line === t} className={`scene-tab${line === t ? " active" : ""}`} onClick={() => chooseLine(t)}>
                  {t === "general" ? "通用" : LINE_LABELS[t]}
                </button>
              ))}
            </div>
            <div className="scene-chips">
              {shown.map((c) => (
                <button key={c.id} className="scene-chip" title={`得到：${cardGets(c)}\n需要：${cardGives(c)}`} aria-label={`${c.title}：给 ${c.gives}；得到 ${c.gets.join("、")}`} onClick={() => openCard(c)}>
                  <span className="scene-chip-icon" aria-hidden="true">{scenarioIcon(c)}</span>
                  {c.title}
                </button>
              ))}
              {cards.length > CHIP_LIMIT && (
                <button className="scene-chip scene-chip-more" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
                  {moreOpen ? "收起" : `更多 ${cards.length - CHIP_LIMIT} 个`}
                </button>
              )}
              <button className="scene-chip scene-chip-more" onClick={() => nav("/methods")}>
                全部方法 →
              </button>
            </div>
            {/* 即将推出（v9.4 第 20 批，S1 §5.1 第 4 条）：灰显、不能点，不挂到相近的方法上 */}
            {line !== "general" && COMING_SOON.some((x) => x.line === line) && (
              <div className="coming-row muted" aria-label="即将推出">
                即将推出：{COMING_SOON.filter((x) => x.line === line).map((x) => x.title).join(" · ")}
              </div>
            )}
          </section>
        </div>

        {/* 今天（v9.4 U1 #3）：近期期限、继续工作；“等你处理”已放到输入框上方提示条；都空时不显示 */}
        {showToday && (
          <section className="today" aria-label="今天">
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
            <div className="today-col">
              <div className="today-h">
                继续工作
                {recent.length > 3 && matterId && (
                  <button className="btn-link" onClick={() => nav(`/matter/${matterId}`)}>
                    全部 →
                  </button>
                )}
              </div>
              {recent.length === 0 ? (
                <p className="today-empty">还没有任务。</p>
              ) : (
                recent.slice(0, 3).map((r) => {
                  const pill = nextStepPill(facts[r.run_id] ?? { status: r.status });
                  return (
                    <button key={r.run_id} className="today-row" onClick={() => nav(`/run/${r.run_id}/${r.matter_id}`)} title={`${r.matter_title} · ${fmtTime(r.updated_at)}`}>
                      {/* 第 26 批（评审 U2-33）：多个事项同时在办时看得出是哪个案子 */}
                      {/* 第 27 批（评审 U3-14）：状态胶囊与任务名同一行，事项名单独一行占满宽，不再被胶囊挤掉能区分案子的后半截 */}
                      <span className="today-main">
                        <span className="today-line">
                          <span className="today-text">{runName(r)}</span>
                          <span className={`pill ${pill.tone}`}>{pill.text}</span>
                        </span>
                        <small className="today-sub">{r.matter_title}</small>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        )}
        {/* Kimi 首页页脚同位：一行灰字 */}
        <p className="home-foot">全部场景试用中 · 结果须律师复核 · 案卷在这台电脑上处理，只把替换过代号的内容发给 AI</p>
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
            setStarting((st) => (st ? { ...st, matterId: m.matter_id } : st));
          }}
        />
      )}
    </main>
  );
}
