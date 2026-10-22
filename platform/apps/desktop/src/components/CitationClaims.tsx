/**
 * 论断—依据对照（v9.4 第 20 批 C-03；评审 C1 §4.2 ③、§4.4）：成果里每处引用一行——左边是成果里的那句话，右边是依据原文，
 * 下面是三层状态（来源 / 版本 / 支持）；系统核到来源与版本的，律师逐条点“确认支持 / 标为不支持 / 我已知悉”。
 * 系统核验与律师确认分开显示：系统核过的不显示成律师认可的绿色。
 */
import { useState } from "react";
import { api } from "../api.ts";
import { citeLayers, citeTone, claimsSummary, markOf, sortClaims, type ArtifactCitations, type CitationItem } from "../lib/citation-review.ts";
import { tokens } from "./Markdown.tsx";

const TONE_TEXT = { red: "不通过", gray: "没法核对", orange: "支持待判", confirmed: "律师已确认", ack: "律师已知悉" } as const;

export function CitationClaims({ artifactVersionId, citations, tokenMap, readOnly, onChanged }: {
  artifactVersionId: string;
  citations: ArtifactCitations | null | undefined;
  tokenMap?: Map<string, string | null>;
  /** 已签发、已退回或没有权限：只看不改。 */
  readOnly?: boolean;
  onChanged?: (c: ArtifactCitations | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  if (!citations) return <p className="muted">没有这份成果的引用核验结果。</p>;
  if (!citations.checked) return <p className="muted">系统读不出这份文件的文字，没有逐条列出引用：请对照原文人工核对。</p>;
  const items = citations.items ?? [];
  if (items.length === 0) return <p className="muted">这份成果里没有认出法条或案号引用。</p>;
  // 角标序号按成果里出现的先后（与预览一致），列表按要处理的先后排
  const order = new Map(items.map((i, n) => [i, n + 1]));
  const decide = async (i: CitationItem, decision: CitationItem["decision"]) => {
    if (!i.key) return;
    setBusy(i.key);
    setErr("");
    try {
      const r = await api.decideCitation(artifactVersionId, i.key, decision ?? null);
      onChanged?.(r.citations);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="claims" aria-label="论断与依据">
      <div className="claims-summary">{claimsSummary(items)}</div>
      {err && <div className="banner banner-red">{err}</div>}
      {sortClaims(items).map((i) => {
        const tone = citeTone(i);
        const l = citeLayers(i);
        return (
          <div key={i.key ?? i.raw} className={`claim claim-${tone}`}>
            <div className="claim-head">
              <span className={`cite-mark cite-tone-${tone}`} aria-hidden="true">{markOf(order.get(i) ?? 0)}</span>
              <span className={`claim-tone claim-tone-${tone}`}>{TONE_TEXT[tone]}</span>
              <span className="claim-raw">{i.raw}</span>
            </div>
            <div className="claim-cols">
              <div className="claim-text">
                <div className="claim-k">成果里这样写</div>
                {i.claim ? tokens(i.claim, tokenMap) : <span className="muted">（没有取到原句）</span>}
              </div>
              <div className="claim-basis">
                <div className="claim-k">{i.law_name ? `${i.law_name}${i.effective ? `（${i.effective} 施行版）` : ""}` : "依据"}</div>
                {i.article_text ? <span className="claim-article">{i.article_text}</span> : <span className="muted">{i.kind === "ok" ? "法规库没有这一条的正文：请对照官方文本判断是否支持" : (i.reason ?? "系统没法核对")}</span>}
              </div>
            </div>
            <div className="claim-layers muted">
              来源 {l.source} · 版本 {l.version} · 支持 {l.support}
            </div>
            {i.kind === "ok" && !readOnly && (
              <div className="claim-actions">
                <button className={`btn btn-sm${i.decision === "supported" ? " on" : ""}`} aria-pressed={i.decision === "supported"} disabled={busy === i.key} onClick={() => void decide(i, i.decision === "supported" ? null : "supported")}>
                  确认支持
                </button>
                <button className={`btn btn-sm${i.decision === "unsupported" ? " on" : ""}`} aria-pressed={i.decision === "unsupported"} disabled={busy === i.key} onClick={() => void decide(i, i.decision === "unsupported" ? null : "unsupported")}>
                  标为不支持
                </button>
                <button className={`btn btn-sm${i.decision === "acknowledged" ? " on" : ""}`} aria-pressed={i.decision === "acknowledged"} disabled={busy === i.key} onClick={() => void decide(i, i.decision === "acknowledged" ? null : "acknowledged")}>
                  我已知悉
                </button>
              </div>
            )}
          </div>
        );
      })}
      {typeof citations.total === "number" && items.length < citations.total && (
        <p className="muted">只列出前 {items.length} 处，其余请对照成果原文核对。</p>
      )}
    </div>
  );
}
