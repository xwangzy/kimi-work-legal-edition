/**
 * 任务页“起草前确认论点与依据”卡（v9.4 第 19 批 C-04；评审 C1 §1、§4.1“它撑得住这句话吗”）。
 * 每条论点：留 / 删、可改写；依据逐条显示核验情况与法规库条文原文，可去掉不用的；事实写明是否已确认。
 * 确认后 Agent 只按确认版起草（内核门禁：确认之前不能生成文书）。文字为令牌形态，按事项令牌表还原显示；律师改写的论点按原文保存。
 */
import { useState } from "react";
import { basisStateText, decisionsOf, emptyDraft, keptCount, unconfirmedFactsOf, type OutlineDraft, type OutlineView } from "../lib/outline.ts";

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
  const [openText, setOpenText] = useState<string | null>(null);
  // 一并确认事实（第 28 批）：律师不必离开任务页去事项页逐条确认；缺省勾上，可以取消
  const [withFacts, setWithFacts] = useState(true);
  const kept = keptCount(outline, d);
  const pendingFacts = unconfirmedFactsOf(outline, d);
  return (
    <div className="card outline-card" role="region" aria-label="起草前确认论点与依据">
      <div className="card-title">起草前请确认：{outline.doc_kind}的论点与依据</div>
      <p className="muted">助手按你留下的论点起草；删掉的不写，改写的按你的写法，去掉的依据不引。确认之前文书工具不会出文书；助手若绕过确认产出文书，会标为“论点未经确认”，签发时须写明不确认的理由。</p>
      <ol className="outline-list">
        {outline.items.map((x) => {
          const dropped = !!d.drop[x.arg_id];
          const droppedBasis = new Set(d.dropBasis[x.arg_id] ?? []);
          return (
            <li key={x.arg_id} className={dropped ? "outline-dropped" : undefined}>
              <div className="outline-claim">
                <label className="lifecycle-check">
                  <input
                    type="checkbox"
                    checked={!dropped}
                    disabled={busy}
                    onChange={(e) => setD({ ...d, drop: { ...d.drop, [x.arg_id]: !e.target.checked } })}
                    aria-label={`保留这条论点：${plain(x.claim).slice(0, 30)}`}
                  />
                </label>
                <textarea
                  rows={2}
                  disabled={busy || dropped}
                  value={d.claim[x.arg_id] ?? plain(x.claim)}
                  onChange={(e) => setD({ ...d, claim: { ...d.claim, [x.arg_id]: e.target.value } })}
                  aria-label="论点（可改写）"
                />
              </div>
              {x.basis.length > 0 && (
                <ul className="outline-basis">
                  {x.basis.map((b, i) => {
                    const key = `${x.arg_id}-${i}`;
                    const off = droppedBasis.has(i);
                    return (
                      <li key={key} className={off ? "outline-dropped" : undefined}>
                        <label className="lifecycle-check">
                          <input
                            type="checkbox"
                            checked={!off}
                            disabled={busy || dropped}
                            onChange={(e) => {
                              const cur = new Set(d.dropBasis[x.arg_id] ?? []);
                              if (e.target.checked) cur.delete(i);
                              else cur.add(i);
                              setD({ ...d, dropBasis: { ...d.dropBasis, [x.arg_id]: [...cur] } });
                            }}
                            aria-label={`引用这条依据：${b.matched ?? b.law}${b.article ? `第 ${b.article} 条` : ""}`}
                          />
                          《{b.matched ?? b.law}》{b.article ? `第 ${b.article} 条` : ""}
                        </label>
                        <span className={`cite-state cite-${b.check}`}>{basisStateText(b)}</span>
                        {b.note && <div className="muted">怎么支持：{plain(b.note)}</div>}
                        {b.article_text && (
                          <>
                            <button className="btn-link" onClick={() => setOpenText(openText === key ? null : key)} aria-expanded={openText === key}>
                              {openText === key ? "收起条文原文" : "看条文原文"}
                            </button>
                            {openText === key && <blockquote className="outline-article">{b.article_text}</blockquote>}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {x.facts.length > 0 && (
                <ul className="outline-facts">
                  {x.facts.map((f, i) => (
                    <li key={i}>
                      {plain(f.statement)} <span className={`tag ${f.confirmed ? "tag-gray" : "tag-beta"}`}>{f.confirmed ? "已确认事实" : "未经你确认"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {x.counter && <div className="muted">对方可能这样反驳：{plain(x.counter)}</div>}
            </li>
          );
        })}
      </ol>
      {pendingFacts.length > 0 && (
        <label className="lifecycle-check outline-facts-confirm">
          <input type="checkbox" checked={withFacts} disabled={busy} onChange={(e) => setWithFacts(e.target.checked)} />
          同时确认上面标“未经你确认”的 {pendingFacts.length} 条事实（我已对照材料核过）
          {!withFacts && <span className="muted">：不确认的话，助手照常起草，这些事实在文书里标“【待确认】”</span>}
        </label>
      )}
      <textarea rows={2} placeholder="给助手的补充要求（可不填），例如：违约金按合同第 8.2 条计算" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} aria-label="补充要求" />
      <div className="card-actions">
        <button className="btn-primary" disabled={busy || kept === 0} title={kept === 0 ? "至少留一条论点" : undefined} onClick={() => onConfirm(decisionsOf(outline, d, plain), note.trim(), withFacts && pendingFacts.length > 0)}>
          确认并开始起草（{kept} 条论点）
        </button>
        {canStop && (
          <button className="btn-ghost" disabled={busy} onClick={onStop}>
            先不起草
          </button>
        )}
      </div>
    </div>
  );
}
