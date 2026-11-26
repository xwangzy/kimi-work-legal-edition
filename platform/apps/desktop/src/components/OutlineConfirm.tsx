/**
 * 任务页“起草前确认论点与依据”卡（v9.4 第 19 批 C-04；评审 C1 §1、§4.1“它撑得住这句话吗”）。
 * 每条论点：采用 / 改写 / 不用；依据逐条显示核验情况与法规库条文原文，可去掉不用的；事实写明是否已确认。
 * 确认后 Agent 只按确认版起草（内核门禁：确认之前不能生成文书）。文字为令牌形态，按事项令牌表还原显示；律师改写的论点按原文保存。
 *
 * 第 67 批（V41 工作线 A）按律师的判断路径重排——这一步律师只做三件事：这条论点要不要、依据靠不靠得住、哪些事实我认。
 *  1. 卡头：一行标题 + 一句话 + 至多一行汇总（点了展开相关论点）；规则收进“规则”弹出说明。
 *  2. 论点列表是主角：每条 = 序号、论点原文、一句结论信号（绿 依据已核 / 橙 有疑点 / 红 依据有问题，只说最要紧的一件事）、
 *     “采用 / 改写 / 不用”三选一。展开后固定顺序：法律依据（条文、核验、助手理由、原文按需）→ 事实依据（要件 ↔ 事实，缺证据的标出）
 *     → 风险提示（但书与例外、对方可能的反驳）。同一事实在一条论点里只完整写一次，要件行用“事实 n”引用。
 *  3. 底部固定：一并确认事实（缺省不勾，可逐条看）、补充要求、主按钮。
 * 决定的数据结构与内核接口不变（decisionsOf、onConfirm 三个参数）。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  argFacts,
  argRiskCount,
  argVerdict,
  basisBadge,
  basisName,
  basisShort,
  decisionsOf,
  elementEvidence,
  emptyDraft,
  keptCount,
  liveFactState,
  modeText,
  outlineOverview,
  pendingFactUses,
  sharedPendingFacts,
  type OutlineDraft,
  type OutlineItemView,
  type OutlineView,
} from "../lib/outline.ts";
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

type Choice = "keep" | "edit" | "drop";
const CHOICES: { v: Choice; label: string; title: string }[] = [
  { v: "keep", label: "采用", title: "按助手所列原文采用" },
  { v: "edit", label: "改写", title: "改写后采用（按你写的原文保存）" },
  { v: "drop", label: "不用", title: "起草时不写这条" },
];

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
  const [factsOpen, setFactsOpen] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  // 第三轮评审（“嵌套滚动”）：卡片本身不滚动、随页面增高；只有操作栏在卡片还在视口里时贴底。
  // 贴底时加一道上沿阴影、去掉圆角，读作页面底部的操作栏，而不是卡片到底了、里面还要滚
  const endRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = endRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setStuck(!!e && !e.isIntersecting && e.boundingClientRect.top > 0));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const factsRef = useRef<HTMLInputElement>(null);
  const live = useMemo(() => liveFactState(outline), [outline]);
  const kept = keptCount(outline, d);
  const pendingFacts = useMemo(() => pendingFactUses(outline, d), [outline, d]);
  const overview = useMemo(() => outlineOverview(outline, d, live), [outline, d, live]);
  const shared = useMemo(() => sharedPendingFacts(outline, d, live), [outline, d, live]);
  const openable = outline.items.filter((x) => !d.drop[x.arg_id]);
  const allOpen = openable.length > 0 && openable.every((x) => open.has(x.arg_id));

  const editedText = (x: OutlineItemView) => (d.claim[x.arg_id] ?? "").trim();
  const isChanged = (x: OutlineItemView) => !!editedText(x) && editedText(x) !== plain(x.claim).trim();
  const choiceOf = (x: OutlineItemView): Choice => (d.drop[x.arg_id] ? "drop" : editing === x.arg_id || isChanged(x) ? "edit" : "keep");
  const droppedN = outline.items.filter((x) => d.drop[x.arg_id]).length;
  const editedN = outline.items.filter((x) => !d.drop[x.arg_id] && isChanged(x)).length;

  const toggle = (id: string, on?: boolean) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (on ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  // 汇总行：点一项展开相关论点并滚到第一条
  const reveal = (ids: string[]) => {
    if (ids.length === 0) return;
    setOpen((cur) => new Set([...cur, ...ids]));
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-arg="${CSS.escape(ids[0]!)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const choose = (x: OutlineItemView, c: Choice) => {
    if (c === "drop") {
      setEditing(null);
      setD({ ...d, drop: { ...d.drop, [x.arg_id]: true } });
    } else if (c === "keep") {
      // 按原文采用：改写过的文字一并放弃（等于原来的“恢复原文”）
      setEditing(null);
      const { [x.arg_id]: _gone, ...claim } = d.claim;
      setD({ ...d, drop: { ...d.drop, [x.arg_id]: false }, claim });
    } else {
      setD({ ...d, drop: { ...d.drop, [x.arg_id]: false } });
      setEditing(x.arg_id);
    }
  };

  return (
    // V18 A6：与计划卡、提问卡同一外壳（card-confirm + cc-head + cc-why + cc-actions）
    <div className="card-confirm card-outline outline-card oc" role="region" aria-label="起草前确认论点与依据">
      <header className="oc-head">
        <div className="oc-title-row">
          <h3 className="cc-head oc-title">确认{outline.doc_kind}的论点与依据</h3>
          <div className="oc-head-tools">
            <RulesTip />
            <button type="button" className="oc-tool" onClick={() => setOpen(allOpen ? new Set() : new Set(openable.map((x) => x.arg_id)))}>
              {allOpen ? "全部收起" : "全部展开"}
            </button>
          </div>
        </div>
        <p className="cc-why oc-why">逐条选“采用、改写或不用”；条文与版本由系统核对，能否撑住论点由你判断。</p>
        <div className="oc-overview" aria-label="要你看的">
          {overview.length === 0 ? (
            <span className="oc-ov tone-ok">
              <span className="oc-dot" aria-hidden="true" />
              条文都已核到，要件都有事实
            </span>
          ) : (
            overview.map((it) => (
              <button
                key={it.key}
                type="button"
                className={`oc-ov tone-${it.tone}`}
                onClick={() => {
                  if (it.key === "facts") {
                    setFactsOpen(true);
                    factsRef.current?.focus();
                  } else reveal(it.args);
                }}
              >
                <span className="oc-dot" aria-hidden="true" />
                {it.text}
              </button>
            ))
          )}
        </div>
      </header>

      <ol className="outline-list oc-list" ref={listRef}>
        {outline.items.map((x, idx) => {
          const dropped = !!d.drop[x.arg_id];
          const isOpen = open.has(x.arg_id) && !dropped;
          const v = argVerdict(x, d, live, (s) => plain(s), shared);
          const choice = choiceOf(x);
          const risks = argRiskCount(x, d);
          const changed = isChanged(x);
          const detailId = `oc-d-${outline.outline_id}-${x.arg_id}`;
          return (
            <li key={x.arg_id} data-arg={x.arg_id} className={`oc-arg tone-${dropped ? "off" : v.tone}${dropped ? " outline-dropped oc-dropped" : ""}${isOpen ? " open" : ""}`}>
              <div className="oc-arg-head">
                <span className="oc-n" aria-hidden="true">{idx + 1}</span>
                <div className="oc-claim">
                  {editing === x.arg_id && !dropped ? (
                    <div className="oc-edit">
                      <textarea
                        autoFocus
                        rows={3}
                        disabled={busy}
                        value={d.claim[x.arg_id] ?? plain(x.claim)}
                        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
                        onChange={(e) => setD({ ...d, claim: { ...d.claim, [x.arg_id]: e.target.value } })}
                        onBlur={() => setEditing(null)}
                        aria-label={`改写论点 ${idx + 1}`}
                      />
                      <div className="oc-edit-foot">
                        <span>改完点别处即可；起草按你写的原文。</span>
                        <button type="button" className="oc-tool" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(null)}>
                          完成
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="oc-claim-text">
                      {changed ? editedText(x) : plain(x.claim)}
                      {changed && (
                        <span className="oc-edited" title={`原文：${plain(x.claim)}`}>
                          已改写
                        </span>
                      )}
                    </p>
                  )}
                </div>
                <div className="oc-seg" role="radiogroup" aria-label={`论点 ${idx + 1}：采用、改写或不用`}>
                  {CHOICES.map((c) => (
                    <button key={c.v} type="button" role="radio" aria-checked={choice === c.v} className={`oc-seg-btn is-${c.v}`} title={c.title} disabled={busy} onClick={() => choose(x, c.v)}>
                      {c.label}
                    </button>
                  ))}
                </div>
                  {dropped ? (
                    <div className="oc-verdict is-off">不用：起草时不写这条</div>
                  ) : (
                    <button type="button" className={`oc-verdict tone-${v.tone}`} aria-expanded={isOpen} aria-controls={detailId} onClick={() => toggle(x.arg_id)}>
                      <span className="oc-dot" aria-hidden="true" />
                      {/* 结论词只给读屏：色点 + 那一句已经说清，五行重复“有疑点”反而抢走焦点（第 67 批第二轮自评） */}
                      <span className="oc-verdict-label">{v.label}：</span>
                      <span className="oc-verdict-issue">
                        {v.issue}
                        {v.more && <span className="oc-verdict-more">；{v.more}</span>}
                      </span>
                      <span className={`oc-verdict-risk${risks > 0 ? "" : " is-none"}`}>{risks > 0 ? `${risks} 个风险` : "无风险提示"}</span>
                      <span className="oc-verdict-go">
                        {isOpen ? "收起" : "依据与事实"}
                        <span className={`oc-chev${isOpen ? " up" : ""}`} aria-hidden="true">
                          <Icon.down />
                        </span>
                      </span>
                    </button>
                  )}
              </div>
              {isOpen && <ArgDetail id={detailId} x={x} d={d} setD={setD} live={live} plain={plain} busy={busy} openText={openText} setOpenText={setOpenText} />}
            </li>
          );
        })}
      </ol>

      <footer className={`oc-foot${stuck ? " is-stuck" : ""}`}>
        {pendingFacts.length > 0 && (
          <div className="oc-facts-confirm">
            <div className="oc-facts-row">
              <label className="oc-check outline-facts-confirm">
                <input ref={factsRef} type="checkbox" checked={withFacts} disabled={busy} onChange={(e) => setWithFacts(e.target.checked)} />
                <span>同时确认这 {pendingFacts.length} 条事实（我已对照材料核过）</span>
              </label>
              <button type="button" className="oc-tool" aria-expanded={factsOpen} onClick={() => setFactsOpen((o) => !o)}>
                {factsOpen ? "收起" : "逐条看"}
              </button>
            </div>
            <p className="oc-facts-hint">{withFacts ? "确认后这些事实按已确认采用。" : "不勾也能起草：这些事实在正文里写得保守，并列进给你的核对清单。"}</p>
            {factsOpen && (
              <ol className="oc-pending">
                {pendingFacts.map((f) => (
                  <li key={f.fact_id}>
                    <span className="oc-pending-text">{plain(f.statement)}</span>
                    {f.args.length > 0 && <span className="oc-pending-args">论点 {f.args.join("、")}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {(noteOpen || note) && (
          <textarea className="oc-note" rows={2} autoFocus={noteOpen && !note} placeholder="给助手的补充要求，例如：违约金按合同第 8.2 条计算" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} aria-label="补充要求" />
        )}
        <div className="cc-actions oc-actions">
          {!(noteOpen || note) && (
            <button type="button" className="oc-tool oc-note-btn" onClick={() => setNoteOpen(true)}>
              <Icon.plus /> 补充要求
            </button>
          )}
          <span className="oc-actions-sum">
            {kept === 0 ? "至少采用一条论点" : [droppedN > 0 ? `不用 ${droppedN} 条` : "", editedN > 0 ? `改写 ${editedN} 条` : ""].filter(Boolean).join("，")}
          </span>
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
      <div ref={endRef} className="oc-end" aria-hidden="true" />
    </div>
  );
}

/** 展开后的细节：法律依据 → 事实依据 → 风险提示（固定顺序）。 */
function ArgDetail({
  id,
  x,
  d,
  setD,
  live,
  plain,
  busy,
  openText,
  setOpenText,
}: {
  id: string;
  x: OutlineItemView;
  d: OutlineDraft;
  setD: (d: OutlineDraft) => void;
  live: ReadonlyMap<string, boolean>;
  plain: (s: string | null | undefined) => string;
  busy: boolean;
  openText: string | null;
  setOpenText: (k: string | null) => void;
}) {
  const off = new Set(d.dropBasis[x.arg_id] ?? []);
  const facts = argFacts(x, d, live);
  const groups = x.basis.map((b, i) => ({ b, i })).filter(({ b, i }) => !off.has(i) && (b.elements?.length ?? 0) > 0);
  const elCount = groups.reduce((n, g) => n + (g.b.elements?.length ?? 0), 0);
  const missing = groups.reduce((n, g) => n + (g.b.elements ?? []).filter((e) => elementEvidence(e, facts, live).text.startsWith("缺证据")).length, 0);
  const exceptions = x.basis.map((b, i) => ({ b, i })).filter(({ b, i }) => !off.has(i) && !!b.exceptions?.trim());
  // 事实原文就地写在要件下面（第二轮评审：只写“事实 2”要另找）；没挂在任何要件上的事实单列在末尾
  const linked = new Set(groups.flatMap(({ b }) => (b.elements ?? []).flatMap((e) => elementEvidence(e, facts, live).refs)));
  const unlinked = facts.filter((f) => !linked.has(f.n));
  return (
    <div className="oc-detail" id={id}>
      {x.basis.length > 0 && (
        <section className="oc-sec" aria-label="法律依据">
          <h4 className="oc-sec-h">
            法律依据<span className="oc-sec-n">引用 {x.basis.length - off.size} / {x.basis.length} 条</span>
          </h4>
          <ul className="outline-basis oc-laws">
            {x.basis.map((b, i) => {
              const key = `${x.arg_id}-${i}`;
              const isOff = off.has(i);
              const badge = basisBadge(b);
              const mode = modeText(b.mode);
              return (
                <li key={key} className={`oc-law-item${isOff ? " outline-dropped" : ""}`}>
                  <div className="oc-law-row">
                    <label className="oc-check">
                      <input
                        type="checkbox"
                        checked={!isOff}
                        disabled={busy}
                        onChange={(e) => {
                          const cur = new Set(d.dropBasis[x.arg_id] ?? []);
                          if (e.target.checked) cur.delete(i);
                          else cur.add(i);
                          setD({ ...d, dropBasis: { ...d.dropBasis, [x.arg_id]: [...cur] } });
                        }}
                        aria-label={`引用这条依据：${basisName(b)}`}
                      />
                      <span className="oc-law">{basisName(b)}</span>
                    </label>
                    <span className={`oc-state tone-${badge.tone}`} title={badge.detail}>
                      <span className="oc-dot" aria-hidden="true" />
                      {badge.label}
                    </span>
                    {mode && <span className={`oc-mode${b.mode === "analogy" ? " tone-warn" : ""}`}>{mode}</span>}
                    {b.article_text && (
                      <button type="button" className="oc-tool oc-article-btn" onClick={() => setOpenText(openText === key ? null : key)} aria-expanded={openText === key}>
                        {openText === key ? "收起原文" : "条文原文"}
                      </button>
                    )}
                  </div>
                  {!isOff && badge.tone !== "ok" && <p className={`oc-law-warn tone-${badge.tone}`}>{badge.detail}</p>}
                  {!isOff && b.note && (
                    <p className="oc-law-why">
                      <span className="oc-k">助手理由</span>
                      {plain(b.note)}
                    </p>
                  )}
                  {openText === key && b.article_text && <blockquote className="outline-article">{b.article_text}</blockquote>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(groups.length > 0 || facts.length > 0) && (
        <section className="oc-sec" aria-label="事实依据">
          <h4 className="oc-sec-h">
            事实依据
            {elCount > 0 && <span className="oc-sec-n">{missing > 0 ? `${elCount} 个要件，${missing} 个缺证据` : `${elCount} 个要件都有着落`}</span>}
          </h4>
          {groups.map(({ b, i }) => (
            <div key={i} className="oc-el-group">
              <div className="oc-el-group-h">{basisShort(b)}</div>
              <ul className="outline-elements oc-elements" aria-label={`${basisShort(b)}的构成要件`}>
                {(b.elements ?? []).map((e, ei) => {
                  const ev = elementEvidence(e, facts, live);
                  const backing = facts.filter((f) => ev.refs.includes(f.n)).map((f) => plain(f.statement)).join("；");
                  return (
                    <li key={ei} className={`oc-el tone-${ev.tone}`}>
                      <span className="oc-dot" aria-hidden="true" />
                      <span className="oc-el-main">
                        <span className="outline-element oc-el-text">{plain(e.element)}</span>
                        {backing && (
                          <span className="oc-el-fact" title={backing}>
                            {backing}
                          </span>
                        )}
                      </span>
                      <span className={`oc-el-ev tone-${ev.tone}`}>
                        {ev.refs.length > 0 && <span className="oc-el-ref">事实 {ev.refs.join("、")}</span>}
                        {ev.text}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {unlinked.length > 0 && (
            <ol className={`outline-facts oc-facts${groups.length === 0 ? " is-only" : ""}`} aria-label={groups.length > 0 ? "论点还引用了这些事实" : "引用的事实"}>
              {groups.length > 0 && <li className="oc-facts-h">论点还引用了</li>}
              {unlinked.map((f) => (
                <li key={f.n}>
                  <span className="oc-fact-n">事实 {f.n}</span>
                  <span className="oc-fact-text">{plain(f.statement)}</span>
                  <span className={`oc-fact-state tone-${!f.fact_id ? "gray" : f.confirmed ? "ok" : "warn"}`}>{!f.fact_id ? "助手转述" : f.confirmed ? "已确认" : "待你确认"}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {/* 第二轮评审：没有但书与反驳时也要写明“没有列出”，否则律师以为是漏了 */}
      <section className="oc-sec oc-sec-risk" aria-label="风险与对方抗辩">
        <h4 className="oc-sec-h">风险与对方抗辩</h4>
        {exceptions.length === 0 && !x.counter ? (
          <p className="oc-risk-none">助手没有列出但书或对方可能的反驳——请自行判断。</p>
        ) : (
          <dl className="oc-risks">
            {exceptions.map(({ b, i }) => (
              <div key={i} className="oc-risk">
                <dt>但书与例外 · {basisShort(b)}</dt>
                <dd>{plain(b.exceptions)}</dd>
              </div>
            ))}
            {x.counter && (
              <div className="oc-risk">
                <dt>对方可能这样反驳</dt>
                <dd>{plain(x.counter)}</dd>
              </div>
            )}
          </dl>
        )}
      </section>
    </div>
  );
}

/** “规则”弹出说明：原来卡头三行的规则与三种颜色的含义收进这里（点开看，点别处或按 Esc 收起）。 */
function RulesTip() {
  const [on, setOn] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!on) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOn(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOn(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [on]);
  return (
    <div className="oc-rules" ref={ref}>
      <button type="button" className="oc-tool" aria-expanded={on} aria-controls={id} onClick={() => setOn((v) => !v)}>
        <Icon.question /> 规则
      </button>
      {on && (
        <div className="oc-rules-pop" id={id} role="dialog" aria-label="确认规则">
          <ul className="oc-rules-list">
            <li>助手只按你采用的论点与依据起草；你确认之前不会出文书。</li>
            <li>系统核对条文是否存在、版本是否有效；能否撑住论点由你判断。</li>
            <li>若助手绕过确认产出文书，会标为“论点未经确认”，签发时须写明不确认的理由。</li>
          </ul>
          <ul className="oc-legend">
            <li className="tone-ok">
              <span className="oc-dot" aria-hidden="true" />
              <b>依据已核</b>条文与版本已核，要件都有事实
            </li>
            <li className="tone-warn">
              <span className="oc-dot" aria-hidden="true" />
              <b>有疑点</b>要件缺证据、事实待你确认、类推适用或条文未核实
            </li>
            <li className="tone-risk">
              <span className="oc-dot" aria-hidden="true" />
              <b>依据有问题</b>条文核对未通过，或法规库未收录
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
