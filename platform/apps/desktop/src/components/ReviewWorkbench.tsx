/**
 * 合同审查工作台（UIUX P0-3；v9 第 03 篇 §6.1“风险卡与替代条款 → 律师接受/修改/拒绝 → 文书引擎写原生修订”）。
 *
 * 左：合同原文，风险卡引用的条款高亮（点击定位到卡）；右：风险卡（重大 → 一般 → 提示，同级按条款顺序），
 * 每张卡“接受 / 修改后接受 / 不采纳”，已决定的可撤回；顶部：进度与“生成修订稿”。
 * 卡片文字是事项令牌形态，这里按事项令牌表还原显示（只在本机界面）；律师改写的条款按原文保存。
 * 修订稿由内核按已接受的卡在原件副本上写原生修订——有卡定位不到时整体不写，列出是哪几张，律师可跳过后再生成。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { api, type RiskCard, type RiskProgress } from "../api.ts";
import { CITE_STATE_LABELS } from "../lib/labels.ts";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";

const SEVERITY: Record<RiskCard["severity"], { label: string; cls: string }> = {
  high: { label: "重大", cls: "sev-high" },
  mid: { label: "一般", cls: "sev-mid" },
  low: { label: "提示", cls: "sev-low" },
};
const STATUS_LABEL: Record<RiskCard["status"], string> = { proposed: "待处理", accepted: "已接受", modified: "已修改后接受", rejected: "不采纳" };
const CATEGORY_LABEL: Record<RiskCard["category"], string> = { legal: "法律风险", commercial: "商业条件", both: "法律 + 商业" };
type Filter = "all" | "open" | "accepted" | "rejected";

/** 条款号显示（复核 B3-B21）：Agent 可能写“8.2”“第 8.2 条（逾期付款）”或“违约责任”，不重复加“第…条”。 */
export function clauseLabel(ref: string | null | undefined): string {
  const r = (ref ?? "").trim();
  if (!r) return "";
  if (/^第/.test(r)) return r;
  return /^[\d.、一二三四五六七八九十百]+$/.test(r) ? `第 ${r} 条` : r;
}

interface Props {
  matterId: string;
  /** 合同（文档版本）；null = 未关联合同的意见（只能逐张决定，不参与修订稿）。 */
  documentVersionId: string | null;
  /** 从某次任务进入时给出：可切换“只看本次任务”；缺省显示这份合同在本事项所有任务里的意见（复核 B3-B20）。 */
  runId?: string;
  /** 事项已结案（只读）：可以查看，不能决定与生成修订稿（复核 C-B11）。 */
  readOnly?: boolean;
  backLabel?: string;
  onClose: () => void;
  /** 修订稿生成后（成果已登记）通知上层刷新成果列表。 */
  onRedline?: (artifactVersionId: string) => void;
}

export function ReviewWorkbench({ matterId, documentVersionId, runId, readOnly = false, backLabel = "← 返回任务", onClose, onRedline }: Props) {
  const [onlyRun, setOnlyRun] = useState(false);
  const runFilter = onlyRun && runId ? runId : undefined;
  const [cards, setCards] = useState<RiskCard[]>([]);
  const [progress, setProgress] = useState<RiskProgress | null>(null);
  const [doc, setDoc] = useState<{ filename: string; paragraphs: string[] } | null>(null);
  const [map, setMap] = useState<Map<string, string | null>>(new Map());
  const [filter, setFilter] = useState<Filter>("all");
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "err"; text: string; conflicts?: { card_id: string | null; detail?: string }[]; artifact?: string } | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  const load = useCallback(async () => {
    const r = await api.riskCards(matterId, { document_version_id: documentVersionId, ...(runFilter ? { run_id: runFilter } : {}) });
    setCards(r.cards);
    setProgress(r.progress);
    const all = r.cards.flatMap((c) => [c.anchor_text, c.issue, c.suggestion ?? "", c.fallback ?? "", c.assumptions ?? ""]).join("\n");
    if (all.includes("〔")) setMap(await restoreTokens(matterId, all));
  }, [matterId, documentVersionId, runFilter]);

  useEffect(() => {
    void load().catch((e) => setMsg({ tone: "err", text: (e as Error).message }));
    if (!documentVersionId) {
      setDoc(null);
      return;
    }
    void api
      .materialText(documentVersionId)
      .then(setDoc)
      .catch(() => setDoc(null));
  }, [load, documentVersionId]);

  const plain = useCallback((s: string | null | undefined) => (s ? restoredPlain(s, map) : ""), [map]);
  const visible = cards.filter((c) => (filter === "all" ? true : filter === "open" ? c.status === "proposed" : filter === "accepted" ? c.status === "accepted" || c.status === "modified" : c.status === "rejected"));

  // 原文高亮：已定位的卡按还原后的引文在段落中标出
  const marks = useMemo(
    () =>
      cards
        .filter((c) => c.anchor_status === "located" || c.anchor_status === "ambiguous")
        .map((c) => ({ id: c.card_id, text: plain(c.anchor_text), sev: c.severity, status: c.status }))
        .filter((m) => m.text.length >= 2),
    [cards, plain],
  );

  const decide = async (card: RiskCard, decision: "accept" | "modify" | "reject" | "reset", finalText?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.decideRiskCard(matterId, card.card_id, decision, finalText);
      setEditing(null);
      await load();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const redline = async (skip: string[] = []) => {
    if (!documentVersionId) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.buildRedline(matterId, documentVersionId, { ...(runFilter ? { run_id: runFilter } : {}), ...(skip.length ? { skip_card_ids: skip } : {}) });
      if (r.status === "applied") {
        setMsg({ tone: "ok", text: `已生成修订稿《${r.filename}》：${r.applied} 处修改以 Word 原生修订和批注写入（原件未改动）${r.skipped.length ? `；跳过 ${r.skipped.length} 项` : ""}。`, artifact: r.artifact_version_id });
        onRedline?.(r.artifact_version_id);
      } else if (r.reason === "not_docx") {
        setMsg({ tone: "warn", text: "这份材料不是 Word 文件，不能直接写修订。可让 Agent 把已接受的修改整理成《修订说明》。" });
      } else if (r.reason === "document_version_superseded") {
        setMsg({ tone: "warn", text: "这份合同已有更新的版本，请在新版本上重新审查后再生成修订稿。" });
      } else {
        setMsg({
          tone: "warn",
          text: `有 ${r.conflicts.length} 项修改无法在合同中准确定位（原文不一致、出现多处或相互重叠），修订稿未生成。`,
          conflicts: r.conflicts.map((c) => ({ card_id: c.card_id, ...(c.detail ? { detail: c.detail } : {}) })),
        });
      }
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const focusCard = (id: string) => {
    setActive(id);
    setFilter("all");
    requestAnimationFrame(() => cardRefs.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const accepted = progress?.accepted ?? 0;
  const allDecided = !!progress && progress.total > 0 && progress.decided === progress.total;

  return (
    <div className="wb">
      <div className="wb-head">
        <div className="wb-title">
          <button className="btn-link" onClick={onClose}>{backLabel}</button>
          <h1 className="page-title">审查工作台{documentVersionId ? (doc ? ` · ${doc.filename}` : "") : " · 未关联合同的意见"}</h1>
          {progress && (
            <div className="wb-progress" aria-live="polite">
              已处理 {progress.decided}/{progress.total}
              {progress.high_open > 0 ? <span className="sev-text-high"> · {progress.high_open} 项重大风险待处理</span> : null}
            </div>
          )}
        </div>
        <div className="wb-head-actions">
          {runId && (
            <label className="lifecycle-check">
              <input type="checkbox" checked={onlyRun} onChange={(e) => setOnlyRun(e.target.checked)} aria-label="只看本次任务提出的意见" />
              只看本次任务
            </label>
          )}
          {readOnly && <span className="muted">事项已结案（只读）</span>}
          {documentVersionId && !readOnly && (
            <button className={allDecided ? "btn-primary" : "btn-ghost"} disabled={busy || accepted === 0} onClick={() => void redline()} title={accepted === 0 ? "先接受或修改后接受至少一项" : undefined}>
              {/* 勾选“只看本次任务”时修订稿也只含本次任务的卡（复核 C-B06）：文案写明 */}
              生成修订稿{accepted > 0 ? `（${runFilter ? "本次任务 " : ""}${accepted} 项）` : ""}
            </button>
          )}
        </div>
      </div>
      {msg && (
        <div className={`banner ${msg.tone === "err" ? "banner-red" : msg.tone === "warn" ? "banner-orange" : "banner-green"}`}>
          {msg.text}
          {msg.artifact && (
            <div className="banner-actions">
              <button className="btn-primary" onClick={onClose}>查看修订稿</button>
            </div>
          )}
          {msg.conflicts && msg.conflicts.length > 0 && (
            <>
              <ul className="wb-conflicts">
                {msg.conflicts.map((c, i) => {
                  const card = cards.find((x) => x.card_id === c.card_id);
                  return (
                    <li key={i}>
                      {card ? <button className="btn-link" onClick={() => focusCard(card.card_id)}>{card.clause_ref ? clauseLabel(card.clause_ref) : `第 ${card.seq} 项`}：{plain(card.issue).slice(0, 40)}</button> : "（未知卡片）"}
                    </li>
                  );
                })}
              </ul>
              <div className="banner-actions">
                <button className="btn-ghost" disabled={busy} onClick={() => void redline(msg.conflicts!.map((c) => c.card_id).filter((x): x is string => !!x))}>
                  跳过这 {msg.conflicts.length} 项，生成其余修订
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="wb-body">
        <section className="wb-doc" aria-label="合同原文">
          {!documentVersionId && <p className="muted">这些意见没有关联到具体合同（例如条款来自任务说明或聊天内容）：可以逐张决定，不参与修订稿。</p>}
          {documentVersionId && !doc && <p className="muted">正在载入合同原文…</p>}
          {doc?.paragraphs.map((p, i) => (p.trim() ? <p key={i}>{highlight(p, marks, active, focusCard)}</p> : <br key={i} />))}
        </section>
        <section className="wb-cards" aria-label="风险卡">
          <div className="wb-filters" role="tablist">
            {(
              [
                ["all", `全部 ${cards.length}`],
                ["open", `待处理 ${cards.filter((c) => c.status === "proposed").length}`],
                ["accepted", `已接受 ${accepted}`],
                ["rejected", `不采纳 ${cards.filter((c) => c.status === "rejected").length}`],
              ] as [Filter, string][]
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={filter === k} className={`chip${filter === k ? " active" : ""}`} onClick={() => setFilter(k)}>
                {l}
              </button>
            ))}
          </div>
          {visible.length === 0 && <p className="muted">没有符合条件的风险项。</p>}
          {visible.map((c) => {
            const sev = SEVERITY[c.severity];
            const open = active === c.card_id;
            return (
              <div
                key={c.card_id}
                ref={(el) => {
                  if (el) cardRefs.current.set(c.card_id, el);
                }}
                className={`rc ${sev.cls}${open ? " open" : ""} rc-${c.status}`}
              >
                <button className="rc-head" aria-expanded={open} onClick={() => setActive(open ? null : c.card_id)}>
                  <span className={`rc-sev ${sev.cls}`}>{sev.label}</span>
                  {c.clause_ref && <span className="rc-ref">{clauseLabel(c.clause_ref)}</span>}
                  <span className="rc-issue">{plain(c.issue)}</span>
                  <span className={`rc-status rc-status-${c.status}`}>{c.status === "accepted" && !c.suggestion ? "已知悉" : STATUS_LABEL[c.status]}</span>
                </button>
                {open && (
                  <div className="rc-body">
                    <div className="rc-row">
                      <span className="rc-k">问题判断</span>
                      <span>
                        {plain(c.issue)}
                        <span className="tag tag-gray">{CATEGORY_LABEL[c.category]}</span>
                        {c.needs_client_decision && <span className="tag tag-beta">需客户决定</span>}
                      </span>
                    </div>
                    <div className="rc-row">
                      <span className="rc-k">合同原文</span>
                      <span className="rc-quote">
                        {plain(c.anchor_text)}
                        {c.anchor_status === "not_found" && <span className="rc-warn">未能在合同中找到这段原文，生成修订稿时需跳过，可在 Word 中手工修改</span>}
                        {c.anchor_status === "ambiguous" && <span className="rc-warn">这段原文在合同中出现多处，生成时按条款号定位</span>}
                        {c.anchor_status === "cross_paragraph" && <span className="rc-warn">这段原文跨了段落，修订稿不能自动写入，生成时需跳过，可在 Word 中手工修改</span>}
                      </span>
                    </div>
                    {(c.status === "modified" ? c.final_text : c.suggestion) && (
                      <div className="rc-row">
                        <span className="rc-k">{c.status === "modified" ? "你的修改" : "建议改为"}</span>
                        <span className="rc-suggest">{c.status === "modified" ? c.final_text : plain(c.suggestion)}</span>
                      </div>
                    )}
                    {c.basis.length > 0 && (
                      <div className="rc-row">
                        <span className="rc-k">依据</span>
                        <span>
                          {c.basis.map((b, i) => (
                            <span key={i} className="rc-basis">
                              《{b.matched ?? b.law}》{b.article ? `第 ${b.article} 条` : ""}
                              <span className={`cite-state cite-${b.check}`}>{CITE_STATE_LABELS[b.check] ?? (b.check === "unchecked" ? "未核对" : b.check)}</span>
                            </span>
                          ))}
                        </span>
                      </div>
                    )}
                    {c.fallback && (
                      <div className="rc-row">
                        <span className="rc-k">可退让方案</span>
                        <span>{plain(c.fallback)}</span>
                      </div>
                    )}
                    {c.assumptions && (
                      <div className="rc-row">
                        <span className="rc-k">前提</span>
                        <span className="muted">{plain(c.assumptions)}</span>
                      </div>
                    )}
                    {readOnly ? null : editing?.id === c.card_id ? (
                      <div className="rc-edit">
                        <textarea rows={4} value={editing.text} onChange={(e) => setEditing({ id: c.card_id, text: e.target.value })} aria-label="修改后的条款文本" />
                        <div className="rc-actions">
                          <button className="btn-primary" disabled={busy || !editing.text.trim()} onClick={() => void decide(c, "modify", editing.text.trim())}>保存并接受</button>
                          <button className="btn-ghost" disabled={busy} onClick={() => setEditing(null)}>取消</button>
                        </div>
                      </div>
                    ) : c.status === "proposed" ? (
                      <div className="rc-actions">
                        {c.suggestion ? (
                          <button className="btn-primary" disabled={busy} onClick={() => void decide(c, "accept")}>接受</button>
                        ) : (
                          <button className="btn-primary" disabled={busy} title="这项没有建议文本：知悉、合同不改动（不写进修订稿）" onClick={() => void decide(c, "accept")}>知悉（不改动）</button>
                        )}
                        <button className="btn-ghost" disabled={busy} onClick={() => setEditing({ id: c.card_id, text: plain(c.suggestion) || plain(c.anchor_text) })}>修改后接受</button>
                        <button className="btn-ghost" disabled={busy} onClick={() => void decide(c, "reject")}>不采纳</button>
                      </div>
                    ) : (
                      <div className="rc-actions">
                        <button className="btn-link" disabled={busy} onClick={() => void decide(c, "reset")}>撤回决定</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}

/** 在段落中标出风险卡引用的原文（不改变文字，只包一层可点击的标记）。 */
function highlight(text: string, marks: { id: string; text: string; sev: string; status: string }[], active: string | null, onPick: (id: string) => void) {
  const hits: { start: number; end: number; m: (typeof marks)[number] }[] = [];
  for (const m of marks) {
    const at = text.indexOf(m.text);
    if (at >= 0 && !hits.some((h) => at < h.end && h.start < at + m.text.length)) hits.push({ start: at, end: at + m.text.length, m });
  }
  if (hits.length === 0) return text;
  hits.sort((a, b) => a.start - b.start);
  const out: (string | ReactElement)[] = [];
  let last = 0;
  for (const h of hits) {
    if (h.start > last) out.push(text.slice(last, h.start));
    out.push(
      <mark key={h.m.id} className={`wb-mark mark-${h.m.sev}${h.m.status === "rejected" ? " mark-rejected" : ""}${active === h.m.id ? " mark-active" : ""}`} onClick={() => onPick(h.m.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onPick(h.m.id)}>
        {text.slice(h.start, h.end)}
      </mark>,
    );
    last = h.end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
