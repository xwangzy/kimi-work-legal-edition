/**
 * 首页（第 03 篇 §4.2；用户拍板按律师业务线组织；UIUX P0-2 / Demo 融合 §4.1–4.2）：
 * 输入框在上（描述任务即可，命中业务场景时给出建议、不自动切换）；下面按业务线（诉讼仲裁 / 非诉 / 企业法务）各 5 张场景卡，
 * 卡片写“给什么 → 得到什么”，点开是两段式开始面板。所有场景尚未通过法律质量门槛：卡片上不逐张标“试用”，场景区标题旁统一写一行（Z3 #16、V-a）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Matter, type MaterialFile, type RunPolicyView } from "../api.ts";
import { nav } from "../App.tsx";
import { Composer, type ComposerValue } from "../components/Composer.tsx";
import { defaultChoice } from "../components/ModeSelector.tsx";
import { NewMatterDialog } from "../components/NewMatter.tsx";
import { prepareStart, RunSheet, type PendingStart } from "../components/RunSheet.tsx";
import { ScenarioStart } from "../components/ScenarioStart.tsx";
import { cardGets, cardGives, LINE_LABELS, SCENARIOS, suggestScenario, type BusinessLine, type ScenarioCard, startMatterFor } from "../lib/scenarios.ts";
import { fmtTime, fmtWhen, SCENARIO_LABELS } from "../lib/labels.ts";
import { nextStepPill, type RunFacts } from "../lib/next-step.ts";
import { backendDownText } from "../lib/errors.ts";

const LINE_KEY = "kwl.home.line";
function savedLine(): BusinessLine {
  try {
    const v = localStorage.getItem(LINE_KEY);
    if (v === "litigation" || v === "transactional" || v === "inhouse") return v;
  } catch {
    // 无本地存储时用缺省
  }
  return "litigation";
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
  const [newMatter, setNewMatter] = useState(false);
  const [sheet, setSheet] = useState<PendingStart | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<BusinessLine>(savedLine);
  // 开始面板：事项在面板里可切换（Z3 评审 #1）；matterId 为 null 表示默认“新建事项”
  const [starting, setStarting] = useState<{ card: ScenarioCard; extra?: string; matterId: string | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggested = value.scenario === "a1.agent_task" ? suggestScenario(value.goal) : null;
  const suggestion = suggested && suggested.id !== dismissed ? suggested : null;
  const chooseLine = (l: BusinessLine) => {
    setLine(l);
    try {
      localStorage.setItem(LINE_KEY, l);
    } catch {
      // 忽略
    }
  };
  // 默认事项按卡片业务线挑（Z3 评审 #1：非诉卡不默认挂到诉讼事项上）；keep = 指定了事项（“接着做”）时照用
  const openCard = (card: ScenarioCard, extra?: string, keep?: string) => {
    const { matterId: pick, missing } = startMatterFor(keep, matters, matterId, card);
    if (pick && pick !== matterId) setMatterId(pick);
    if (missing) setMsg("原来的事项已结案或不在最近的事项里，没有替你换成别的事项：请在下面选择事项，或新建一个。");
    setStarting({ card, ...(extra ? { extra } : {}), matterId: pick });
  };
  const switchStartMatter = (id: string) => {
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
      setLine(card.line);
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
        // 第一次使用、还没有任何事项：放入一件虚构的示例事项（只放一次，移除后不再放入）
        if (r.matters.length === 0 && !sampleTried.current) {
          sampleTried.current = true;
          void api
            .installSample()
            .then((s) => {
              if (s.installed) loadMatters();
            })
            .catch(() => {});
        }
        setMatters(open);
        setMattersLoaded(true);
        setMatterId((cur) => (cur && open.some((m) => m.matter_id === cur) ? cur : open[0]?.matter_id ?? null));
      })
      .catch(() => setMsg(backendDownText(import.meta.env.DEV)));
  }, []);
  useEffect(() => {
    loadMatters();
    api.pending().then((r) => setPendingReview(r.pending)).catch(() => {});
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
      setSheet(await prepareStart(matter, v));
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
    try {
      for (const f of Array.from(files)) {
        try {
          const r = await api.importMaterial(matterId, f);
          setValue((v) => ({ ...v, documentIds: [...v.documentIds, r.document_version_id] }));
          lines.push(`已添加 ${f.name}（${r.chars.toLocaleString()} 字）${r.marking_notice ? `。${r.marking_notice}` : ""}`);
        } catch (e) {
          lines.push(`${f.name} 未添加：${(e as Error).message}`);
        }
      }
      setMsg(lines.join("\n"));
      loadMatter(matterId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="main">
      <div className="main-narrow home">
        <h1 className="hero-title">今天要处理什么？</h1>
        <Composer
          matters={matters}
          matterId={matterId}
          onMatterChange={setMatterId}
          onNewMatter={() => setNewMatter(true)}
          documents={docs}
          policy={policy}
          value={value}
          onChange={setValue}
          onImport={(f) => void importFiles(f)}
          onSubmit={() => void submit()}
          busy={busy}
          onPickScenario={(c) => openCard(c, value.goal.replace(/\/$/, "").trim() || undefined)}
          suggestion={
            suggestion
              ? {
                  title: suggestion.title,
                  gets: suggestion.gets.join("、"),
                  onUse: () => openCard(suggestion, value.goal),
                  onDismiss: () => setDismissed(suggestion.id),
                }
              : null
          }
        />
        {msg && <p className="muted home-msg">{msg}</p>}
        {matters.length === 0 && (
          <div className="panel empty-panel">
            <p>先建一个事项：案卷在这台电脑上处理与保存。建事项时写明我方立场、敏感程度和客户授权情况。</p>
            <button className="btn-primary" onClick={() => setNewMatter(true)}>新建事项</button>
          </div>
        )}

        {(waiting.length > 0 || pendingReview.length > 0) && (
          <div className="todo-strip" role="status">
            <span className="act-dot act-wait" aria-hidden="true" />
            {waiting.length > 0 && (
              <button className="btn-link" onClick={() => nav(`/run/${waiting[0]!.run_id}/${waiting[0]!.matter_id}`)}>
                {waiting.length} 个任务在等你确认或回答 →
              </button>
            )}
            {pendingReview.length > 0 && (
              <button className="btn-link" onClick={() => nav(pendingReview.length === 1 ? `/review/${pendingReview[0].artifact_version_id}` : "/deliverables")}>
                {pendingReview.length} 份草稿待你复核 →
              </button>
            )}
          </div>
        )}

        <section className="lines">
          <div className="section-title section-title-row">
            从业务场景开始 <span className="muted section-note">全部场景试用中 · 结果须律师复核</span>
          </div>
          <div className="line-tabs" role="tablist" aria-label="业务线">
            {(Object.keys(LINE_LABELS) as BusinessLine[]).map((l) => (
              <button key={l} role="tab" aria-selected={line === l} className={`line-tab${line === l ? " active" : ""}`} onClick={() => chooseLine(l)}>
                {LINE_LABELS[l]}
              </button>
            ))}
          </div>
          <div className="cards scenario-cards">
            {SCENARIOS.filter((c) => c.line === line).map((c) => (
              <button key={c.id} className="card scenario-card" aria-label={`${c.title}：给 ${c.gives}；得到 ${c.gets.join("、")}`} onClick={() => openCard(c)}>
                {/* v9.4 卡片减负：标题 → 交付件（不带扩展名与括注）→ 需要什么（一行、灰字）；完整口径在开始面板 */}
                <div className="title">{c.title}</div>
                <div className="sc-gets">{cardGets(c)}</div>
                <div className="sc-gives">需要：{cardGives(c)}</div>
              </button>
            ))}
            <button className="card scenario-card scenario-more" onClick={() => nav("/methods")}>
              <div className="title">更多场景 →</div>
              <div className="sc-gives">全部方法与模板，按业务线和交付件查找</div>
            </button>
          </div>
        </section>
        {recent.length > 0 && (
          <section>
            <div className="section-title section-title-row">
              继续工作
              {matterId && (
                <button className="btn-link" onClick={() => nav(`/matter/${matterId}`)}>
                  本事项全部任务 →
                </button>
              )}
            </div>
            <ul className="recent-list">
              {recent.map((r) => {
                const pill = nextStepPill(facts[r.run_id] ?? { status: r.status });
                return (
                <li key={r.run_id}>
                  <button className="recent-row" onClick={() => nav(`/run/${r.run_id}/${r.matter_id}`)}>
                    <span className="recent-goal">{r.goal || SCENARIO_LABELS[r.scenario] || "任务"}</span>
                    <span className="muted">{r.matter_title}</span>
                    <span className={`pill ${pill.tone}`}>{pill.text}</span>
                    <span className="muted recent-time" title={fmtTime(r.updated_at)}>{fmtWhen(r.updated_at)}</span>
                  </button>
                </li>
                );
              })}
            </ul>
          </section>
        )}
        <p className="muted foot-note">
          也可以直接在上面描述任务。更多方法见 <button className="btn-link" onClick={() => nav("/methods")}>方法与模板</button>。
        </p>
      </div>
      {sheet && <RunSheet pending={sheet} onClose={() => setSheet(null)} />}
      {starting && (
        <ScenarioStart
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
            setMatterId(m.matter_id);
            setStarting((st) => (st ? { ...st, matterId: m.matter_id } : st));
          }}
        />
      )}
    </main>
  );
}
