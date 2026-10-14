/**
 * 首页（第 03 篇 §4.2；用户拍板按律师业务线组织；UIUX P0-2 / Demo 融合 §4.1–4.2）：
 * 输入框在上（描述任务即可，命中业务场景时给出建议、不自动切换）；下面按业务线（诉讼仲裁 / 非诉 / 企业法务）各 5 张场景卡，
 * 卡片写“给什么 → 得到什么”，点开是两段式开始面板。所有场景尚未通过法律质量门槛，统一标“试用”。
 */
import { useCallback, useEffect, useState } from "react";
import { api, type Matter, type RunPolicyView } from "../api.ts";
import { nav } from "../App.tsx";
import { Composer, type ComposerValue } from "../components/Composer.tsx";
import { defaultChoice } from "../components/ModeSelector.tsx";
import { NewMatterDialog } from "../components/NewMatter.tsx";
import { prepareStart, RunSheet, type PendingStart } from "../components/RunSheet.tsx";
import { ScenarioStart } from "../components/ScenarioStart.tsx";
import { LINE_LABELS, SCENARIOS, suggestScenario, type BusinessLine, type ScenarioCard } from "../lib/scenarios.ts";

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

export function Home({ presetMatterId }: { presetMatterId?: string | undefined }) {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [matterId, setMatterId] = useState<string | null>(presetMatterId ?? null);
  const [docs, setDocs] = useState<{ document_version_id: string; filename: string }[]>([]);
  const [policy, setPolicy] = useState<RunPolicyView | null>(null);
  const [value, setValue] = useState<ComposerValue>({ goal: "", scenario: "a1.agent_task", documentIds: [], choice: defaultChoice(null) });
  const [pendingReview, setPendingReview] = useState<any[]>([]);
  const [newMatter, setNewMatter] = useState(false);
  const [sheet, setSheet] = useState<PendingStart | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<BusinessLine>(savedLine);
  const [starting, setStarting] = useState<{ card: ScenarioCard; extra?: string } | null>(null);
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
  const openCard = (card: ScenarioCard, extra?: string) => {
    if (!matters.find((m) => m.matter_id === matterId)) return setNewMatter(true);
    setStarting({ card, ...(extra ? { extra } : {}) });
  };

  const loadMatters = useCallback(() => {
    api
      .listMatters()
      .then((r) => {
        // 首页只用于发起任务：已结案（只读）的事项不在可选之列
        const open = r.matters.filter((m) => (m.lifecycle ?? "active") === "active");
        setMatters(open);
        setMatterId((cur) => (cur && open.some((m) => m.matter_id === cur) ? cur : open[0]?.matter_id ?? null));
      })
      .catch((e) => setMsg(`${e.message}（请确认内核已启动：桌面客户端内嵌，或开发桥 127.0.0.1:7720）`));
  }, []);
  useEffect(() => {
    loadMatters();
    api.pending().then((r) => setPendingReview(r.pending)).catch(() => {});
  }, [loadMatters]);
  const loadMatter = useCallback((id: string) => {
    api
      .getMatter(id)
      .then((r) => {
        setDocs(r.documents.filter((d: any) => !d.quarantined_at));
        setPolicy(r.run_policy ?? null);
        setValue((v) => ({ ...v, documentIds: v.documentIds.filter((d) => r.documents.some((x: any) => x.document_version_id === d)), choice: defaultChoice(r.run_policy) }));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (matterId) loadMatter(matterId);
  }, [matterId, loadMatter]);

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

  const importFiles = async (files: FileList) => {
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
            <p>先建一个事项：案卷在这台电脑上处理与保存，事项头写明立场、密级与四项依据。</p>
            <button className="btn-primary" onClick={() => setNewMatter(true)}>新建事项</button>
          </div>
        )}

        {pendingReview.length > 0 && (
          <section>
            <div className="section-title">待我复核 / 签发</div>
            <div className="cards">
              {pendingReview.slice(0, 4).map((p) => (
                <button key={p.artifact_version_id} className="card" onClick={() => nav(`/review/${p.artifact_version_id}`)}>
                  <div className="title">{p.filename}</div>
                  <div className="desc">{p.matter_title} · v{p.version} · 待复核</div>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="lines">
          <div className="section-title">从业务场景开始</div>
          <div className="line-tabs" role="tablist" aria-label="业务线">
            {(Object.keys(LINE_LABELS) as BusinessLine[]).map((l) => (
              <button key={l} role="tab" aria-selected={line === l} className={`line-tab${line === l ? " active" : ""}`} onClick={() => chooseLine(l)}>
                {LINE_LABELS[l]}
              </button>
            ))}
          </div>
          <div className="cards scenario-cards">
            {SCENARIOS.filter((c) => c.line === line).map((c) => (
              <button key={c.id} className="card scenario-card" aria-label={`${c.title}（试用）：给 ${c.gives}；得到 ${c.gets.join("、")}`} onClick={() => openCard(c)}>
                <div className="title">
                  {c.title} <span className="tag tag-beta">试用</span>
                </div>
                <div className="desc">
                  <span className="sc-k">给</span>
                  {c.gives}
                </div>
                <div className="desc">
                  <span className="sc-k">得</span>
                  {c.gets.join("、")}
                </div>
              </button>
            ))}
          </div>
        </section>
        <p className="muted foot-note">
          所有场景都在试用阶段：结果是草稿，须律师复核后使用。也可以直接在上面描述任务。更多方法见 <button className="btn-link" onClick={() => nav("/methods")}>方法与模板</button>。
        </p>
      </div>
      {newMatter && (
        <NewMatterDialog
          onClose={() => setNewMatter(false)}
          onCreated={(m) => {
            setNewMatter(false);
            setMatters((ms) => [m, ...ms]);
            setMatterId(m.matter_id);
          }}
        />
      )}
      {sheet && <RunSheet pending={sheet} onClose={() => setSheet(null)} />}
      {starting && matterId && matters.find((m) => m.matter_id === matterId) && (
        <ScenarioStart
          card={starting.card}
          matter={matters.find((m) => m.matter_id === matterId)!}
          documents={docs}
          policy={policy}
          {...(starting.extra ? { initialExtra: starting.extra } : {})}
          onImport={(f) => importFiles(f)}
          onClose={() => setStarting(null)}
        />
      )}
    </main>
  );
}
