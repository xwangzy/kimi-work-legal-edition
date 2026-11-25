/**
 * 任务页“起草前确认论点与依据”卡（v9.4 第 19 批 C-04；评审 C1 §1、§4.1“它撑得住这句话吗”）。
 * 每条论点：采用 / 不采用、可改写；依据逐条显示核验情况与法规库条文原文，可去掉不用的；事实写明是否已确认。
 * 确认后 Agent 只按确认版起草（内核门禁：确认之前不能生成文书）。文字为令牌形态，按事项令牌表还原显示；律师改写的论点按原文保存。
 *
 * 第 66 批（V40 P0-1）重构信息层级：原来每条论点把依据、要件、事实、条文、反驳一次铺开，律师要从长页里自己找“要我定什么”。
 * 现在三层：
 *  1. 卡头：要确认什么（几条论点、几条依据）与一句规则（系统只核条文与版本，撑不撑得住由你判断）；
 *  2. “需要你判断”：把未核实的依据、类推、待证要件、未确认事实逐条列在最上面，点一条就展开对应论点；
 *  3. 论点列表：默认只显示论点原文与一行概况（依据几条、要件有事实几条、要判断几处），细节（依据核验、怎么支持、要件—事实、
 *     但书、条文原文、对方可能的反驳）按需展开。
 * 底部固定操作区：一并确认事实、补充要求（按需展开）、“确认并开始起草（n 条论点）”。决定的数据结构与内核接口不变。
 */
import { useMemo, useRef, useState } from "react";
import { argSummary, attentionDigest, basisBadge, decisionsOf, elementStateText, emptyDraft, keptCount, modeText, outlineAttention, unconfirmedFactsOf, type OutlineDraft, type OutlineView } from "../lib/outline.ts";
import { Icon } from "./Icons.tsx";
import "../styles-outline.css";

interface Props {
  outline: OutlineView;
  plain: (s: string | null | undefined) => string;
  busy: boolean;
  /** 有对应的确认题时才给“先不起草”。 */
  canStop: boolean;
  /** confirmFacts：同时确认留下的论点引用的待确认事实（第 28 批）。 */
  onConfirm: (decisions: ReturnType<typeof decisionsOf>, note: string, confirmFacts: boolean) => void;
  onStop: () => void;
}

export function OutlineConfirm({ outline, plain, busy, canStop, onConfirm, onStop }: Props) {
  const [d, setD] = useState<OutlineDraft>(emptyDraft);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [openText, setOpenText] = useState<string | null>(null);
  // 一并确认事实（第 28 批）：律师不必离开任务页去事项页逐条确认。
  // 第 66 批（独立评审 R4-1）：缺省不勾——“我已对照材料核过”是律师本人的声明，界面不能替他预先作出
  const [withFacts, setWithFacts] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const kept = keptCount(outline, d);
  const pendingFacts = unconfirmedFactsOf(outline, d);
  const attention = useMemo(() => outlineAttention(outline, d, (s) => plain(s)), [outline, d, plain]);
  // 卡顶只列汇总后的几行（依据问题与类推逐条，要件按论点合并，事实合成一行）
  const digest = useMemo(() => attentionDigest(attention), [attention]);
  const basisTotal = outline.items.reduce((n, x) => n + x.basis.length, 0);
  const allOpen = open.size === outline.items.length && outline.items.length > 0;

  const toggle = (id: string, on?: boolean) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (on ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  const jump = (id: string) => {
    toggle(id, true);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-arg="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  return (
    // V18 A6：与计划卡、提问卡同一外壳（card-confirm + cc-head + cc-why + cc-actions）
    <div className="card-confirm card-outline outline-card oc" role="region" aria-label="起草前确认论点与依据">
      <header className="oc-head">
        <div className="oc-title-row">
          <span className="oc-step">起草前</span>
          <h3 className="cc-head oc-title">确认{outline.doc_kind}的论点与依据</h3>
          <button type="button" className="btn-link oc-expand-all" onClick={() => setOpen(allOpen ? new Set() : new Set(outline.items.map((x) => x.arg_id)))}>
            {allOpen ? "全部收起" : "全部展开"}
          </button>
        </div>
        <p className="cc-why oc-why">
          助手只按你采用的论点与依据起草。系统核对条文是否存在、版本是否有效；能否撑住论点由你判断。确认之前不会出文书；若助手绕过确认产出文书，会标为“论点未经确认”，签发时须写明不确认的理由。
        </p>
        <div className="oc-stats" aria-label="概况">
          <span className="oc-stat"><b>{kept}</b>/{outline.items.length} 条论点采用</span>
          <span className="oc-stat"><b>{basisTotal}</b> 条依据</span>
          <span className={`oc-stat${digest.length > 0 ? " oc-stat-warn" : " oc-stat-ok"}`}>
            {digest.length > 0 ? <><b>{digest.length}</b> 项需你判断</> : "没有需你额外判断的地方"}
          </span>
        </div>
      </header>

      {digest.length > 0 && (
        <section className="oc-attn" aria-label="需要你判断">
          <div className="oc-attn-h">需要你判断</div>
          <ul>
            {digest.slice(0, 8).map((a, i) => (
              <li key={i}>
                <button type="button" className={`oc-attn-item tone-${a.tone}`} onClick={() => jump(a.arg_id)}>
                  <span className="oc-attn-n">论点 {a.n}</span>
                  <span className="oc-attn-text">{a.text}</span>
                  <Icon.right />
                </button>
              </li>
            ))}
          </ul>
          {digest.length > 8 && <div className="oc-attn-more muted">另有 {digest.length - 8} 项，展开各条论点查看</div>}
        </section>
      )}

      <ol className="outline-list oc-list" ref={listRef}>
        {outline.items.map((x, idx) => {
          const dropped = !!d.drop[x.arg_id];
          const droppedBasis = new Set(d.dropBasis[x.arg_id] ?? []);
          const isOpen = open.has(x.arg_id) && !dropped;
          const sum = argSummary(x, d, attention);
          const edited = (d.claim[x.arg_id] ?? "").trim();
          const changed = !!edited && edited !== plain(x.claim).trim();
          return (
            <li key={x.arg_id} data-arg={x.arg_id} className={`oc-arg${dropped ? " outline-dropped oc-dropped" : ""}${isOpen ? " open" : ""}${sum.attention > 0 && !dropped ? " has-attn" : ""}`}>
              <div className="oc-arg-head">
                <span className="oc-n" aria-hidden="true">{idx + 1}</span>
                <div className="oc-claim">
                  {editing === x.arg_id && !dropped ? (
                    <textarea
                      autoFocus
                      rows={3}
                      disabled={busy}
                      value={d.claim[x.arg_id] ?? plain(x.claim)}
                      onChange={(e) => setD({ ...d, claim: { ...d.claim, [x.arg_id]: e.target.value } })}
                      onBlur={() => setEditing(null)}
                      aria-label="论点（可改写）"
                    />
                  ) : (
                    <p className="oc-claim-text">{changed ? edited : plain(x.claim)}</p>
                  )}
                  <div className="oc-meta">
                    {dropped ? (
                      <span className="muted">不采用：起草时不写这条</span>
                    ) : (
                      <>
                        <span>依据 {sum.basis}</span>
                        {sum.elements > 0 && <span>要件 {sum.elementsWithFacts}/{sum.elements} 有事实</span>}
                        {argIssues(attention, x.arg_id) ? <span className="oc-meta-warn">{argIssues(attention, x.arg_id)}</span> : <span className="oc-meta-ok"><Icon.check /> 无待判断</span>}
                        {changed && <span className="tag tag-gray">已改写</span>}
                      </>
                    )}
                  </div>
                </div>
                <div className="oc-arg-tools">
                  <label className="oc-switch" title={dropped ? "采用这条论点" : "不采用这条论点"}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={!dropped}
                      disabled={busy}
                      onChange={(e) => setD({ ...d, drop: { ...d.drop, [x.arg_id]: !e.target.checked } })}
                      aria-label={`保留这条论点：${plain(x.claim).slice(0, 30)}`}
                    />
                    <span className="oc-switch-track" aria-hidden="true" />
                    <span className="oc-switch-text">{dropped ? "不采用" : "采用"}</span>
                  </label>
                  {!dropped && (
                    <span className="oc-arg-actions">
                      {editing !== x.arg_id && (
                        <button type="button" className="btn-link" disabled={busy} onClick={() => setEditing(x.arg_id)}>
                          <Icon.pen /> 改写
                        </button>
                      )}
                      {changed && (
                        <button type="button" className="btn-link" disabled={busy} onClick={() => setD({ ...d, claim: { ...d.claim, [x.arg_id]: "" } })}>
                          恢复原文
                        </button>
                      )}
                      <button type="button" className="btn-link oc-toggle" aria-expanded={isOpen} onClick={() => toggle(x.arg_id)}>
                        {isOpen ? "收起" : "依据与事实"} <span className={`oc-chev${isOpen ? " up" : ""}`}><Icon.down /></span>
                      </button>
                    </span>
                  )}
                </div>
              </div>

              {isOpen && (
                <div className="oc-detail">
                  {x.basis.length > 0 && (
                    <ul className="outline-basis oc-basis" aria-label="法律依据">
                      {x.basis.map((b, i) => {
                        const key = `${x.arg_id}-${i}`;
                        const off = droppedBasis.has(i);
                        const badge = basisBadge(b);
                        const mode = modeText(b.mode);
                        return (
                          <li key={key} className={`oc-basis-item${off ? " outline-dropped" : ""}`}>
                            <div className="oc-basis-head">
                              <label className="oc-check">
                                <input
                                  type="checkbox"
                                  checked={!off}
                                  disabled={busy}
                                  onChange={(e) => {
                                    const cur = new Set(d.dropBasis[x.arg_id] ?? []);
                                    if (e.target.checked) cur.delete(i);
                                    else cur.add(i);
                                    setD({ ...d, dropBasis: { ...d.dropBasis, [x.arg_id]: [...cur] } });
                                  }}
                                  aria-label={`引用这条依据：${b.matched ?? b.law}${b.article ? `第 ${b.article} 条` : ""}`}
                                />
                                <span className="oc-law">《{b.matched ?? b.law}》{b.article ? `第 ${b.article} 条` : ""}</span>
                              </label>
                              <span className={`cite-state cite-${b.check} oc-badge tone-${badge.tone}`} title={badge.detail}>{badge.label}</span>
                              {mode && <span className={`tag ${b.mode === "analogy" ? "tag-beta" : "tag-gray"} outline-mode`}>{mode}</span>}
                              {b.article_text && (
                                <button type="button" className="btn-link oc-article-btn" onClick={() => setOpenText(openText === key ? null : key)} aria-expanded={openText === key}>
                                  {openText === key ? "收起条文" : "看条文原文"}
                                </button>
                              )}
                            </div>
                            {badge.tone !== "ok" && <div className="oc-basis-warn">{badge.detail}</div>}
                            {openText === key && b.article_text && <blockquote className="outline-article">{b.article_text}</blockquote>}
                            {b.note && (
                              <div className="oc-row">
                                <span className="oc-k">怎么支持</span>
                                <span className="oc-v">{plain(b.note)}</span>
                              </div>
                            )}
                            {b.elements && b.elements.length > 0 && (
                              <div className="oc-row">
                                <span className="oc-k">要件与事实</span>
                                <ol className="outline-elements oc-elements" aria-label="构成要件与事实">
                                  {b.elements.map((e, ei) => {
                                    const st = elementStateText(e);
                                    return (
                                      <li key={ei} className={`oc-el tone-${st.tone}`}>
                                        <div className="oc-el-head">
                                          <span className="outline-element">{plain(e.element)}</span>
                                          <span className={`oc-el-state tone-${st.tone}`}>{st.text}</span>
                                        </div>
                                        {e.facts.length > 0 && <div className="oc-el-facts">{e.facts.map((f) => plain(f.statement)).join("；")}</div>}
                                      </li>
                                    );
                                  })}
                                </ol>
                              </div>
                            )}
                            {b.exceptions && (
                              <div className="oc-row">
                                <span className="oc-k">但书与例外</span>
                                <span className="oc-v">{plain(b.exceptions)}</span>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {x.facts.length > 0 && (
                    <div className="oc-row oc-facts-row">
                      <span className="oc-k">引用的事实</span>
                      <ul className="outline-facts oc-facts">
                        {x.facts.map((f, i) => (
                          <li key={i}>
                            <span className={`oc-fact-dot${f.confirmed ? " ok" : ""}`} aria-hidden="true" />
                            {plain(f.statement)} <span className={`tag ${f.confirmed ? "tag-gray" : "tag-beta"}`}>{f.confirmed ? "已确认事实" : "未经你确认"}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {x.counter && (
                    <div className="oc-counter">
                      <span className="oc-k">对方可能这样反驳</span>
                      <span className="oc-v">{plain(x.counter)}</span>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <footer className="oc-foot">
        {pendingFacts.length > 0 && (
          <label className="oc-check outline-facts-confirm">
            <input type="checkbox" checked={withFacts} disabled={busy} onChange={(e) => setWithFacts(e.target.checked)} />
            <span>
              同时确认采用论点里标“未经你确认”的 {pendingFacts.length} 条事实（我已对照材料核过）
              <span className="muted">{withFacts ? "：确认后这些事实按已确认采用" : "：不勾也能起草——这些事实在正文里写得保守（附条件或照材料写明证据），列进给你的核对清单"}</span>
            </span>
          </label>
        )}
        {noteOpen || note ? (
          <textarea rows={2} autoFocus={noteOpen && !note} placeholder="给助手的补充要求，例如：违约金按合同第 8.2 条计算" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} aria-label="补充要求" />
        ) : (
          <button type="button" className="btn-link oc-note-btn" onClick={() => setNoteOpen(true)}>
            <Icon.plus /> 补充要求（可不填）
          </button>
        )}
        <div className="cc-actions oc-actions">
          <span className="oc-actions-sum muted">{kept === 0 ? "至少采用一条论点" : `将按 ${kept} 条论点起草`}</span>
          {canStop && (
            <button className="btn-ghost" disabled={busy} onClick={onStop}>
              先不起草
            </button>
          )}
          <button className="btn-primary" disabled={busy || kept === 0} title={kept === 0 ? "至少留一条论点" : undefined} onClick={() => onConfirm(decisionsOf(outline, d, plain), note.trim(), withFacts && pendingFacts.length > 0)}>
            确认并开始起草（{kept} 条论点）
          </button>
        </div>
      </footer>
    </div>
  );
}

/** 一条论点要你看的（与卡顶汇总同一口径）：依据问题与类推逐条计，要件按“待证 / 没挂事实”计，事实按条计。 */
function argIssues(all: ReturnType<typeof outlineAttention>, argId: string): string {
  const a = all.filter((x) => x.arg_id === argId);
  const n = (k: string) => a.filter((x) => x.kind === k).length;
  return [
    n("basis") > 0 ? `${n("basis")} 条依据须核` : "",
    n("analogy") > 0 ? "类推适用" : "",
    n("to_prove") > 0 ? `${n("to_prove")} 个要件待证` : "",
    n("element_gap") > 0 ? `${n("element_gap")} 个要件没挂事实` : "",
    n("fact") > 0 ? `${n("fact")} 条事实待确认` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
