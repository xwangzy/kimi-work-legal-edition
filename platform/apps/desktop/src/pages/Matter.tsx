/**
 * 事项页（第 03 篇 §4.4 事项头常显；材料、任务、看板、当事人词典、数据去向）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, pickMaterials, type EgressRecord, type Matter, type MaterialFile, type MatterBasis, type RunPolicyView } from "../api.ts";
import { nav } from "../App.tsx";
import { Composer, type ComposerValue } from "../components/Composer.tsx";
import { BasisEditor, basisComplete, MatterHeader } from "../components/MatterHeader.tsx";
import { Modal } from "../components/Modal.tsx";
import { defaultChoice } from "../components/ModeSelector.tsx";
import { PartiesPanel } from "../components/Parties.tsx";
import { prepareStart, RunSheet, type PendingStart } from "../components/RunSheet.tsx";
import { reasonLabel } from "../components/DataFlow.tsx";
import { DEST_LABELS, fmtTime, RUN_STATUS_LABELS, SCENARIO_LABELS, parseFlagsText } from "../lib/labels.ts";
import { FactsPanel } from "../components/FactsPanel.tsx";
import { decideMatterTab } from "../lib/matter-tab.ts";
import { sampleBannerText } from "../lib/scenarios.ts";
import { MatterBoard } from "./Boards.tsx";
import { MatterDeliverables } from "./Deliverables.tsx";
import { MatterLifecyclePanel } from "../components/MatterLifecycle.tsx";
import { ReviewWorkbench } from "../components/ReviewWorkbench.tsx";
import { notifyDataChanged } from "../lib/events.ts";

type Tab = "materials" | "facts" | "runs" | "board" | "deliverables" | "parties" | "egress" | "lifecycle";

export function MatterPage({ matterId }: { matterId: string }) {
  const [matter, setMatter] = useState<Matter | null>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [policy, setPolicy] = useState<RunPolicyView | null>(null);
  // 事项页标签（Z3 评审 IA-4、#10）：打开事项默认停在“概览”；还没有材料的新事项停在“材料”；律师点过标签后不再自动切换
  const [tab, setTabRaw] = useState<Tab>("materials");
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
  const [basisOpen, setBasisOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** 每份材料的审查意见（复核 B3-B20：事项页的工作台入口，跨任务汇总）；null 键 = 未关联合同的意见。 */
  const [review, setReview] = useState<Map<string | null, { total: number; open: number }>>(new Map());
  const [workbench, setWorkbench] = useState<{ doc: string | null } | null>(null);
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

  const submit = async () => {
    if (!matter) return;
    setBusy(true);
    setMsg("");
    try {
      const v = value.documentIds.length === 0 && value.scenario !== "a1.agent_task" ? { ...value, documentIds: docs.filter((d) => !d.quarantined_at).map((d) => d.document_version_id) } : value;
      setSheet(await prepareStart(matter, v));
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
        <div className="page-head">
          <h1 className="page-title">{matter.title}</h1>
          {!closed && !matter.is_sample && (
            <button className="btn-ghost" onClick={() => nav(`/reminders/new/${encodeURIComponent(matterId)}`)}>
              设提醒
            </button>
          )}
        </div>
        {matter.is_sample && (
          <div className="banner banner-gray">
            {sampleBannerText(matter)}
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
        {!closed && <div className="matter-composer">
          <Composer
            matterId={matterId}
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
        <div className="tabs tabs-line">
          {(
            [
              ["board", "概览"],
              ["materials", `材料（${docs.length}）`],
              ["facts", "事实"],
              ["runs", `任务（${runs.length}）`],
              ["deliverables", "交付件"],
              ["parties", "当事人名单"],
              ["egress", "数据去向"],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
          <span className="spacer" />
          {/* 不可逆操作不放在日常浏览路径上：结案与删除收进“⋯”（点 2 次才到删除） */}
          <button className={`tab tab-more${tab === "lifecycle" ? " active" : ""}`} title="结案与删除" aria-label="更多：结案与删除" onClick={() => setTab("lifecycle")}>
            {tab === "lifecycle" ? "结案与删除" : "⋯"}
          </button>
        </div>
        {tab === "materials" && (
          <section>
            {!closed && <div
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
            {docs.length > 0 && (
              <table className="data">
                <thead><tr><th>文件</th><th>用途</th><th>大小</th><th>读取</th><th>审查意见</th><th>时间</th></tr></thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.document_version_id}>
                      <td title={d.storage_mode === "mount" ? "只引用原文件（未复制）" : "已加密保存副本"}>{d.filename}{d.storage_mode === "mount" && <span className="tag tag-gray">引用</span>}</td>
                      <td>
                        {/* 材料用途（Y4 §5 D-4）：我方 / 对方 / 参考，写进任务的材料清单 */}
                        <select
                          aria-label={`${d.filename} 的用途`}
                          value={d.role ?? ""}
                          disabled={closed}
                          onChange={(e) => {
                            const v = e.target.value as "" | "ours" | "theirs" | "reference";
                            void api
                              .setMaterialRole(d.document_version_id, v || null)
                              .then(reload)
                              .catch((err) => setMsg((err as Error).message));
                          }}
                        >
                          <option value="">未标</option>
                          <option value="ours">我方</option>
                          <option value="theirs">对方</option>
                          <option value="reference">参考</option>
                        </select>
                      </td>
                      <td>{(Number(d.size_bytes ?? 0) / 1024).toFixed(1)} KB</td>
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
                      <td className="nowrap">{fmtTime(d.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {review.get(null) && (
              <p className="muted">
                另有 {review.get(null)!.total} 项审查意见未关联到具体合同：
                <button className="btn-link" onClick={() => setWorkbench({ doc: null })}>逐项处理</button>
              </p>
            )}
          </section>
        )}
        {tab === "runs" && (
          <section>
            {runs.length === 0 && <p className="muted">还没有任务。</p>}
            {runs.length > 0 && (
              <table className="data">
                <thead><tr><th>任务</th><th>状态</th><th>模式</th><th>发起</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.run_id} className="row-link" onClick={() => nav(`/run/${r.run_id}/${matterId}`)}>
                      <td>{SCENARIO_LABELS[r.scenario] ?? r.scenario}{r.goal ? ` · ${String(r.goal).slice(0, 40)}` : ""}</td>
                      <td>{RUN_STATUS_LABELS[r.status] ?? r.status}</td>
                      <td>{r.mode ?? "—"}</td>
                      <td>{fmtTime(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
        {tab === "board" && <MatterBoard matter={matter} runs={runs} />}
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
            void patch({ basis: b }, basisComplete(b) ? "四项依据已齐备（留痕）：可使用模型与联网能力" : "依据有待确认项（留痕）：本事项只运行本机能力");
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
      <p className="muted">数据准入分四项记录；任一项“待确认”时，本事项只运行不出站的本机能力。变更留痕。</p>
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
      {unresolved.length > 0 && <div className="banner banner-orange">有 {unresolved.length} 条出站结果不明（预写后中断），已进入人工对账。</div>}
      {records.length === 0 && <p className="muted">本事项尚无出站记录：原件与成果留在这台电脑上。</p>}
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
                  <td>{fmtTime(r.created_at)}</td>
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
