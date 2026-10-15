/**
 * “将发送什么”（v9.2 §3.4；调研 Y4 §3.3、Y5 §3.3；P1-10、P1-11 ③）：开始前确认里的三行说明 + 发送视图 + 疑似姓名核对。
 * - 第 1 行去向与留存口径、第 2 行会离开电脑的内容与按原文发送的类别、第 3 行发送前替换为代号的计数与疑似未替换的姓名；
 * - 发送视图显示模型会看到的样子（代号为胶囊，悬停时经受审计、限量的还原接口逐个还原；疑似姓名橙色标出）；
 * - 疑似姓名核对：逐个判定“是姓名 → 加入当事人名单”“不是姓名 → 本事项不再提示”；L3a 事项核对完之前不能开始。
 */
import { useEffect, useMemo, useState } from "react";
import { api, type SendPreview, type SendSummaryView, type SuspectView } from "../api.ts";
import { restoreTokens } from "../lib/tokens.ts";
import { TOKEN_CATEGORY_LABELS } from "../lib/labels.ts";

function replacedLine(s: SendSummaryView): string {
  const parts = Object.entries(s.replaced)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k, n]) => `${TOKEN_CATEGORY_LABELS[k] ?? k} ${n}`);
  return parts.length ? `${s.replaced_total} 处换成代号（${parts.join(" · ")}）` : "没有找到需要换成代号的个人信息";
}

export function SendSummary({
  matterId,
  summary,
  documentIds,
  goal,
  mustReview,
  onReviewed,
  followup,
}: {
  matterId: string;
  summary: SendSummaryView;
  documentIds: string[];
  goal?: string;
  mustReview: boolean;
  onReviewed: () => void;
  /** 追问：上一轮的对话也会作为上下文再次发出（复核 S5B-17）。 */
  followup?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const n = summary.suspects.unreviewed;
  // 取消勾选的材料不再预览（复核 S5B-07）
  useEffect(() => {
    if (preview && !documentIds.includes(preview)) setPreview(documentIds[0] ?? null);
  }, [documentIds, preview]);
  return (
    <div className="send-summary" aria-label="将发送什么">
      {followup && <div className="muted">追问时，上一轮的对话内容（已换成代号的形态）也会作为上下文再次发给 AI。</div>}
      <div>
        {summary.docs > 0 ? `${summary.docs} 份材料约 ${summary.chars.toLocaleString()} 字` : `任务说明约 ${summary.chars.toLocaleString()} 字`}
        {summary.truncated ? "（只统计了前一部分）" : ""}：{replacedLine(summary)}
        {summary.orgs_kept ? "；公司名称保留原文" : "；当事人名单里的公司名称也换成代号"}
      </div>
      {n > 0 && (
        <div className={mustReview ? "send-suspects send-suspects-block" : "send-suspects"}>
          另有 {n} 处像姓名的文字没有换成代号
          {mustReview ? "，这是敏感事项：核对完才能开始。" : "。"}
          <button className="btn-link" onClick={() => setReview(true)}>
            核对
          </button>
        </div>
      )}
      {documentIds.length > 0 && (
        <button className="btn-link" onClick={() => setPreview(documentIds[0]!)}>
          看看 AI 会看到什么 ▸
        </button>
      )}
      {/* 核对后重新估价：计数变了就重新取发送视图（按计数作键，避免显示核对前的旧版本） */}
      {preview && <SendPreviewDrawer key={`${summary.replaced_total}:${summary.suspects.unreviewed}`} matterId={matterId} documentIds={documentIds} initial={preview} onClose={() => setPreview(null)} />}
      {review && (
        <SuspectReview
          matterId={matterId}
          documentIds={documentIds}
          goal={goal}
          onClose={() => setReview(false)}
          onDone={() => {
            setReview(false);
            onReviewed();
          }}
        />
      )}
    </div>
  );
}

/** 代号胶囊：悬停或聚焦时逐个还原（只在本机界面显示，不写回）。 */
function TokenChip({ matterId, token, category }: { matterId: string; token: string; category: string }) {
  // 显示时才还原、离开即收起（复核 S5B-05：真值不常驻屏幕）；还原失败如实提示
  const [value, setValue] = useState<string | null | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const tail = /·([0-9A-Z]{6,10})〕$/.exec(token)?.[1]?.slice(-3) ?? "";
  const reveal = () => {
    setShown(true);
    if (value !== undefined) return;
    void restoreTokens(matterId, token)
      .then((m) => setValue(m.get(token) ?? null))
      .catch(() => setValue(null));
  };
  const hide = () => setShown(false);
  const label = `${category}${tail ? ` ${tail}` : ""}`;
  return (
    <span
      className="token-chip"
      role="button"
      tabIndex={0}
      aria-label={shown && value ? `${label}，本机还原为 ${value}` : `${label}（代号，按回车查看本机还原）`}
      onMouseEnter={reveal}
      onMouseLeave={hide}
      onFocus={reveal}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (shown) hide();
          else reveal();
        }
      }}
    >
      {label}
      {shown && value ? <span className="token-chip-value">：{value}</span> : null}
      {shown && value === null ? <span className="token-chip-value">：无法还原</span> : null}
    </span>
  );
}

export function SendPreviewDrawer({ matterId, documentIds, initial, onClose }: { matterId: string; documentIds: string[]; initial: string; onClose: () => void }) {
  const [doc, setDoc] = useState(initial);
  const [data, setData] = useState<SendPreview | null>(null);
  const [err, setErr] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [sel, setSel] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!documentIds.includes(doc)) setDoc(documentIds.includes(initial) ? initial : (documentIds[0] ?? initial));
  }, [documentIds, initial, doc]);
  useEffect(() => {
    setData(null);
    setErr("");
    api
      .sendPreview(matterId, doc)
      .then(setData)
      .catch((e) => setErr((e as Error).message));
  }, [matterId, doc, reloadKey]);
  // 选中没被换掉的名字 → 加入当事人名单（Y4 §3.3；复核 S5B-04）：之后发送前替换
  const pickSelection = () => {
    const t = (window.getSelection()?.toString() ?? "").trim();
    setSel(t.length >= 2 && t.length <= 20 && !/[〔〕\n]/.test(t) ? t : "");
  };
  const addParty = async () => {
    const name = sel;
    setSel("");
    try {
      await api.upsertParty(matterId, { name, kind: "person", aliases: [] });
      setNote(`已把“${name}”加入当事人名单，之后发送前会换成代号。`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const segments: { kind: "text" | "token" | "suspect"; text: string; category?: string }[] = [];
  if (data) {
    const marks = [...data.tokens.map((t) => ({ ...t, kind: "token" as const })), ...data.suspects.map((s) => ({ ...s, kind: "suspect" as const, category: "" }))].sort((a, b) => a.start - b.start);
    let at = 0;
    for (const m of marks) {
      if (m.start < at) continue;
      if (m.start > at) segments.push({ kind: "text", text: data.sent_text.slice(at, m.start) });
      segments.push({ kind: m.kind, text: data.sent_text.slice(m.start, m.end), category: m.kind === "token" ? m.category : undefined });
      at = m.end;
    }
    if (at < data.sent_text.length) segments.push({ kind: "text", text: data.sent_text.slice(at) });
  }
  return (
    <section className="send-panel" aria-label="AI 会看到的内容">
      <div className="send-panel-head">
        <b>AI 会看到的内容</b>
        <button className="btn-link" onClick={onClose}>收起</button>
      </div>
      {documentIds.length > 1 && (
        <div className="send-preview-docs" role="tablist">
          {documentIds.map((id, i) => (
            <button key={id} role="tab" aria-selected={id === doc} className={`tab${id === doc ? " active" : ""}`} onClick={() => setDoc(id)}>
              材料 {i + 1}
            </button>
          ))}
        </div>
      )}
      {err && <div className="banner banner-red">{err}</div>}
      {!data && !err && <div className="muted">正在生成……</div>}
      {data && (
        <>
          <div className="muted">
            《{data.filename}》：{Object.values(data.replaced).reduce<number>((a, b) => a + (b ?? 0), 0)} 处换成代号
            {data.suspects.length ? `；橙色是像姓名但没有换掉的文字` : ""}
            {data.orgs_kept ? "；公司名称保留原文" : "；当事人名单里的公司名称也换成代号"}
            {data.truncated ? `；只显示前 ${data.sent_text.length.toLocaleString()} 字` : ""}
          </div>
          {sel && (
            <div className="banner-actions">
              <button className="btn btn-sm" onClick={() => void addParty()}>
                把“{sel}”加入当事人名单（自然人）
              </button>
            </div>
          )}
          {note && <div className="muted">{note}</div>}
          <div className="send-preview-text doc-text" onMouseUp={pickSelection} onKeyUp={pickSelection}>
            {segments.map((s, i) =>
              s.kind === "token" ? (
                <TokenChip key={i} matterId={matterId} token={s.text} category={s.category ?? ""} />
              ) : s.kind === "suspect" ? (
                <mark key={i} className="suspect-mark">
                  {s.text}
                </mark>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </div>
          <p className="muted">识别依靠规则与当事人名单，可能有遗漏。看到没被换掉的名字，选中它就可以加入当事人名单，下次发送前会替换。</p>
        </>
      )}
    </section>
  );
}

export function SuspectReview({ matterId, documentIds, goal, onClose, onDone }: { matterId: string; documentIds: string[]; goal?: string; onClose: () => void; onDone: () => void }) {
  const [items, setItems] = useState<SuspectView[] | null>(null);
  const docKey = useMemo(() => documentIds.join(","), [documentIds]);
  const [decisions, setDecisions] = useState<Record<string, "name" | "not_name">>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api
      .listSuspects(matterId, documentIds, goal?.trim() || undefined)
      .then((r) => setItems(r.suspects))
      .catch((e) => setErr((e as Error).message));
  }, [matterId, docKey, goal]);
  const all = items ?? [];
  const decided = all.filter((s) => decisions[s.value]).length;
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.reviewSuspects(
        matterId,
        all.filter((s) => decisions[s.value]).map((s) => ({ value: s.value, decision: decisions[s.value]! })),
      );
      // 不能加入名单的条目（例如常用词）如实告诉律师，不当作已处理（复核 S5B-08）
      if (r.rejected.length > 0) {
        setErr(`以下没能加入当事人名单，请改判或在当事人名单里手工添加：${r.rejected.join("；")}`);
        return;
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="send-panel" aria-label="核对像姓名的文字">
      <div className="send-panel-head">
        <b>核对像姓名的文字</b>
      </div>
      <p className="muted">这些文字像人名，但不在当事人名单里，发送前不会被换成代号。请逐个确认：是姓名的会加入当事人名单（之后发送前替换）；不是的，本事项不再提示。</p>
      {err && <div className="banner banner-red">{err}</div>}
      {!items && !err && <div className="muted">正在检查……</div>}
      {items && items.length === 0 && <div className="muted">没有需要核对的文字。</div>}
      {all.length > 0 && (
        <table className="data suspect-table">
          <thead>
            <tr>
              <th>文字</th>
              <th>出现处</th>
              <th>判断</th>
            </tr>
          </thead>
          <tbody>
            {all.map((s) => (
              <tr key={s.value}>
                <td>
                  <b>{s.value}</b>
                  {s.occurrences > 1 ? <span className="muted"> × {s.occurrences}</span> : null}
                </td>
                <td className="muted">…{s.context}…</td>
                <td>
                  <div className="seg" role="radiogroup" aria-label={`${s.value} 是否姓名`}>
                    <button role="radio" aria-checked={decisions[s.value] === "name"} className={`seg-btn${decisions[s.value] === "name" ? " on" : ""}`} onClick={() => setDecisions((d) => ({ ...d, [s.value]: "name" }))}>
                      是姓名
                    </button>
                    <button role="radio" aria-checked={decisions[s.value] === "not_name"} className={`seg-btn${decisions[s.value] === "not_name" ? " on" : ""}`} onClick={() => setDecisions((d) => ({ ...d, [s.value]: "not_name" }))}>
                      不是
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="banner-actions">
        <button className="btn btn-sm" onClick={onClose}>
          稍后
        </button>
        <button className="btn-primary btn-sm" disabled={busy || all.length === 0 || decided < all.length} onClick={() => void save()}>
          {decided < all.length ? `还有 ${all.length - decided} 处未判断` : "保存判断"}
        </button>
      </div>
    </section>
  );
}
