/**
 * 召回评测（律所内）——S8 来源 B“带评测器进所、不带数据出所”（v9.2 §3.3；调研 Y5 §4.2；标注规范 v1 §8）。
 * 三步：标注（选中文字 → 按类别标注）→ 一致性与裁决（两人独立标注后对比、逐组裁决）→ 评测（本机计算、导出只含计数的报告）。
 * 文书原文与标注只在这台电脑上：打开与保存都经系统对话框；离开本页不丢（关闭应用即丢，未保存的请先保存）。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, type EvalAgreement, type EvalCategory, type EvalDecision, type EvalDoc } from "../api.ts";
import { Markdown } from "../components/Markdown.tsx";
import { addSpan, CATEGORY_LABEL, EVAL_CATEGORIES, fmtRatio, mergeDocs, nextPersonId, personsOf, removeSpan, segments, updateSpan } from "../lib/eval-annotate.ts";
import { Select } from "../components/Select.tsx";

interface EvalState {
  docs: EvalDoc[];
  current: number;
  b: EvalDoc[] | null;
  agreement: EvalAgreement | null;
  /** doc_id → 分歧组序号 → 决定。 */
  decisions: Record<string, Record<number, EvalDecision>>;
  dirty: boolean;
}

// 模块内存（不写浏览器存储）：在应用内切换页面不丢，关闭应用即清空
let state: EvalState = { docs: [], current: 0, b: null, agreement: null, decisions: {}, dirty: false };
const listeners = new Set<() => void>();
function setState(patch: Partial<EvalState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function useEvalState(): EvalState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

type Step = "annotate" | "agree" | "evaluate";

export function RecallEvalPanel() {
  const st = useEvalState();
  const [step, setStep] = useState<Step>("annotate");
  const [msg, setMsg] = useState<{ tone: "gray" | "red" | "orange"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const ingest = (results: { kind: string; docs: EvalDoc[] }[]) => {
    const docs = results.flatMap((r) => r.docs);
    if (docs.length === 0) return;
    // 同编号的文书会整份替换（复核 S6A-16）：如实提示替换了几份
    const replaced = docs.filter((d) => st.docs.some((x) => x.doc_id === d.doc_id)).length;
    setState({ docs: mergeDocs(st.docs, docs), dirty: true });
    setMsg({ tone: replaced ? "orange" : "gray", text: `已读入 ${docs.length} 份（文书原文只在这台电脑上）${replaced ? `；其中 ${replaced} 份与已打开的文书同名，已用新读入的内容替换` : ""}。` });
  };
  const open = async () => {
    setMsg(null);
    try {
      const r = await api.evalPick();
      if (r === null) fileInput.current?.click();
      else ingest(r);
    } catch (e) {
      setMsg({ tone: "red", text: (e as Error).message });
    }
  };
  const save = async () => {
    try {
      const r = await api.evalSaveWork(st.docs, `召回评测标注-${new Date().toISOString().slice(0, 10)}.jsonl`);
      if (r) {
        setState({ dirty: false });
        setMsg({ tone: "gray", text: `已保存 ${r.filename}。这个文件含文书原文，请按律所的保密要求保存，评测结束后删除。` });
      }
    } catch (e) {
      setMsg({ tone: "red", text: (e as Error).message });
    }
  };

  return (
    <div className="ev">
      <p className="muted">
        用律所自己的文书检验“发送前替换”漏了多少：两位同事各自标注同一批文书（已结案事项或律所模板），对比一致后由一位律师裁决，再在本机运行评测。
        <b>文书原文与标注只在这台电脑上</b>；导出的报告只有按类别的计数与比例，不含任何原文、文书名或标注内容，由律所自行决定是否交给中软。
        详细规则见《标注规范 v1》。
      </p>
      <div className="ev-bar">
        <button className="btn btn-sm" onClick={() => void open()}>
          打开文书或标注文件…
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept=".jsonl,.txt,.md,.docx,.pdf"
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            try {
              ingest(await Promise.all(files.map((f) => api.evalOpenFile(f))));
            } catch (err) {
              setMsg({ tone: "red", text: (err as Error).message });
            }
          }}
        />
        <button className="btn btn-sm" disabled={st.docs.length === 0} onClick={() => void save()}>
          保存标注…
        </button>
        {st.dirty && st.docs.length > 0 && <span className="pill pill-orange">有未保存的标注</span>}
        <span className="ev-spacer" />
        <div className="tabs" role="tablist" aria-label="评测步骤">
          {(
            [
              ["annotate", "① 标注"],
              ["agree", "② 一致性与裁决"],
              ["evaluate", "③ 评测"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={step === k} className={`tab${step === k ? " active" : ""}`} onClick={() => setStep(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {msg && <div className={`banner banner-${msg.tone}`}>{msg.text}</div>}
      {st.docs.length === 0 ? (
        <div className="panel ev-empty">
          还没有文书。点“打开文书或标注文件…”：可以选 Word、PDF（有文字层）、TXT，也可以选之前保存的标注文件（.jsonl）继续。
        </div>
      ) : step === "annotate" ? (
        <Annotate st={st} />
      ) : step === "agree" ? (
        <Agree st={st} onMsg={setMsg} />
      ) : (
        <Evaluate st={st} onMsg={setMsg} />
      )}
    </div>
  );
}

/** 选区端点 → 正文下标（段元素带 data-s）。 */
function pointOffset(root: HTMLElement, node: Node, off: number): number | null {
  if (!root.contains(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const el = node.parentElement?.closest<HTMLElement>("[data-s]");
    if (!el) return null;
    return Number(el.dataset.s) + off;
  }
  const el = node as HTMLElement;
  // 端点落在段元素本身（复核 S6B-06）：偏移 0 = 段首，否则 = 段尾
  if (el.dataset?.s !== undefined) return Number(el.dataset.s) + (off === 0 ? 0 : (el.textContent?.length ?? 0));
  if (off < el.childNodes.length) {
    const child = el.childNodes[off] as HTMLElement;
    const seg = child.nodeType === Node.ELEMENT_NODE ? child.closest<HTMLElement>("[data-s]") ?? child.querySelector<HTMLElement>("[data-s]") : null;
    return seg ? Number(seg.dataset.s) : null;
  }
  const segs = el.querySelectorAll<HTMLElement>("[data-s]");
  const last = segs[segs.length - 1];
  return last ? Number(last.dataset.s) + (last.textContent?.length ?? 0) : null;
}

function Annotate({ st }: { st: EvalState }) {
  const doc = st.docs[Math.min(st.current, st.docs.length - 1)]!;
  const textRef = useRef<HTMLDivElement | null>(null);
  const [pending, setPending] = useState<{ start: number; end: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [warn, setWarn] = useState("");
  const [party, setParty] = useState("");
  const segs = useMemo(() => segments(doc.text, doc.spans), [doc]);
  const persons = useMemo(() => personsOf(doc), [doc]);

  const replaceDoc = (d: EvalDoc) => {
    const docs = st.docs.slice();
    docs[st.current] = d;
    setState({ docs, dirty: true });
  };
  const apply = (category: EvalCategory) => {
    if (!pending) return;
    const r = addSpan(doc, pending.start, pending.end, category);
    if (!r.ok) {
      setWarn(r.reason);
      return;
    }
    replaceDoc(r.doc);
    setPending(null);
    setWarn("");
    window.getSelection()?.removeAllRanges();
  };
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 在输入框里打字时不当快捷键（复核 S6B-06）
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "Escape") {
        setPending(null);
        return;
      }
      const c = EVAL_CATEGORIES.find((x) => x.hotkey === e.key.toLowerCase());
      if (c) {
        e.preventDefault();
        apply(c.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    setActive(null);
    setPending(null);
    setWarn("");
  }, [st.current]);

  const onMouseUp = () => {
    const sel = window.getSelection();
    const root = textRef.current;
    if (!sel || sel.isCollapsed || !root || !sel.anchorNode || !sel.focusNode) return;
    const a = pointOffset(root, sel.anchorNode, sel.anchorOffset);
    const b = pointOffset(root, sel.focusNode, sel.focusOffset);
    if (a === null || b === null || a === b) return;
    setPending({ start: Math.min(a, b), end: Math.max(a, b) });
    setActive(null);
    setWarn("");
  };
  const act = active !== null ? doc.spans[active] : undefined;

  return (
    <div className="ev-grid">
      <nav className="ev-docs" aria-label="文书">
        {st.docs.map((d, i) => (
          <button key={d.doc_id} className={`ev-doc${i === st.current ? " on" : ""}`} onClick={() => setState({ current: i })}>
            <span className="ev-doc-name">{d.doc_id}</span>
            <span className="muted">{d.spans.length} 处</span>
          </button>
        ))}
      </nav>
      <div className="ev-main">
        <div className="ev-catbar" aria-live="polite">
          {pending ? (
            <>
              <span>
                把“<b>{doc.text.slice(pending.start, pending.end).slice(0, 30)}</b>”标为：
              </span>
              {EVAL_CATEGORIES.map((c) => (
                <button key={c.key} className={`ev-cat ev-tone-${c.tone}`} onClick={() => apply(c.key)} title={`快捷键 ${c.hotkey}`}>
                  {c.label}
                  <kbd>{c.hotkey}</kbd>
                </button>
              ))}
              <button className="btn-link" onClick={() => setPending(null)}>
                取消（Esc）
              </button>
            </>
          ) : (
            <span className="muted">用鼠标选中一段文字，再点类别或按快捷键。点已标注的文字可以修改或删除。</span>
          )}
        </div>
        {warn && <div className="banner banner-orange">{warn}</div>}
        <div ref={textRef} className="ev-text" onMouseUp={onMouseUp}>
          {segs.map((g) => {
            const t = doc.text.slice(g.start, g.end);
            if (g.span < 0) return <span key={g.start} data-s={g.start}>{t}</span>;
            const s = doc.spans[g.span]!;
            const tone = EVAL_CATEGORIES.find((c) => c.key === s.category)?.tone ?? "id";
            return (
              <mark
                key={g.start}
                data-s={g.start}
                data-label={`${CATEGORY_LABEL[s.category] ?? s.category}${s.person_id ? `·${s.person_id}` : ""}`}
                className={`ev-mark ev-tone-${tone}${active === g.span ? " on" : ""}`}
                tabIndex={0}
                onClick={(e) => {
                  if (!window.getSelection()?.isCollapsed) return;
                  e.stopPropagation();
                  setActive(g.span);
                  setPending(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setActive(g.span);
                }}
              >
                {t}
              </mark>
            );
          })}
        </div>
      </div>
      <aside className="ev-side">
        {act ? (
          <div className="panel">
            <div className="section-title ev-st">这一处</div>
            <div className="ev-quote">{doc.text.slice(act.start, act.end)}</div>
            <label className="ev-field">
              类别
              <Select value={act.category} onChange={(v) => replaceDoc(updateSpan(doc, active!, { category: v as EvalCategory }))} options={EVAL_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))} />
            </label>
            {act.category === "person" && (
              <label className="ev-field">
                是谁
                <Select
                  value={act.person_id ?? ""}
                  onChange={(v) => replaceDoc(updateSpan(doc, active!, { person_id: v === "__new" ? nextPersonId(doc.spans) : v }))}
                  options={[...persons.map((p) => ({ value: p.id, label: `${p.id} · ${p.first}（${p.mentions} 处）` })), { value: "__new", label: "另一个人" }]}
                />
              </label>
            )}
            <button
              // 只删本页内存里的一处标注、可以重标：不算危险操作，不用红色（Y4 V-5）
              className="btn-ghost btn-sm"
              onClick={() => {
                replaceDoc(removeSpan(doc, active!));
                setActive(null);
              }}
            >
              删除这一处
            </button>
          </div>
        ) : (
          <div className="panel">
            <div className="section-title ev-st">本文书</div>
            <label className="ev-field">
              来源
              <Select
                value={doc.source}
                onChange={(v) => replaceDoc({ ...doc, source: v })}
                options={[
                  { value: "firm_onsite", label: "律所进所评测" },
                  { value: "public_judgment", label: "公开裁判文书" },
                  { value: "independent_synthetic", label: "独立撰写的仿真材料" },
                  { value: "hard_cases", label: "困难集" },
                ]}
              />
            </label>
            <div className="muted ev-small">
              自然人 {persons.length} 人，标注 {doc.spans.length} 处
            </div>
            <div className="section-title ev-st">当事人名单（模拟律师在事项头填写）</div>
            <ul className="plain-list">
              {doc.known_parties.map((p, i) => (
                <li key={`${p.name}-${i}`}>
                  {p.name}（{p.kind === "person" ? "自然人" : "机构"}）{" "}
                  <button className="btn-link" onClick={() => replaceDoc({ ...doc, known_parties: doc.known_parties.filter((_, j) => j !== i) })}>
                    移除
                  </button>
                </li>
              ))}
            </ul>
            <div className="ev-row">
              <input value={party} onChange={(e) => setParty(e.target.value)} placeholder="名称" aria-label="当事人名称" />
              {(["person", "org"] as const).map((k) => (
                <button
                  key={k}
                  className="btn btn-sm"
                  disabled={!party.trim()}
                  onClick={() => {
                    replaceDoc({ ...doc, known_parties: [...doc.known_parties, { name: party.trim(), kind: k }] });
                    setParty("");
                  }}
                >
                  加{k === "person" ? "自然人" : "机构"}
                </button>
              ))}
            </div>
            <div className="muted ev-small">评测同时报告“有当事人名单”与“只靠规则”两种结果。</div>
          </div>
        )}
      </aside>
    </div>
  );
}

function Agree({ st, onMsg }: { st: EvalState; onMsg: (m: { tone: "gray" | "red" | "orange"; text: string } | null) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const loadB = async (results: { docs: EvalDoc[] }[]) => {
    const b = results.flatMap((r) => r.docs);
    const ag = await api.evalAgreement(st.docs, b);
    setState({ b, agreement: ag, decisions: {} });
    onMsg({ tone: "gray", text: `已对比 ${ag.report.paired} 份。` });
  };
  const pickB = async () => {
    try {
      const r = await api.evalPick();
      if (r === null) fileInput.current?.click();
      else if (r.length) await loadB(r);
    } catch (e) {
      onMsg({ tone: "red", text: (e as Error).message });
    }
  };
  const ag = st.agreement;
  const decide = (docId: string, group: number, d: EvalDecision) => setState({ decisions: { ...st.decisions, [docId]: { ...(st.decisions[docId] ?? {}), [group]: d } } });
  const finish = async () => {
    if (!ag || !st.b) return;
    setBusy(true);
    try {
      const byB = new Map(st.b.map((d) => [d.doc_id, d]));
      let done = 0;
      let left = 0;
      let conflicts = 0;
      const docs = st.docs.slice();
      for (let i = 0; i < docs.length; i++) {
        const a = docs[i]!;
        const b = byB.get(a.doc_id);
        const per = ag.report.per_doc.find((p) => p.doc_id === a.doc_id);
        if (!b || !per || !per.passes) continue;
        const dec = Object.entries(st.decisions[a.doc_id] ?? {}).map(([g, d]) => ({ group: Number(g), decision: d }));
        const r = await api.evalAdjudicate(a, b, dec);
        if (r.undecided.length > 0 || r.problems.length > 0) {
          left += 1;
          continue;
        }
        conflicts += r.person_id_conflicts.length;
        docs[i] = r.doc;
        done += 1;
      }
      setState({ docs, dirty: true, b: null, agreement: null, decisions: {} });
      onMsg({
        tone: left || conflicts ? "orange" : "gray",
        text: `已生成金标准 ${done} 份${left ? `；${left} 份还有未裁决的分歧或标注不合格，保持原样` : ""}${conflicts ? `；有 ${conflicts} 处自然人编号需要在“标注”里手工统一` : ""}。未达标的文书没有合并，请退回重标。记得保存。`,
      });
    } catch (e) {
      onMsg({ tone: "red", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const docA = sel ? st.docs.find((d) => d.doc_id === sel) : undefined;
  const groups = ag && sel ? ag.groups.filter((g) => g.doc_id === sel) : [];
  return (
    <div>
      <p className="muted">
        当前打开的标注当作“甲”，再打开另一位同事对同一批文书的标注文件当作“乙”。冻结条件：字符级 κ ≥ {ag?.report.thresholds.kappa ?? 0.85} 且提及级 F1 ≥ {ag?.report.thresholds.f1 ?? 0.9}；
        未达标的文书退回两人重标，达标的逐组裁决后合成金标准。
      </p>
      <div className="ev-bar">
        <button className="btn btn-sm" onClick={() => void pickB()}>
          打开乙的标注文件…
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept=".jsonl"
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            try {
              await loadB(await Promise.all(files.map((f) => api.evalOpenFile(f))));
            } catch (err) {
              onMsg({ tone: "red", text: (err as Error).message });
            }
          }}
        />
        {ag && (
          <button className="btn-primary btn-sm" disabled={busy} onClick={() => void finish()}>
            按裁决生成金标准
          </button>
        )}
      </div>
      {ag && (
        <>
          <div className="ev-stats">
            <div>
              <b>{fmtRatio(ag.report.pooled_kappa)}</b>
              <span className="muted">字符级 κ（合并）</span>
            </div>
            <div>
              <b>{fmtRatio(ag.report.pooled_f1)}</b>
              <span className="muted">提及级 F1</span>
            </div>
            <div>
              <b>{ag.report.docs_passing}</b>
              <span className="muted">达标</span>
            </div>
            <div>
              <b>{ag.report.docs_failing}</b>
              <span className="muted">未达标（退回重标）</span>
            </div>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>文书</th>
                <th>κ</th>
                <th>F1</th>
                <th>一致 / 只甲 / 只乙</th>
                <th>结论</th>
                <th>裁决</th>
              </tr>
            </thead>
            <tbody>
              {ag.report.per_doc.map((p) => {
                const n = ag.groups.filter((g) => g.doc_id === p.doc_id).length;
                const decided = Object.keys(st.decisions[p.doc_id] ?? {}).length;
                return (
                  <tr key={p.doc_id} className={sel === p.doc_id ? "row-on" : undefined}>
                    <td>{p.doc_id}</td>
                    <td>{p.text_mismatch ? "—" : fmtRatio(p.kappa)}</td>
                    <td>{fmtRatio(p.f1)}</td>
                    <td>
                      {p.agreed} / {p.only_a} / {p.only_b}
                    </td>
                    <td>{p.text_mismatch ? <span className="pill pill-red">正文不同</span> : p.passes ? <span className="pill pill-green">达标</span> : <span className="pill pill-orange">退回重标</span>}</td>
                    <td>
                      {p.passes && n > 0 ? (
                        <button className="btn-link" onClick={() => setSel(p.doc_id)}>
                          {decided}/{n} 组
                        </button>
                      ) : p.passes ? (
                        "无分歧"
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {docA && groups.length > 0 && (
        <>
          <div className="section-title">裁决：{docA.doc_id}</div>
          <div className="ev-groups">
            {groups.map((g) => {
              const d = st.decisions[docA.doc_id]?.[g.group];
              const ctxA = Math.max(0, g.start - 12);
              const ctxB = Math.min(docA.text.length, g.end + 12);
              const side = (spans: typeof g.a) => (spans.length ? spans.map((s) => `${CATEGORY_LABEL[s.category] ?? s.category}“${docA.text.slice(s.start, s.end)}”`).join("；") : "不标");
              return (
                <div key={g.group} className="panel ev-group">
                  <div className="ev-ctx">
                    {docA.text.slice(ctxA, g.start)}
                    <b>{docA.text.slice(g.start, g.end)}</b>
                    {docA.text.slice(g.end, ctxB)}
                  </div>
                  <div className="ev-choice">
                    {(
                      [
                        ["a", `甲：${side(g.a)}`],
                        ["b", `乙：${side(g.b)}`],
                        ["none", "都不对（之后在“标注”里手工处理）"],
                      ] as const
                    ).map(([k, label]) => (
                      <button key={k} className={`q-option${d === k ? " on" : ""}`} aria-pressed={d === k} onClick={() => decide(docA.doc_id, g.group, k)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Evaluate({ st, onMsg }: { st: EvalState; onMsg: (m: { tone: "gray" | "red" | "orange"; text: string } | null) => void }) {
  const [opts, setOpts] = useState({ full_pseudonym: false, case_numbers: false });
  const [md, setMd] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.evalRecall(st.docs, opts);
      setMd(r.markdown);
    } catch (e) {
      onMsg({ tone: "red", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p className="muted">
        用本机随包的替换规则对已标注的 {st.docs.length} 份文书计算召回与误替换（每次用新的随机密钥，不写任何记录）。区间不足 30 份时改报精确区间。
      </p>
      <div className="ev-bar">
        <label className="pill pill-toggle">
          <input type="checkbox" checked={opts.full_pseudonym} onChange={(e) => setOpts({ ...opts, full_pseudonym: e.target.checked })} /> 按“全部化名”评测
        </label>
        <label className="pill pill-toggle">
          <input type="checkbox" checked={opts.case_numbers} onChange={(e) => setOpts({ ...opts, case_numbers: e.target.checked })} /> 案号也替换
        </label>
        <button className="btn-primary btn-sm" disabled={busy} onClick={() => void run()}>
          运行评测
        </button>
        <button
          className="btn btn-sm"
          disabled={busy || !md}
          onClick={async () => {
            try {
              const r = await api.evalSaveReport(st.docs, opts, `召回评测报告-${new Date().toISOString().slice(0, 10)}.md`);
              if (r) onMsg({ tone: "gray", text: `已导出 ${r.filename}：只含计数、比例与区间。` });
            } catch (e) {
              onMsg({ tone: "red", text: (e as Error).message });
            }
          }}
        >
          导出报告…
        </button>
      </div>
      {md && (
        <div className="panel ev-report">
          <Markdown text={md} />
        </div>
      )}
    </div>
  );
}
