/**
 * 事项页（第 03 篇 §4.4 事项头常显；材料、任务、看板、当事人词典、数据去向）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, pickMaterials, type EgressRecord, type Matter, type MaterialFile, type MaterialTriage, type MatterBasis, type RunPolicyView } from "../api.ts";
import { triageSuggestion, triageText } from "../lib/material-triage.ts";
import { nav } from "../App.tsx";
import { Composer, type ComposerValue } from "../components/Composer.tsx";
import { BasisEditor, basisComplete, MatterHeader } from "../components/MatterHeader.tsx";
import { Modal } from "../components/Modal.tsx";
import { defaultChoice } from "../components/ModeSelector.tsx";
import { PartiesPanel } from "../components/Parties.tsx";
import { prepareStart, RunSheet, type PendingStart } from "../components/RunSheet.tsx";
import { TableReview } from "../components/TableReview.tsx";
import type { TableView } from "../lib/table-review.ts";
import { reasonLabel } from "../components/DataFlow.tsx";
import { DEST_LABELS, fmtTime, fmtWhen, jurisdictionLabel, MODE_LABELS, parseFlagsText, RUN_STATUS_LABELS, SCENARIO_LABELS, stanceLabel } from "../lib/labels.ts";
import { FactsPanel } from "../components/FactsPanel.tsx";
import { decideMatterTab } from "../lib/matter-tab.ts";
import { sampleBannerText } from "../lib/scenarios.ts";
import { MatterBoard } from "./Boards.tsx";
import { MatterDeliverables } from "./Deliverables.tsx";
import { MatterLifecyclePanel } from "../components/MatterLifecycle.tsx";
import { ReviewWorkbench } from "../components/ReviewWorkbench.tsx";
import { notifyDataChanged } from "../lib/events.ts";
import { RolePills } from "../components/Select.tsx";
import { Breadcrumb } from "../components/Breadcrumb.tsx";

type Tab = "materials" | "facts" | "runs" | "board" | "deliverables" | "parties" | "egress" | "lifecycle";

export function MatterPage({ matterId }: { matterId: string }) {
  const [matter, setMatter] = useState<Matter | null>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [policy, setPolicy] = useState<RunPolicyView | null>(null);
  // 事项页标签（Z3 评审 IA-4、#10）：打开事项默认停在“概览”；还没有材料的新事项停在“材料”；律师点过标签后不再自动切换
  const [tab, setTabRaw] = useState<Tab>("materials");
  const [moreOpen, setMoreOpen] = useState(false);
  // “⋯”菜单：点外面或按 Esc 关闭（复核 Q1-20）
  const moreRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);
  // 复核 B13-U04：只在每个事项首次拿到材料列表时定一次，之后材料数变化（如拖入第一份材料）不再自动跳走
  const tabTouched = useRef(false);
  const tabDecidedFor = useRef<string | null>(null);
  const setTab = (t: Tab) => {
    tabTouched.current = true;
    setTabRaw(t);
  };
  useEffect(() => {
    const next = decideMatterTab(tabDecidedFor.current, matter?.matter_id ?? null, docs.length, tabTouched.current);
    tabDecidedFor.current = next.decidedFor;
    if (next.tab) setTabRaw(next.tab);
  }, [matter?.matter_id, docs.length]);
  const [value, setValue] = useState<ComposerValue>({ goal: "", scenario: "a1.agent_task", documentIds: [], choice: defaultChoice(null) });
  const [sheet, setSheet] = useState<PendingStart | null>(null);
  // 输入框不常驻（v9.4 第 20 批 G-09：1280×720 下标签内容起点 ≤ 260px）：标题行“发起任务”展开；写了字的不收起
  const [composerOpen, setComposerOpen] = useState(false);
  // 材料标签：列表 / 表格审阅（v9.4 第 19 批 C-01：不加导航，只加视图）
  const [matView, setMatView] = useState<"list" | "table">("list");
  const [tableFocus, setTableFocus] = useState<string | null>(null);
  const [basisOpen, setBasisOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** 每份材料的审查意见（复核 B3-B20：事项页的工作台入口，跨任务汇总）；null 键 = 未关联合同的意见。 */
  const [review, setReview] = useState<Map<string | null, { total: number; open: number }>>(new Map());
  const [workbench, setWorkbench] = useState<{ doc: string | null } | null>(null);
  /** 材料初判（v9.4 第 22 批，C1 #28）：本机按规则认出的文书类型与篇幅，只做建议。 */
  const [triage, setTriage] = useState<Map<string, MaterialTriage>>(new Map());
  const mountRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    api
      .getMatter(matterId)
      .then((r) => {
        setMatter(r.matter);
        setDocs(r.documents);
        setRuns(r.runs ?? []);
        setPolicy(r.run_policy ?? null);
        setValue((v) => ({ ...v, choice: v.goal || v.documentIds.length ? v.choice : defaultChoice(r.run_policy) }));
      })
      .catch((e) => setMsg(e.message));
    api
      .materialTriage(matterId)
      .then((r) => setTriage(new Map(r.items.map((t) => [t.document_version_id, t]))))
      .catch(() => setTriage(new Map()));
    api
      .riskCards(matterId)
      .then((r) => {
        const m = new Map<string | null, { total: number; open: number }>();
        for (const c of r.cards) {
          const k = c.document_version_id ?? null;
          const cur = m.get(k) ?? { total: 0, open: 0 };
          cur.total++;
          if (c.status === "proposed") cur.open++;
          m.set(k, cur);
        }
        setReview(m);
      })
      .catch(() => setReview(new Map()));
  }, [matterId]);
  useEffect(reload, [reload]);

  const patch = async (p: Record<string, unknown>, note: string) => {
    try {
      const r = await api.updateMatter(matterId, p);
      setMatter(r.matter);
      setMsg(note);
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const upload = async (files: FileList | MaterialFile[] | null, mode: "import" | "mount") => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setMsg("");
    // 逐个处理：一份失败（例如带密级标志被拒）不影响其余文件，结果逐条告诉律师
    const lines: string[] = [];
    try {
      for (const f of Array.from(files)) {
        try {
          const r: any = mode === "import" ? await api.importMaterial(matterId, f) : await api.mountMaterial(matterId, f);
          const how = mode === "import" ? "已添加（加密保存一份副本，原文件不改动）" : "已关联（只读引用原文件，不复制）";
          lines.push(`${f.name} ${how}，${Number(r.chars ?? 0).toLocaleString()} 字${r.marking_notice ? `。${r.marking_notice}` : ""}`);
        } catch (e) {
          lines.push(`${f.name} 未添加：${(e as Error).message}`);
        }
      }
      setMsg(lines.join("\n"));
      reload();
    } finally {
      setBusy(false);
    }
  };

  // 让助手填审阅表：表格审阅方法，表编号作方法参数，材料为表里的材料（照常先估价、确认）
  const fillTable = async (t: TableView) => {
    if (!matter) return;
    setBusy(true);
    setMsg("");
    try {
      setSheet(
        await prepareStart(
          matter,
          { goal: `按审阅表《${t.title}》逐份材料、逐列填写，每格附原文；已核的格子不改`, scenario: "a1.agent_task", documentIds: t.document_version_ids, choice: value.choice },
          { skill: "tabular-review", label: "表格审阅", skillArgs: { table_id: t.table_id } },
        ),
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 问这张表（v9.4 第 21 批，C1 §3.3 跨表对话）：同一方法的问表模式，只依据表里的格子回答，不改表
  const askTable = async (t: TableView, question: string) => {
    if (!matter) return;
    setBusy(true);
    setMsg("");
    try {
      setSheet(
        await prepareStart(
          matter,
          { goal: `只依据审阅表《${t.title}》里的格子回答：${question}（每个结论写明材料与列，没核的格子标待核；不改表）`, scenario: "a1.agent_task", documentIds: t.document_version_ids, choice: value.choice },
          { skill: "tabular-review", label: "问这张表", skillArgs: { table_id: t.table_id, mode: "问表" } },
        ),
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!matter) return;
    setBusy(true);
    setMsg("");
    try {
      const v = value.documentIds.length === 0 && value.scenario !== "a1.agent_task" ? { ...value, documentIds: docs.filter((d) => !d.quarantined_at).map((d) => d.document_version_id) } : value;
      setSheet(await prepareStart(matter, v, { docNames: docs.filter((d) => v.documentIds.includes(d.document_version_id)).map((d) => d.filename) }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!matter) {
    return (
      <main className="main">
        <div className="main-wide">{msg ? <div className="banner banner-red">{msg}</div> : <p className="muted">载入中…</p>}</div>
      </main>
    );
  }
  if (workbench) {
    return (
      <ReviewWorkbench
        matterId={matterId}
        documentVersionId={workbench.doc}
        agreement={{ stance: matter?.stance ? stanceLabel(matter.stance) : null, jurisdiction: matter?.jurisdiction ? jurisdictionLabel(matter.jurisdiction) : null }}
        readOnly={matter?.lifecycle !== undefined && matter.lifecycle !== "active"}
        backLabel="← 返回事项"
        onClose={() => {
          setWorkbench(null);
          reload();
        }}
      />
    );
  }
  // 已删除的事项：只显示删除回执（名称已替换为占位，内容已删除）
  if (matter.lifecycle === "purged") {
    return (
      <main className="main">
        <div className="main-wide">
          <h1 className="page-title">{matter.title}</h1>
          <MatterLifecyclePanel matter={matter} onChanged={reload} />
        </div>
      </main>
    );
  }
  const closed = matter.lifecycle === "closed";
  const basis: MatterBasis = matter.basis ?? {
    engagement: matter.consent_status === "agreed" || matter.consent_status === "not_required" ? "confirmed" : "pending",
    personal_info: matter.consent_status === "agreed" || matter.consent_status === "not_required" ? "confirmed" : "pending",
    sensitive: "not_applicable",
    subprocessor: matter.consent_status === "agreed" || matter.consent_status === "not_required" ? "confirmed" : "pending",
  };
  return (
    <main className="main">
      <div className="main-wide">
        <Breadcrumb items={[{ label: "事项", href: "/matters" }, { label: matter.title }]} />
        <div className="page-head">
          <h1 className="page-title">{matter.title}</h1>
          <div className="page-head-actions">
            {!closed && (
              <button className="btn" aria-expanded={composerOpen || !!value.goal.trim()} onClick={() => setComposerOpen((v) => !v || !!value.goal.trim())}>
                发起任务
              </button>
            )}
            {!closed && !matter.is_sample && (
              <button className="btn-ghost" onClick={() => nav(`/reminders/new/${encodeURIComponent(matterId)}`)}>
                设提醒
              </button>
            )}
          </div>
        </div>
        {matter.is_sample && (
          <div className="banner banner-gray banner-inline">
            {sampleBannerText(
              matter,
              (() => {
                // 诉讼示例按本机“整理案卷”任务的状态说明（余项续复核 RC-B-13）
                const cf = runs.find((r) => r.scenario === "s2.case_file");
                return !cf ? null : cf.status === "succeeded" || cf.status === "partial" ? "done" : ["failed", "cancelled"].includes(cf.status) ? "failed" : "running";
              })(),
            )}
            <div className="banner-actions">
              <button
                className="btn btn-sm"
                onClick={() =>
                  void api
                    .removeSample(matterId)
                    .then(() => nav("/matters"))
                    .catch((e) => setMsg((e as Error).message))
                }
              >
                移除示例
              </button>
            </div>
          </div>
        )}
        {/* 结案后只读（复核 C-B11）：事项头的修改入口不再出现，内核同样拒绝 */}
        <MatterHeader
          matter={matter}
          policy={policy}
          onParties={() => setTab("parties")}
          {...(closed
            ? {}
            : {
                onEditBasis: () => setBasisOpen(true),
                onToggleFullPseudonym: (on: boolean) => void patch({ full_pseudonym: on }, on ? "已开启全部化名：机构名称也替换为代号（留痕）" : "已关闭全部化名（留痕）"),
                onClearRefusal: () => void patch({ consent_status: "pending" }, "已清除“当事人拒绝云端处理”的记录（留痕）：请按回执核实四项依据"),
                onConsentNotice: () =>
                  void api
                    .consentNotice(matterId)
                    .then((r) => {
                      setMsg(`${r.filename}：${r.note}（见“交付件 · 草稿”）`);
                      notifyDataChanged();
                    })
                    .catch((e) => setMsg((e as Error).message)),
              })}
        />
        {closed && (
          <div className="banner banner-orange matter-closed-banner">
            <span>本事项已结案（只读），保留至 {String(matter.retention_until ?? "").slice(0, 10)}{matter.legal_hold ? `；法律保全：${matter.legal_hold_reason ?? ""}` : ""}。</span>
            <button className="btn-link" onClick={() => setTab("lifecycle")}>结案与删除</button>
          </div>
        )}
        {!closed && (composerOpen || !!value.goal.trim()) && <div className="matter-composer has-text">
          <Composer
            autoFocus
            matterId={matterId}
            stance={matter?.stance}
            documents={docs.filter((d) => !d.quarantined_at)}
            policy={policy}
            value={value}
            onChange={setValue}
            onImport={(f) => void upload(f, "import")}
            onSubmit={() => void submit()}
            busy={busy}
            onPickScenario={(c) => nav(`/start/${c.id}/${matterId}`)}
            placeholder="在本事项内发起任务，例如：核验起诉状引用的法条是否现行有效"
          />
        </div>}
        {msg && <p className="muted" style={{ whiteSpace: "pre-line" }}>{msg}</p>}
        {/* 事项页标签（v9.4 U1 #9）：日常五个；当事人名单、数据去向记录、结案与删除收进“⋯” */}
        <div className="tabs tabs-line" role="tablist" aria-label="事项">
          {(
            [
              ["board", "概览"],
              ["materials", `材料（${docs.length}）`],
              ["facts", "事实"],
              // “任务”改名“AI 记录”（C1 §3.2）：它是 AI 运行流水，待办在概览里
              ["runs", `AI 记录（${runs.length}）`],
              ["deliverables", "交付件"],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
          {(tab === "parties" || tab === "egress" || tab === "lifecycle") && (
            <button role="tab" aria-selected className="tab active">{tab === "parties" ? "当事人名单" : tab === "egress" ? "数据去向记录" : "结案与删除"}</button>
          )}
          <span className="spacer" />
          <span className="tab-more-wrap" ref={moreRef}>
            <button className="tab tab-more" aria-haspopup="menu" aria-expanded={moreOpen} aria-label="更多：当事人名单、数据去向记录、结案与删除" onClick={() => setMoreOpen((v) => !v)}>
              ⋯
            </button>
            {moreOpen && (
              <div className="popover tab-more-menu" role="menu">
                {(
                  [
                    ["parties", "当事人名单"],
                    ["egress", "数据去向记录"],
                    ["lifecycle", "结案与删除"],
                  ] as [Tab, string][]
                ).map(([k, l]) => (
                  <button key={k} role="menuitem" className="menu-item" onClick={() => { setTab(k); setMoreOpen(false); }}>
                    <span className="menu-label">{l}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        </div>
        {tab === "materials" && (
          <section>
            {docs.length > 0 && (
              <div className="wb-doc-view mat-view" role="group" aria-label="材料显示方式">
                <button aria-pressed={matView === "list"} className={`wb-view-btn${matView === "list" ? " active" : ""}`} onClick={() => setMatView("list")}>列表</button>
                <button aria-pressed={matView === "table"} className={`wb-view-btn${matView === "table" ? " active" : ""}`} onClick={() => setMatView("table")}>表格审阅</button>
              </div>
            )}
            {matView === "table" && docs.length > 0 && <TableReview matterId={matter.matter_id} docs={docs} readOnly={closed} initialTable={tableFocus} onFill={(t) => void fillTable(t)} onAsk={(t, q) => void askTable(t, q)} onExported={() => void reload()} />}
            {matView === "list" && !closed && <div
              className="upload-zone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void upload(e.dataTransfer.files, "import");
              }}
            >
              {/* 律师语言（Y4 MT-3 / 10-13 P1-5）：说清楚“复制一份加密保存”与“只引用原文件”的区别 */}
              把文件拖到这里添加（加密保存一份副本，原文件不改动），或
              <button className="btn-link" disabled={busy} onClick={() => void pickMaterials(importRef.current, (f) => upload(f, "import"))}>选择文件</button>
              ；也可以
              <button className="btn-link" disabled={busy} onClick={() => void pickMaterials(mountRef.current, (f) => upload(f, "mount"))}>只引用、不复制</button>
              <input ref={importRef} type="file" multiple hidden onChange={(e) => void upload(e.target.files, "import")} />
              <input ref={mountRef} type="file" multiple hidden onChange={(e) => void upload(e.target.files, "mount")} />
            </div>}
            {matView === "list" && docs.length > 0 && (
              <table className="data">
                <thead><tr><th>文件</th><th>用途</th><th>初判</th><th>读取</th><th>审查意见</th><th>时间</th></tr></thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.document_version_id}>
                      <td title={d.storage_mode === "mount" ? "只引用原文件（未复制）" : "已加密保存副本"}>{d.filename}{d.storage_mode === "mount" && <span className="tag tag-gray">引用</span>}</td>
                      <td>
                        {/* 材料用途（Y4 §5 D-4）：我方 / 对方 / 参考，写进任务的材料清单 */}
                        <RolePills
                          name={d.filename}
                          value={d.role}
                          disabled={closed}
                          onChange={(v) => {
                            void api
                              .setMaterialRole(d.document_version_id, v)
                              .then(reload)
                              .catch((err) => setMsg((err as Error).message));
                          }}
                        />
                      </td>
                      <td title={`${(Number(d.size_bytes ?? 0) / 1024).toFixed(1)} KB · 本机按文件名与开头文字判断，仅供参考`}>
                        {triage.get(d.document_version_id) ? (
                          <>
                            {triageText(triage.get(d.document_version_id)!)}
                            {!closed && !matter.is_sample && triageSuggestion(triage.get(d.document_version_id)!, matter) && (
                              <button className="btn-link mat-suggest" onClick={() => nav(`/start/${triageSuggestion(triage.get(d.document_version_id)!, matter)!.id}/${matterId}`)}>
                                {triageSuggestion(triage.get(d.document_version_id)!, matter)!.title}
                              </button>
                            )}
                          </>
                        ) : (
                          `${(Number(d.size_bytes ?? 0) / 1024).toFixed(1)} KB`
                        )}
                      </td>
                      <td>{d.quarantined_at ? <span className="tag tag-warn">已隔离（国家秘密标志）</span> : parseFlagsText(d.quality_flags ?? [])}</td>
                      <td>
                        {review.get(d.document_version_id) ? (
                          <button className="btn-link" onClick={() => setWorkbench({ doc: d.document_version_id })}>
                            {review.get(d.document_version_id)!.total} 项{review.get(d.document_version_id)!.open > 0 ? `（待处理 ${review.get(d.document_version_id)!.open}）` : ""}
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="nowrap" title={fmtTime(d.created_at)}>{fmtWhen(d.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {matView === "list" && review.get(null) && (
              <p className="muted">
                另有 {review.get(null)!.total} 项审查意见未关联到具体合同：
                <button className="btn-link" onClick={() => setWorkbench({ doc: null })}>逐项处理</button>
              </p>
            )}
          </section>
        )}
        {tab === "runs" && (
          <section>
            {runs.length === 0 && <p className="muted">还没有 AI 记录。</p>}
            {runs.length > 0 && (
              <table className="data">
                <thead><tr><th>任务</th><th>状态</th><th>模式</th><th>发起</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.run_id} className="row-link" onClick={() => nav(`/run/${r.run_id}/${matterId}`)}>
                      <td>{r.title ? r.title : `${SCENARIO_LABELS[r.scenario] ?? r.scenario}${r.goal ? ` · ${String(r.goal).slice(0, 40)}` : ""}`}</td>
                      <td>{RUN_STATUS_LABELS[r.status] ?? r.status}</td>
                      <td>{r.mode ? (MODE_LABELS[r.mode as keyof typeof MODE_LABELS] ?? r.mode) : "—"}</td>
                      <td className="nowrap" title={fmtTime(r.created_at)}>{fmtWhen(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
        {tab === "board" && (
          <MatterBoard
            matter={matter}
            runs={runs}
            onChanged={reload}
            onGo={(t) => {
              // 待核清单的去处（v9.4 第 21 批）：事实标签、材料的表格审阅、审查工作台
              if ("tab" in t && t.tab === "facts") setTab("facts");
              else if ("tab" in t && t.tab === "materials") {
                setTab("materials");
                setMatView("table");
                setTableFocus(t.table_id);
              } else if ("workbench" in t) setWorkbench({ doc: t.workbench });
            }}
          />
        )}
        {tab === "deliverables" && <MatterDeliverables matterId={matterId} />}
        {tab === "facts" && <FactsPanel matterId={matterId} docs={docs} readOnly={closed} />}
        {tab === "parties" && <PartiesPanel matterId={matterId} onChanged={reload} readOnly={closed} />}
        {tab === "egress" && <MatterEgress matterId={matterId} />}
        {tab === "lifecycle" && <MatterLifecyclePanel matter={matter} onChanged={reload} />}
      </div>
      {basisOpen && (
        <BasisDialog
          basis={basis}
          endpoint={matter.model_endpoint}
          onClose={() => setBasisOpen(false)}
          onSave={(b) => {
            setBasisOpen(false);
            // 同意状态由内核按四项派生（不由界面直接改写——复核 S5-A09）
            void patch({ basis: b }, basisComplete(b) ? "四项授权已齐：可以用 AI 和联网查询（已记录）" : "还有授权待确认（已记录）：本事项暂时只能用不联网的本机功能");
          }}
        />
      )}
      {sheet && <RunSheet pending={sheet} onClose={() => setSheet(null)} />}
    </main>
  );
}

function BasisDialog({ basis, endpoint, onClose, onSave }: { basis: MatterBasis; endpoint: string; onClose: () => void; onSave: (b: MatterBasis) => void }) {
  const [b, setB] = useState(basis);
  return (
    <Modal title="四项依据" onClose={onClose} wide>
      <p className="muted">四项依据分别记录；任一项“待确认”时，本事项只能用不需要联网的本机功能。改动都有记录。</p>
      <BasisEditor basis={b} endpoint={endpoint} onChange={setB} />
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>取消</button>
        <button className="btn-primary" onClick={() => onSave(b)}>保存</button>
      </div>
    </Modal>
  );
}

function MatterEgress({ matterId }: { matterId: string }) {
  const [records, setRecords] = useState<EgressRecord[] | null>(null);
  const [unresolved, setUnresolved] = useState<any[]>([]);
  useEffect(() => {
    api.egressRecords({ matterId }).then((r) => setRecords(r.records)).catch(() => setRecords([]));
    api.egressUnresolved(matterId).then((r) => setUnresolved(r.records)).catch(() => {});
  }, [matterId]);
  if (!records) return <p className="muted">载入中…</p>;
  return (
    <section>
      {unresolved.length > 0 && <div className="banner banner-orange">有 {unresolved.length} 条记录不确定是否已经发出（发送途中软件中断），请在下面逐条核实。</div>}
      {records.length === 0 && <p className="muted">本事项还没有发出过任何内容：原件与成果都在这台电脑上。</p>}
      {records.length > 0 && (
        <table className="data">
          <thead><tr><th>时间</th><th>去向</th><th>结果</th><th>字数</th><th>代号</th><th>说明</th></tr></thead>
          <tbody>
            {records.map((r) => {
              let note: any = {};
              try {
                note = JSON.parse(r.note ?? "{}");
              } catch {
                note = {};
              }
              return (
                <tr key={r.record_id}>
                  <td className="nowrap" title={fmtTime(r.created_at)}>{fmtWhen(r.created_at)}</td>
                  <td>{DEST_LABELS[r.destination_kind] ?? r.destination_kind}</td>
                  <td>{r.outcome === "blocked" ? "已拦截" : r.outcome === "failed" ? "失败" : r.outcome === "unknown" ? "结果不明" : "已发出"}</td>
                  <td>{r.chars.toLocaleString()}</td>
                  <td>{Object.values(r.pseudonym_counts ?? {}).reduce((a: number, b: any) => a + Number(b), 0)}</td>
                  <td>{note.reason ? reasonLabel(note.reason) : note.purpose === "search" ? "检索" : note.purpose === "fetch" ? "抓取" : note.purpose === "model" ? "推理" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
