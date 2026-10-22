/**
 * 合同审查工作台（UIUX P0-3；v9 第 03 篇 §6.1“风险卡与替代条款 → 律师接受/修改/拒绝 → 文书引擎写原生修订”）。
 *
 * 左：合同原文，风险卡引用的条款高亮（点击定位到卡）；右：风险卡（重大 → 一般 → 提示，同级按条款顺序），
 * 每张卡“接受 / 修改后接受 / 不采纳”，已决定的可撤回；顶部：进度与“生成修订稿”。
 * 卡片文字是事项令牌形态，这里按事项令牌表还原显示（只在本机界面）；律师改写的条款按原文保存。
 * 修订稿由内核按已接受的卡在原件副本上写原生修订——有卡定位不到时整体不写，列出是哪几张，律师可跳过后再生成。
 */
import { nav } from "../App.tsx";
import { scrollBehavior } from "../lib/ui-prefs.ts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { kernelPreview, localPreview, type AcceptPreview } from "../lib/accept-preview.ts";
import { agreementParts, batchEligible, firstOpenCard, restoreOursText, nextOpenCard, stepCard } from "../lib/workbench.ts";
import { api, type RiskCard, type RiskProgress } from "../api.ts";
import { CITE_STATE_LABELS } from "../lib/labels.ts";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";
import { adoptedText, KIND_LABEL, kindOf, ladderRows, NATURE_LABEL, NATURE_PILL, natureOf, natureText, RELATION_LABEL, RULE_SOURCE_LABEL, type RiskNature } from "../lib/risk-ladder.ts";
import { Select } from "./Select.tsx";

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
  /** 协议条（Z3 #22、D-2）：我方立场、审查要点（方法模板与版本）、法域；已显示为中文。 */
  agreement?: { stance?: string | null; method?: string | null; jurisdiction?: string | null };
}

export function ReviewWorkbench({ matterId, documentVersionId, runId, readOnly = false, backLabel = "← 返回任务", onClose, onRedline, agreement }: Props) {
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
  // 原文与卡片的悬停联动（W-3）
  const [natureEdit, setNatureEdit] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // 文档区“原文 / 接受后”（Z3 M-5）
  const [view, setView] = useState<"original" | "after">("original");
  // 首次载入后自动展开第一张未处理的卡（W-1）；之后由律师操作决定
  const autoOpened = useRef(false);
  // 修订稿两版（C1 §2.2 第 6 条）：缺省对外版（只有修订，不带内部理由与规则）
  const [audience, setAudience] = useState<"external" | "internal">("external");
  // v9.4 第 20 批（C1 §2.2 第 5、2、8 条）：批量接受的勾选与“撤回本批”、缺失卡误报驳回、意见表格式
  const [batchMode, setBatchMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [lastBatch, setLastBatch] = useState<{ batch: string; ids: string[] } | null>(null);
  const [falsePos, setFalsePos] = useState<{ id: string; term: string } | null>(null);
  const [tableFormat, setTableFormat] = useState<"xlsx" | "docx">("xlsx");
  // 对方改动模式（C1 §2.2 第 7 条）：有基线（本次回稿审查任务的我方上一稿）时可切到“只看对方改动”
  const [cardsView, setCardsView] = useState<"all" | "changes">("all");
  const [counter, setCounter] = useState<Awaited<ReturnType<typeof api.counterChanges>> | null>(null);

  const load = useCallback(async (): Promise<RiskCard[]> => {
    const r = await api.riskCards(matterId, { document_version_id: documentVersionId, ...(runFilter ? { run_id: runFilter } : {}) });
    setCards(r.cards);
    setProgress(r.progress);
    if (!autoOpened.current) {
      autoOpened.current = true;
      const first = firstOpenCard(r.cards);
      if (first) setActive(first);
    }
    const all = r.cards.flatMap((c) => [c.anchor_text, c.issue, c.suggestion ?? "", c.fallback ?? "", c.bottom_line ?? "", c.assumptions ?? "", c.rule_ref ?? "", ...(c.searched_terms ?? []), ...(c.searched_docs ?? []), ...(c.related ?? []).map((x) => x.quote)]).join("\n");
    if (all.includes("〔")) setMap(await restoreTokens(matterId, all));
    return r.cards;
  }, [matterId, documentVersionId, runFilter]);

  useEffect(() => {
    if (!documentVersionId || !runId) return setCounter(null);
    void api
      .counterChanges(matterId, documentVersionId, { run_id: runId })
      .then(async (r) => {
        setCounter(r);
        if (r.available) {
          const all = r.changes.flatMap((c) => [c.base_text, c.cur_text]).join("\n");
          if (all.includes("〔")) {
            const more = await restoreTokens(matterId, all);
            setMap((m0) => new Map([...m0, ...more]));
          }
        }
      })
      .catch(() => setCounter(null));
  }, [matterId, documentVersionId, runId]);

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

  // 接受后预览（余项续复核 RC-B-01）：Word 材料由内核按生成修订稿的同一套定位算出落点；非 Word 材料本机定位、仅供参考
  const [kernelView, setKernelView] = useState<{ status: string; preview: AcceptPreview } | null>(null);
  useEffect(() => {
    // 按钮上的“n 处修改”也要按内核口径，所以不等切到“接受后”才取
    if (!documentVersionId) return;
    let live = true;
    api
      .previewRedline(matterId, documentVersionId, runFilter ? { run_id: runFilter } : {})
      .then((r) => live && setKernelView({ status: r.status, preview: kernelPreview(r.paragraphs, r.cards) }))
      .catch(() => live && setKernelView(null));
    return () => {
      live = false;
    };
  }, [matterId, documentVersionId, runFilter, cards]);
  const docOnly = kernelView?.status === "not_docx" || kernelView?.status === "document_version_superseded";
  const preview = useMemo((): AcceptPreview | null => {
    if (!doc) return null;
    if (kernelView && (kernelView.status === "ok" || kernelView.status === "conflicts")) return kernelView.preview;
    if (kernelView?.status === "no_patches") return { paragraphs: doc.paragraphs.map((p) => [{ text: p }]), applied: 0, skipped: kernelView.preview.skipped };
    return localPreview(
      doc.paragraphs,
      cards.map((c) => ({
        card_id: c.card_id,
        seq: c.seq,
        status: c.status,
        anchor_status: c.anchor_status,
        anchor_text: plain(c.anchor_text),
        suggestion: plain(c.suggestion),
        final_text: plain(c.final_text),
        fallback: plain(c.fallback),
        ...(c.chosen_level ? { chosen_level: c.chosen_level } : {}),
        kind: kindOf(c),
      })),
    );
  }, [doc, cards, plain, kernelView]);
  const cardLabel = (id: string) => {
    const card = cards.find((x) => x.card_id === id);
    return card ? `${card.clause_ref ? clauseLabel(card.clause_ref) : `第 ${card.seq} 项`}：${plain(card.issue).slice(0, 20)}` : "（未知卡片）";
  };

  const setNature = async (card: RiskCard, nature: RiskNature) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.setRiskCardNature(matterId, card.card_id, nature);
      await load();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const decide = async (card: RiskCard, decision: "accept" | "modify" | "reject" | "reset", finalText?: string, level?: "fallback") => {
    setBusy(true);
    setMsg(null);
    try {
      await api.decideRiskCard(matterId, card.card_id, decision, finalText, level);
      setEditing(null);
      const fresh = await load();
      // 处理完自动展开下一张未处理的卡（W-1）；用刷新后的卡片集合，且只在当前过滤可见的卡里找（复核 S6B-11）
      if (decision !== "reset") {
        const shown = new Set(visible.map((c) => c.card_id));
        const next = nextOpenCard(fresh.filter((c) => shown.has(c.card_id) || c.card_id === card.card_id), card.card_id);
        if (next) {
          setActive(next);
          requestAnimationFrame(() => cardRefs.current.get(next)?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() }));
        }
      }
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
      const r = await api.buildRedline(matterId, documentVersionId, { audience, ...(runFilter ? { run_id: runFilter } : {}), ...(skip.length ? { skip_card_ids: skip } : {}) });
      const noPoint = r.no_insert_point?.length ? `；${r.no_insert_point.length} 条补充条款没写明插在哪里，只在审查意见表里` : "";
      if (r.status === "applied") {
        setMsg({
          tone: "ok",
          text: `已生成${audience === "internal" ? "内部版" : "对外版"}修订稿《${r.filename}》：${r.applied} 处修改以 Word 修订${audience === "internal" ? "和批注" : ""}写入（原件未改动）${r.skipped.length ? `；跳过 ${r.skipped.length} 项` : ""}${noPoint}。${audience === "external" ? "对外版不含内部批注；发出前请再看一遍修订署名。" : "内部版带理由与规则批注，不要直接发给对方。"}`,
          artifact: r.artifact_version_id,
        });
        onRedline?.(r.artifact_version_id);
      } else if (r.reason === "not_docx") {
        setMsg({ tone: "warn", text: "这份材料不是 Word 文件，不能直接写修订。可让助手把已接受的修改整理成《修订说明》。" });
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

  const exportTable = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.exportReviewTable(matterId, documentVersionId, { ...(runFilter ? { run_id: runFilter } : {}), format: tableFormat });
      // 不带“查看修订稿”按钮（那是修订稿的入口）：意见表在交付件里下载
      setMsg({ tone: "ok", text: `已导出《${r.filename}》：${r.rows} 项意见，在交付件里下载。` });
      onRedline?.(r.artifact_version_id);
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const runBusy = async (f: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await f();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const acceptBatch = () =>
    runBusy(async () => {
      const r = await api.decideRiskBatch(matterId, [...picked], "accept");
      setLastBatch({ batch: r.batch, ids: r.accepted });
      setPicked(new Set());
      setBatchMode(false);
      await load();
      setMsg({ tone: "ok", text: `已接受 ${r.accepted.length} 项${r.refused.length ? `；${r.refused.length} 项不能批量，请逐张处理` : ""}。` });
    });
  const undoBatch = () =>
    runBusy(async () => {
      if (!lastBatch) return;
      const r = await api.decideRiskBatch(matterId, lastBatch.ids, "undo", lastBatch.batch);
      setLastBatch(null);
      await load();
      setMsg({ tone: "ok", text: `已撤回本批 ${r.undone.length} 项，回到待处理。` });
    });
  const rejectFalsePositive = (card: RiskCard, term: string) =>
    runBusy(async () => {
      const r = await api.rejectMissing(matterId, card.card_id, term.trim() || undefined);
      setFalsePos(null);
      await load();
      setMsg({ tone: "ok", text: r.remembered ? `已驳回，并记住说法“${r.remembered}”：以后同类缺失卡复查时一起找。` : "已按误报驳回。" });
    });

  const focusCard = (id: string) => {
    setActive(id);
    setFilter("all");
    requestAnimationFrame(() => cardRefs.current.get(id)?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() }));
  };

  const accepted = progress?.accepted ?? 0;
  const allDecided = !!progress && progress.total > 0 && progress.decided === progress.total;
  const openCount = cards.filter((c) => c.status === "proposed").length;
  // 跨文件审查（v9.4 第 21 批）：卡片引用到的其他文件
  const otherFiles = [...new Set(cards.flatMap((c) => (c.related ?? []).map((x) => x.filename)))];
  // 顶部按类型计数（C1 §2.2：缺失 n · 偏离规则 n），只列有的类型
  const kindCounts = (["missing", "deviation", "consistency"] as const).map((k) => [k, cards.filter((c) => kindOf(c) === k).length] as const).filter(([, n]) => n > 0);

  // 键盘（W-1）：J/K 切换卡片，A 接受，E 修改后接受，N 不采纳；在输入框里不响应
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      // 统一下拉框的弹出列表里键入首字是跳转，不是快捷键（Z3 #15）
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable || t.closest?.('[role="listbox"]'))) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        const id = stepCard(visible.map((c) => c.card_id), active, k === "j" ? 1 : -1);
        if (id) focusCard(id);
        e.preventDefault();
        return;
      }
      if (readOnly || busy || !active || editing) return;
      // 只对当前看得见的卡生效（复核 S6B-11）
      const c = visible.find((x) => x.card_id === active);
      if (!c || c.status !== "proposed") return;
      if (k === "a") void decide(c, "accept");
      else if (k === "n") void decide(c, "reject");
      else if (k === "e") setEditing({ id: c.card_id, text: plain(c.suggestion) || plain(c.anchor_text) });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // 悬停卡片 → 原文对应处加深并滚到可视区（W-3）
  const hoverCard = (id: string | null) => {
    setHover(id);
    if (id) document.querySelector(`[data-mark="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  };

  return (
    <div className="wb">
      <div className="wb-head">
        <div className="wb-title">
          <button className="btn-link" onClick={onClose}>{backLabel}</button>
          <h1 className="page-title">审查工作台{documentVersionId ? (doc ? ` · ${doc.filename}` : "") : " · 未关联合同的意见"}</h1>
          {(progress || agreement) && (
            <div className="wb-progress wb-agreement" aria-live="polite">
              {agreementParts({ ...agreement, decided: progress?.decided, total: progress?.total }).join(" · ")}
              {progress && progress.high_open > 0 ? <span className="sev-text-high"> · {progress.high_open} 项重大风险待处理</span> : null}
              {kindCounts.map(([k, n]) => ` · ${KIND_LABEL[k]} ${n}`).join("")}
              {otherFiles.length > 0 && <span title={otherFiles.join("、")}> · 本次审查涉及 {otherFiles.length + 1} 份文件</span>}
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
            <>
              <Select
                className="select-sm"
                aria-label="修订稿版本：对外版只有修订，内部版另带理由与规则批注"
                value={audience}
                disabled={busy}
                onChange={(v) => setAudience(v === "internal" ? "internal" : "external")}
                options={[
                  { value: "external", label: "对外版" },
                  { value: "internal", label: "内部版（带批注）" },
                ]}
              />
              <button className={allDecided ? "btn-primary" : "btn-ghost"} disabled={busy || accepted === 0} onClick={() => void redline()} title={accepted === 0 ? "先接受或修改后接受至少一项" : undefined}>
                {/* 勾选“只看本次任务”时修订稿也只含本次任务的卡（复核 C-B06）：文案写明 */}
                生成修订稿{accepted > 0 ? `（${runFilter ? "本次任务 " : ""}${accepted} 项）` : ""}
              </button>
            </>
          )}
          {/* 全部处理完直达修订说明（V9.4 主文 §3.2）：已接受的修改整理成给客户或对方的说明与谈判要点 */}
          {!readOnly && allDecided && accepted > 0 && (
            <button className="btn-ghost" onClick={() => nav(`/start/redline-notes/${matterId}`)} title="把已接受的修改整理成修订说明与谈判要点">
              写修订说明
            </button>
          )}
          {!readOnly && cards.length > 0 && (
            <>
              <Select
                className="select-sm"
                aria-label="审查意见表格式"
                value={tableFormat}
                disabled={busy}
                onChange={(v) => setTableFormat(v === "docx" ? "docx" : "xlsx")}
                options={[
                  { value: "xlsx", label: "意见表 Excel" },
                  { value: "docx", label: "意见表 Word" },
                ]}
              />
              <button className="btn-ghost" disabled={busy} onClick={() => void exportTable()} title="条款、问题、类型、等级、规则、依据、建议与你的决定，一行一项">
                导出审查意见表
              </button>
            </>
          )}
          {/* 对外版的可见提示（C1 §2.2 第 6 条）：生成前就说清对外版里没有什么 */}
          {documentVersionId && !readOnly && audience === "external" && <div className="wb-why muted">对外版只有修订，不带批注、理由、规则号和底线</div>}
          {/* 置灰原因与“先生成”（W-2）：未处理的卡不写进修订稿 */}
          {documentVersionId && !readOnly && progress && progress.total > 0 && !allDecided && (
            <div className="wb-why muted">
              {accepted === 0 ? `先接受或修改后接受至少一项（还有 ${openCount} 项未处理）` : `还有 ${openCount} 项未处理 · 现在生成也可以，未处理的不写入修订稿`}
            </div>
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
          {doc && preview && (
            <div className="wb-doc-view" role="group" aria-label="文档显示">
              <button aria-pressed={view === "original"} className={`wb-view-btn${view === "original" ? " active" : ""}`} onClick={() => setView("original")}>原文</button>
              <button aria-pressed={view === "after"} className={`wb-view-btn${view === "after" ? " active" : ""}`} onClick={() => setView("after")}>接受后{preview.applied > 0 ? `（${preview.applied} 处修改）` : ""}</button>
              {view === "after" && (
                <span className="wb-view-note">
                  {kernelView?.status === "not_docx"
                    ? "这份材料不是 Word 文件，不能生成修订稿；下面按已接受的建议在本机显示，仅供参考"
                    : kernelView?.status === "document_version_superseded"
                      ? "这份合同已有更新的版本，修订稿要在新版本上生成；下面仅供参考"
                      : docOnly || !kernelView
                        ? "按已接受的建议显示，不是正式修订稿"
                        : "按生成修订稿的同一套定位显示，不是正式修订稿"}
                </span>
              )}
            </div>
          )}
          {view === "after" && preview && preview.skipped.length > 0 && (
            // 没体现的逐项说明原因，点一下定位到那张卡（余项续复核 RC-B-03）
            <ul className="wb-skipped">
              {preview.skipped.map((x) => (
                <li key={x.card_id}>
                  <button className="btn-link" onClick={() => focusCard(x.card_id)}>{cardLabel(x.card_id)}</button>
                  <span className="muted">：{x.reason}</span>
                </li>
              ))}
            </ul>
          )}
          {view === "original" && doc?.paragraphs.map((p, i) => (p.trim() ? <p key={i}>{highlight(p, marks, active, hover, focusCard, setHover)}</p> : <br key={i} />))}
          {view === "after" &&
            preview?.paragraphs.map((segs, i) =>
              segs.some((x) => x.text.trim() || x.edit) ? (
                <p key={i}>
                  {segs.map((x, j) =>
                    x.edit ? (
                      // 与 Word 原生修订同样子：删掉的原文加删除线、新文本加下划线；可用键盘聚焦，回车定位到卡（余项续复核 RC-B-02）
                      <span
                        key={j}
                        role="button"
                        tabIndex={0}
                        className={`wb-edit${active === x.edit.cardId ? " mark-active" : ""}`}
                        title={cardLabel(x.edit.cardId)}
                        aria-label={`${cardLabel(x.edit.cardId)}。${x.edit.del ? `删去：${x.edit.del}` : ""}${x.edit.del && x.edit.ins ? "；" : ""}${x.edit.ins ? `改为：${x.edit.ins}` : ""}`}
                        onClick={() => focusCard(x.edit!.cardId)}
                        onKeyDown={(e) => e.key === "Enter" && focusCard(x.edit!.cardId)}
                      >
                        {x.edit.del && <del className="wb-del">{x.edit.del}</del>}
                        {x.edit.ins && <ins className="wb-ins">{x.edit.ins}</ins>}
                      </span>
                    ) : (
                      x.text
                    ),
                  )}
                </p>
              ) : (
                <br key={i} />
              ),
            )}
        </section>
        <section className="wb-cards" aria-label="风险卡">
          {counter?.available && (
            <div className="seg wb-view" role="tablist" aria-label="看什么">
              <button role="tab" aria-selected={cardsView === "all"} className={`seg-btn${cardsView === "all" ? " on" : ""}`} onClick={() => setCardsView("all")}>审全文</button>
              <button role="tab" aria-selected={cardsView === "changes"} className={`seg-btn${cardsView === "changes" ? " on" : ""}`} onClick={() => setCardsView("changes")}>
                只看对方改动（{counter.changes.length}）
              </button>
            </div>
          )}
          {cardsView === "changes" && counter?.available ? (
            <div className="wb-changes">
              <p className="muted">
                和我方上一稿《{counter.baseline_filename}》比：改 {counter.stats.modified} · 增 {counter.stats.added} · 删 {counter.stats.deleted}
                {counter.stats.silent > 0 ? ` · 其中 ${counter.stats.silent} 处没有修订痕迹（静默改动）` : ""}。比对按段落，表格、页眉页脚和脚注的改动请抽查。
              </p>
              {counter.changes.map((ch) => (
                <div key={ch.index} className="wb-change">
                  <div className="wb-change-head">
                    <span className="pill pill-gray">{ch.type === "added" ? "对方新增" : ch.type === "deleted" ? "对方删除" : "对方修改"}</span>
                    {ch.silent && <span className="pill pill-orange" title="回稿里这一处没有留修订痕迹">静默改动</span>}
                  </div>
                  <div className="wb-change-cols">
                    <div>
                      <div className="claim-k">我方原稿</div>
                      {ch.base_text ? plain(ch.base_text) : <span className="muted">（没有）</span>}
                    </div>
                    <div>
                      <div className="claim-k">对方改稿</div>
                      {ch.cur_text ? plain(ch.cur_text) : <span className="muted">（对方删去了这一段）</span>}
                    </div>
                  </div>
                  {ch.card_ids.length === 0 && <div className="muted">这一处没有提出意见。</div>}
                  {ch.card_ids.map((cid) => {
                    const c = cards.find((x) => x.card_id === cid);
                    if (!c) return null;
                    return (
                      <div key={cid} className="wb-change-card">
                        <span className="rc-issue">{plain(c.issue)}</span>
                        <span className={`rc-status rc-status-${c.status}`}>{STATUS_LABEL[c.status]}</span>
                        {!readOnly && c.status === "proposed" && (
                          <span className="rc-actions">
                            <button className="btn-ghost" disabled={busy} title="接受对方的改动：这条意见不采纳，合同按对方改稿" onClick={() => void decide(c, "reject")}>接受对方</button>
                            {(() => {
                              const ours = restoreOursText(ch.cur_text, ch.base_text, c.anchor_text);
                              return ours ? (
                                <button className="btn-ghost" disabled={busy} title="把这一处改回我方原稿（以修订写入）" onClick={() => void decide(c, "modify", plain(ours))}>恢复我方</button>
                              ) : null;
                            })()}
                            {c.fallback?.trim() && (
                              <button className="btn-ghost" disabled={busy} title="改用可退让一级的文本" onClick={() => void decide(c, "accept", undefined, "fallback")}>改用退让文本</button>
                            )}
                            <button className="btn-link" onClick={() => { setCardsView("all"); focusCard(c.card_id); }}>看整张卡</button>
                          </span>
                        )}
                        {!readOnly && c.status !== "proposed" && <button className="btn-link" disabled={busy} onClick={() => void decide(c, "reset")}>撤回决定</button>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
          <>
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
          {/* 批量接受（C1 §2.2 第 5 条）：只对提示级和前后不一致类开放；重大、必须修改、缺失、需客户决定的不能勾 */}
          {!readOnly && (cards.some((c) => batchEligible({ ...c, nature: natureOf(c) })) || (lastBatch?.ids.length ?? 0) > 0) && (
            <div className="wb-batch">
              {!batchMode ? (
                cards.some((c) => batchEligible({ ...c, nature: natureOf(c) })) && <button className="btn-link" onClick={() => { setBatchMode(true); setPicked(new Set(cards.filter((c) => batchEligible({ ...c, nature: natureOf(c) })).map((c) => c.card_id))); }}>
                  批量接受提示级与前后不一致（{cards.filter((c) => batchEligible({ ...c, nature: natureOf(c) })).length} 项）
                </button>
              ) : (
                <>
                  <span className="muted">勾选要一起接受的；重大、必须修改、缺失和需客户决定的不能勾</span>
                  <button className="btn-primary" disabled={busy || picked.size === 0} onClick={() => void acceptBatch()}>接受所选 {picked.size} 项</button>
                  <button className="btn-ghost" disabled={busy} onClick={() => { setBatchMode(false); setPicked(new Set()); }}>取消</button>
                </>
              )}
              {lastBatch && lastBatch.ids.length > 0 && !batchMode && (
                <button className="btn-link" disabled={busy} onClick={() => void undoBatch()}>撤回本批（{lastBatch.ids.length} 项）</button>
              )}
            </div>
          )}
          {/* 快捷键收进悬停提示（v9.4 U1 #14），不再常驻一行 */}
          {!readOnly && cards.length > 0 && <div className="wb-keys muted" title="J / K 切换 · A 接受 · E 修改 · N 不采纳">键盘快捷键</div>}
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
                className={`rc ${sev.cls}${open ? " open" : ""}${hover === c.card_id ? " rc-hover" : ""} rc-${c.status}`}
                onMouseEnter={() => hoverCard(c.card_id)}
                onMouseLeave={() => setHover(null)}
              >
                {batchMode && batchEligible({ ...c, nature: natureOf(c) }) && (
                  <label className="rc-batch">
                    <input
                      type="checkbox"
                      checked={picked.has(c.card_id)}
                      aria-label={`一起接受：${plain(c.issue)}`}
                      onChange={(e) => setPicked((s0) => { const n = new Set(s0); if (e.target.checked) n.add(c.card_id); else n.delete(c.card_id); return n; })}
                    />
                    一起接受
                  </label>
                )}
                <button className="rc-head" aria-expanded={open} onClick={() => setActive(open ? null : c.card_id)}>
                  <span className={`rc-sev ${sev.cls}`}>{sev.label}</span>
                  <span className={`pill ${NATURE_PILL[natureOf(c)]}`} title={c.nature_inferred ? "按类别与严重程度推定，可在展开后修改" : undefined}>
                    {natureText(c)}
                  </span>
                  {kindOf(c) !== "risk" && <span className="pill pill-gray">{KIND_LABEL[kindOf(c)]}</span>}
                  {(c.searched_found?.length ?? 0) > 0 && <span className="pill pill-orange" title="查过的说法在材料里出现过，可能已有约定">可能误报</span>}
                  {(c.clause_ref || c.page || c.cell) && <span className="rc-ref">{[c.clause_ref ? clauseLabel(c.clause_ref) : null, c.page ? `第 ${c.page} 页` : null, c.cell ?? null].filter(Boolean).join(" · ")}</span>}
                  {(c.related?.length ?? 0) > 0 && <span className="pill pill-gray" title={c.related!.map((x) => x.filename).join("、")}>涉及 {new Set(c.related!.map((x) => x.document_version_id)).size + 1} 份文件</span>}
                  <span className="rc-issue">{plain(c.issue)}</span>
                  <span className={`rc-status rc-status-${c.status}`}>
                    {c.status === "accepted" && !adoptedText(c).trim() ? "已知悉" : c.status === "accepted" && c.chosen_level === "fallback" ? "已接受（可退让）" : STATUS_LABEL[c.status]}
                  </span>
                </button>
                {open && (
                  <div className="rc-body">
                    {/* 同一句话不出现两次（v9.4 U1 #14）：标题放得下全文时，这一行只放类别 */}
                    <div className="rc-row">
                      <span className="rc-k">{[...plain(c.issue)].length > 40 ? "问题判断" : "类别"}</span>
                      <span>
                        {[...plain(c.issue)].length > 40 && plain(c.issue)}
                        <span className="tag tag-gray" title={c.category === "both" ? "既是法律问题，也涉及商业条件" : undefined}>{CATEGORY_LABEL[c.category]}</span>
                        {c.needs_client_decision && <span className="tag tag-beta">需客户决定</span>}
                      </span>
                    </div>
                    {/* 性质可由律师改（复核 RB16B-03）：推定的或 Agent 判错的 */}
                    {!readOnly && (
                      <div className="rc-row">
                        <span className="rc-k">性质</span>
                        <span>
                          {/* 性质先作胶囊显示，点“改”才出下拉框（v9.4 U1 #14：下拉框像是在让律师改 AI 的分类） */}
                          {natureEdit === c.card_id ? (
                            <Select
                              className="select-sm"
                              aria-label="建议的性质"
                              value={natureOf(c)}
                              disabled={busy}
                              onChange={(v) => {
                                setNatureEdit(null);
                                void setNature(c, v as RiskNature);
                              }}
                              options={(Object.keys(NATURE_LABEL) as RiskNature[]).map((k) => ({ value: k, label: NATURE_LABEL[k] }))}
                            />
                          ) : (
                            <>
                              <span className={`pill ${NATURE_PILL[natureOf(c)]}`}>{NATURE_LABEL[natureOf(c)]}</span>{" "}
                              <button className="btn-link" disabled={busy} onClick={() => setNatureEdit(c.card_id)}>
                                改
                              </button>
                            </>
                          )}
                          {c.nature_inferred && <span className="muted"> 按类别推定，请确认</span>}
                        </span>
                      </div>
                    )}
                    {/* 判断依据来源与规则（C1 §2.2 第 3 条）：法律强制不可谈，本所或客户规则可谈，通用建议须律师判断 */}
                    {(c.rule_source || c.rule_ref) && (
                      <div className="rc-row">
                        <span className="rc-k">按什么判断</span>
                        <span>
                          {c.rule_source && <span className="tag tag-gray">{RULE_SOURCE_LABEL[c.rule_source]}</span>}
                          {c.rule_ref && <> {plain(c.rule_ref)}</>}
                        </span>
                      </div>
                    )}
                    {/* 缺失卡说清为什么认为缺失（C1 §2.2 第 2 条）：查过哪些说法、哪些文件；材料里其实找得到的标出来 */}
                    {kindOf(c) === "missing" && (
                      <div className="rc-row">
                        <span className="rc-k">查过</span>
                        <span>
                          {(c.searched_terms ?? []).map((t) => plain(t)).join("、") || "（没有列出）"}
                          {(c.searched_docs?.length ?? 0) > 0 && <span className="muted">（{c.searched_docs!.map((d) => plain(d)).join("、")}）</span>}
                          {(c.searched_found?.length ?? 0) > 0 && (
                            <span className="rc-warn">
                              材料里出现了这些说法：{c.searched_found!.map((f) => `“${plain(f.term)}”（${plain(f.filename)}）`).join("、")}——请先核对是否已有约定
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                    {/* 跨文件审查（v9.4 第 21 批，C1 §2 第 7 项）：补充协议、附件里与本条相关的原文 */}
                    {(c.related ?? []).map((x, j) => (
                      <div key={j} className="rc-row">
                        <span className="rc-k">{RELATION_LABEL[x.relation] ?? "相关原文"}</span>
                        <span className="rc-quote">
                          <span className="muted">《{x.filename}》</span>
                          {x.quarantined ? <span className="rc-warn">这份材料带国家秘密标志、已隔离，原文不再显示</span> : <>“{plain(x.quote)}”</>}
                          {!x.quarantined && x.anchor_status === "not_found" && <span className="rc-warn">这段原文在《{x.filename}》里找不到，请打开原件核对</span>}
                          {x.anchor_status === "ambiguous" && <span className="rc-warn">这段原文在《{x.filename}》里出现多处</span>}
                        </span>
                      </div>
                    ))}
                    <div className="rc-row">
                      <span className="rc-k">{kindOf(c) === "missing" ? "插在哪里" : "合同原文"}</span>
                      <span className="rc-quote">
                        {kindOf(c) === "missing" ? (c.anchor_text ? <>在“{plain(c.anchor_text)}”这一段之后</> : <span className="muted">没有写明插在哪里：只进审查意见表，请在 Word 中手工补上</span>) : plain(c.anchor_text)}
                        {kindOf(c) === "missing" && !!c.anchor_text && c.anchor_status !== "located" && (
                          <span className="rc-warn">{c.anchor_status === "ambiguous" ? "插入位置在合同中出现多处" : "插入位置在合同中找不到"}：只进审查意见表，请在 Word 中手工补上</span>
                        )}
                        {kindOf(c) !== "missing" && c.anchor_status === "not_found" && !!c.anchor_text && <span className="rc-warn">未能在合同中找到这段原文，生成修订稿时需跳过，可在 Word 中手工修改</span>}
                        {kindOf(c) !== "missing" && c.anchor_status === "ambiguous" && <span className="rc-warn">这段原文在合同中出现多处，生成时按条款号定位</span>}
                        {c.anchor_status === "cross_paragraph" && <span className="rc-warn">这段原文跨了段落，修订稿不能自动写入，生成时需跳过，可在 Word 中手工修改</span>}
                      </span>
                    </div>
                    {/* 谈判梯度（Astra M-1）：首选 → 可退让 → 底线；只有一级时仍叫“建议改为” */}
                    {ladderRows(c).map((row) => (
                      <div key={row.key} className="rc-row">
                        <span className="rc-k">{row.label}</span>
                        <span className={row.key === "mine" || row.key === "first" || row.chosen ? "rc-suggest" : undefined}>
                          {row.key === "mine" ? row.text : plain(row.text)}
                          {row.chosen && <span className="tag tag-gray"> 写进修订稿的是这一级</span>}
                          {/* 梯度可选（C-05）：可退让也能一键接受；底线只供参考、不写进修订稿 */}
                          {!readOnly && c.status === "proposed" && row.key === "fallback" && (
                            <>
                              {" "}
                              <button className="btn-link" disabled={busy} onClick={() => void decide(c, "accept", undefined, "fallback")}>
                                用这一级
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                    ))}
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
                          <button className="btn-primary" disabled={busy} onClick={() => void decide(c, "accept")}>{c.fallback?.trim() ? "接受首选" : kindOf(c) === "missing" ? "接受（补上这一条）" : "接受"}</button>
                        ) : (
                          <button className="btn-primary" disabled={busy} title="这项没有建议文本：知悉、合同不改动（不写进修订稿）" onClick={() => void decide(c, "accept")}>知悉（不改动）</button>
                        )}
                        <button className="btn-ghost" disabled={busy} onClick={() => setEditing({ id: c.card_id, text: plain(c.suggestion) || plain(c.anchor_text) })}>修改后接受</button>
                        <button className="btn-ghost" disabled={busy} onClick={() => void decide(c, "reject")}>不采纳</button>
                        {kindOf(c) === "missing" && falsePos?.id !== c.card_id && (
                          <button className="btn-link" disabled={busy} onClick={() => setFalsePos({ id: c.card_id, term: "" })} title="材料里其实有：驳回，并把材料里的说法记下来，以后一起找">
                            误报：其实有
                          </button>
                        )}
                        {falsePos?.id === c.card_id && (
                          <span className="rc-falsepos">
                            <input value={falsePos.term} maxLength={30} onChange={(e) => setFalsePos({ id: c.card_id, term: e.target.value })} placeholder="材料里的说法，如：成果归甲方所有" aria-label="材料里实际的说法" />
                            <button className="btn btn-sm" disabled={busy || (!!falsePos.term.trim() && falsePos.term.trim().length < 2)} onClick={() => void rejectFalsePositive(c, falsePos.term)}>
                              {falsePos.term.trim() ? "驳回并记住" : "只驳回"}
                            </button>
                            <button className="btn-link" onClick={() => setFalsePos(null)}>取消</button>
                          </span>
                        )}
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
          </>
          )}
        </section>
      </div>
    </div>
  );
}

/** 在段落中标出风险卡引用的原文（不改变文字，只包一层可点击的标记）。 */
function highlight(text: string, marks: { id: string; text: string; sev: string; status: string }[], active: string | null, hover: string | null, onPick: (id: string) => void, onHover: (id: string | null) => void) {
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
      <mark
        key={h.m.id}
        data-mark={h.m.id}
        className={`wb-mark mark-${h.m.sev}${h.m.status === "rejected" ? " mark-rejected" : ""}${active === h.m.id ? " mark-active" : ""}${hover === h.m.id ? " mark-hover" : ""}`}
        onClick={() => onPick(h.m.id)}
        onMouseEnter={() => onHover(h.m.id)}
        onMouseLeave={() => onHover(null)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onPick(h.m.id)}
      >
        {text.slice(h.start, h.end)}
      </mark>,
    );
    last = h.end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
