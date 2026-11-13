/**
 * 确认卡与提问卡（第 03 篇 §4.3、§8.2；第 02 篇 §9.5）。卡片内容由内核按待决审批重算（不采信 Agent 的说法），
 * 审批卡独立于聊天文本——模型输出里的“已批准”字样不触发任何权限。批准语义（本次 / 本任务内 / 改写后）不变，只改呈现（UIUX P0-5）。
 *
 * 写确认卡的规则（后续开发遵守）：
 * 1. 一张卡只问一件事，标题写成动词短语（“要联网查一条资料”）。
 * 2. 字段最多三项：会做什么 / 发给谁、发什么 / 费用；“为什么”放标题下一行灰字。
 * 3. 主按钮永远是最安全、又能让任务继续的选项（改写后检索）；风险更高的选项（按原文发出）收进“更多选项”并二次确认。
 * 4. “本任务内不再询问”做成勾选框，不单独占按钮。
 * 5. 过期不惩罚：说明跳过了什么。
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { ApprovalCard, QuestionAnswer, QuestionCard } from "../api.ts";
import { Markdown, tokens as renderTokens } from "./Markdown.tsx";
import { Icon } from "./Icons.tsx";
import { sendView } from "../lib/query-diff.ts";
import { splitPlan } from "../lib/plan-sections.ts";
import { buildAnswers, isAnswered, optionLabelText, pickOption, typeOther, unansweredCount, type AnswerDraft } from "../lib/question-answers.ts";

/** 卡片标题（动词短语，律师语言）。 */
export const KIND_TITLES: Record<ApprovalCard["kind"], string> = {
  plan: "请确认工作计划",
  search: "要联网查一条资料",
  fetch: "要打开一个网页",
  image: "要把图片直接发给 AI",
  budget: "本任务的用量上限到了",
  schedule: "要创建定时任务",
  stop: "要停下一项正在进行的计算",
  manual: "这一步需要你同意",
  connector: "要使用外部资料库",
  other: "这一步需要你同意",
};

function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ApprovalCardView({ card, tokenMap, busy, onDecide }: {
  card: ApprovalCard;
  tokenMap?: Map<string, string | null>;
  busy?: boolean;
  onDecide: (d: { decision: "approve" | "reject"; scope?: "once" | "task"; variant?: "original" | "generalized"; feedback?: string }) => void;
}) {
  const [feedback, setFeedback] = useState("");
  // 修改意见框出现在点“提修改意见”的那一处（计划卡顶部或展开全文后的底部）
  const [showFeedback, setShowFeedback] = useState<false | "top" | "bottom">(false);
  const [forTask, setForTask] = useState(false);
  const [confirmOriginal, setConfirmOriginal] = useState(false);
  const [planFull, setPlanFull] = useState(false);
  const [left, setLeft] = useState(() => Date.parse(card.expires_at) - Date.now());
  useEffect(() => {
    const t = setInterval(() => setLeft(Date.parse(card.expires_at) - Date.now()), 1000);
    return () => clearInterval(t);
  }, [card.expires_at]);
  const expired = left <= 0;
  const urgent = !expired && left < 120_000;
  const variants = card.variants ?? [];
  const taskOk = card.scope_options.includes("task");
  // 检索卡：改写后的一般性查询是安全默认；“按原文”只在允许时出现（L3a 只能改写后），且收进更多选项（第 02 篇 §8.3）
  const isSearchCred = variants.length > 0;
  const generalizedOk = variants.includes("generalized");
  const originalOk = !isSearchCred || variants.includes("original");
  const timer = (
    <span className={`cc-exp${urgent ? " cc-exp-urgent" : ""}`}>{expired ? "已超时" : urgent ? `${countdown(left)} 后自动跳过` : ""}</span>
  );
  if (expired) {
    return (
      <div className={`card-confirm card-${card.kind} card-expired`} aria-live="polite">
        <div className="cc-head"><Icon.shield /> {KIND_TITLES[card.kind]} {timer}</div>
        <p className="muted">已超时，助手跳过了这一步。需要的话，可以在下方追问里让它重新做这一步。</p>
      </div>
    );
  }
  if (card.kind === "plan") {
    // V18 A6：主操作放在标题行右侧；正文默认露“怎么审 / 会交出什么 / 需要你决定的事”，“步骤”等其余各节展开全文看（lib/plan-sections）；不再用内滚动框
    const parts = splitPlan(card.preview.plan ?? "");
    const folded = parts.restTitles.length > 0 && !planFull;
    const planActions = (at: "top" | "bottom") => (
      <div className="cc-actions">
        <button className="btn-primary" disabled={busy} onClick={() => onDecide({ decision: "approve", scope: "once" })}>按这个计划开始</button>
        {showFeedback === at ? (
          // V14 第 39 批（V13 W6 复测真实发生）：“提修改意见”原位变成“退回修改”，连点两下就以缺省文字“请按意见修改计划”退回了计划。
          // 没写意见时不能退回；可以收起输入框
          <>
            <button className="btn-ghost" disabled={busy || !feedback.trim()} title={feedback.trim() ? "" : "先写下你希望怎么改"} onClick={() => onDecide({ decision: "reject", feedback: feedback.trim() })}>退回修改</button>
            <button className="btn-link" disabled={busy} onClick={() => setShowFeedback(false)}>收起</button>
          </>
        ) : (
          <button className="btn-ghost" disabled={busy} onClick={() => setShowFeedback(at)}>提修改意见</button>
        )}
      </div>
    );
    const feedbackBox = <textarea className="cc-feedback" placeholder="写下你希望怎么改（会转给助手）" value={feedback} onChange={(e) => setFeedback(e.target.value)} autoFocus />;
    return (
      <div className="card-confirm card-plan" aria-live="polite">
        <div className="cc-top">
          <div className="cc-head"><Icon.list /> 请确认工作计划 {timer}</div>
          {planActions("top")}
        </div>
        <div className="cc-why">助手会按这个计划做：同意就开始；要调整，写下修改意见退回给它。</div>
        {showFeedback === "top" && feedbackBox}
        <div className="cc-plan">
          {card.preview.plan ? <Markdown text={folded ? parts.head : card.preview.plan} tokenMap={tokenMap} /> : <p className="muted">（计划正文为空）</p>}
        </div>
        {parts.restTitles.length > 0 &&
          (folded ? (
            <button className="btn-link cc-fold" aria-expanded={false} onClick={() => setPlanFull(true)}>
              展开全文（另有 {parts.restTitles.length} 节：{parts.restTitles.join("、")}）
            </button>
          ) : (
            <div className="cc-bottom">
              {showFeedback === "bottom" && feedbackBox}
              {planActions("bottom")}
              <button className="btn-link cc-fold" aria-expanded={true} onClick={() => { setPlanFull(false); if (showFeedback === "bottom") setShowFeedback("top"); }}>收起全文</button>
            </div>
          ))}
      </div>
    );
  }
  const sendText = isSearchCred && generalizedOk ? card.preview.send_generalized : card.preview.send_original;
  const approve = () =>
    onDecide(
      isSearchCred
        ? generalizedOk
          ? { decision: "approve", scope: forTask && taskOk ? "task" : "once", variant: "generalized" }
          : { decision: "approve", scope: "once", variant: "original" }
        : { decision: "approve", scope: forTask && taskOk ? "task" : "once" },
    );
  return (
    <div className={`card-confirm card-${card.kind}`} aria-live="polite">
      <div className="cc-head">
        <Icon.shield /> {KIND_TITLES[card.kind]} {timer}
      </div>
      {card.why && <div className="cc-why">{card.why}</div>}
      <dl className="cc-body">
        <dt>会做什么</dt>
        {/* 检索卡一律不显示 Agent 写的标题（可能含改写前的当事人名称，UIUX 增量评审 P0-B；复核 B4-B15：没有改写变体的检索卡同样不显示）；
            实际发出的内容见下一行，原文只在“更多选项”里出现 */}
        <dd>{card.kind === "search" ? "联网检索公开的法律资料" : renderTokens(card.title, tokenMap)}</dd>
        <dt>发给谁、发什么</dt>
        <dd>
          {card.destination}
          {isSearchCred && generalizedOk && card.preview.send_original !== undefined && card.preview.send_generalized !== undefined && card.preview.send_original !== card.preview.send_generalized ? (
            <QuerySend original={card.preview.send_original} rewritten={card.preview.send_generalized} />
          ) : (
            sendText !== undefined && <div className="cc-send">将发出：“{sendText}”</div>
          )}
          {card.preview.url && <div className="cc-send mono">{card.preview.url}</div>}
          {card.preview.detail && <div>{renderTokens(card.preview.detail, tokenMap)}</div>}
        </dd>
        {card.cost && (
          <>
            <dt>预计用量</dt>
            <dd>{card.cost}</dd>
          </>
        )}
      </dl>
      {card.agent_note && (
        <details className="cc-details">
          <summary>查看助手给出的理由</summary>
          <div className="cc-note">{renderTokens(card.agent_note, tokenMap)}</div>
        </details>
      )}
      {card.why_detail && (
        <details className="cc-details">
          <summary>为什么要问我</summary>
          <div className="cc-note">{card.why_detail}</div>
        </details>
      )}
      <div className="cc-actions">
        {(generalizedOk || originalOk) && (
          <button className="btn-primary" disabled={busy} onClick={approve}>
            {isSearchCred ? (generalizedOk ? "用改写后的查询检索" : "按原文检索") : "允许"}
          </button>
        )}
        <button className="btn-ghost" disabled={busy} onClick={() => onDecide({ decision: "reject", feedback: "律师拒绝了该动作" })}>
          {card.kind === "search" ? "不查了" : "不允许"}
        </button>
      </div>
      {taskOk && (
        <label className="cc-check">
          <input type="checkbox" checked={forTask} onChange={(e) => setForTask(e.target.checked)} />
          {isSearchCred ? "这个任务后面的检索都按改写后的说法发出，不再问我" : "这个任务后面的同类操作不再问我"}
        </label>
      )}
      {isSearchCred && generalizedOk && originalOk && card.preview.send_original !== undefined && (
        <details className="cc-details">
          <summary>更多选项</summary>
          {confirmOriginal ? (
            <div className="cc-more">
              <p>原文会包含当事人名称：“{card.preview.send_original}”。确定按原文发出吗？</p>
              <button className="btn-ghost btn-danger" disabled={busy} onClick={() => onDecide({ decision: "approve", scope: "once", variant: "original" })}>确定按原文检索（仅这一次）</button>
              <button className="btn-link" onClick={() => setConfirmOriginal(false)}>取消</button>
            </div>
          ) : (
            <button className="btn-link" onClick={() => setConfirmOriginal(true)}>按原文检索（会发出当事人名称）</button>
          )}
        </details>
      )}
    </div>
  );
}

/** 输入框按内容自动增高，最多 4 行（V16）。 */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
  const pad = el.offsetHeight - el.clientHeight + parseFloat(getComputedStyle(el).paddingTop || "0") + parseFloat(getComputedStyle(el).paddingBottom || "0");
  el.style.height = `${Math.min(el.scrollHeight, line * 4 + pad)}px`;
  el.style.overflowY = el.scrollHeight > line * 4 + pad ? "auto" : "hidden";
}

export function QuestionCardView({ card, tokenMap, busy, onAnswer, outlineLock }: {
  card: QuestionCard;
  tokenMap?: Map<string, string | null>;
  busy?: boolean;
  onAnswer: (answers: Record<string, QuestionAnswer>) => void;
  /**
   * 论点确认题和别的题在同一张卡里（第 31 批）：“已确认……”这一项跟着上面的论点卡走——论点卡确认前不能选（否则助手以为确认了、
   * 文书工具却拒绝出文书），确认后自动选上；“先不起草”照常可选。
   */
  outlineLock?: { qid: string; confirm: string; confirmed: boolean };
}) {
  // 选项与“其他”互斥（复核 B4-B16：此前“其他”有文字时静默覆盖已选项，界面上两者同时呈选中）
  const [draft, setDraft] = useState<AnswerDraft>({ sel: {}, other: {} });
  const lockQid = outlineLock?.qid;
  const lockConfirmed = outlineLock?.confirmed ?? false;
  const lockConfirm = outlineLock?.confirm;
  useEffect(() => {
    if (lockQid && lockConfirm && lockConfirmed) setDraft((d) => ({ sel: { ...d.sel, [lockQid]: [lockConfirm] }, other: { ...d.other, [lockQid]: "" } }));
  }, [lockQid, lockConfirm, lockConfirmed]);
  const { sel, other } = draft;
  const answered = isAnswered(card.questions, draft);
  const missing = unansweredCount(card.questions, draft);
  const idBase = useId();
  return (
    <div className="card-confirm card-question">
      <div className="cc-top">
        <div className="cc-head"><Icon.question /> 需要你定一下{card.questions[0]?.header ? `：${card.questions[0].header}` : ""}</div>
      </div>
      {card.questions.map((q) => (
        <div key={q.id} className="q-block">
          {/* 只有一个问题时标题已写明，不再重复 */}
          {q.header && card.questions.length > 1 && <div className="q-header">{renderTokens(q.header, tokenMap)}</div>}
          <div className="q-text" id={`${idBase}-${q.id}`}>{renderTokens(q.question, tokenMap)}</div>
          <div className="q-options" role={q.multi_select ? "group" : "radiogroup"} aria-labelledby={`${idBase}-${q.id}`}>
            {q.options.map((o) => {
              const on = (sel[q.id] ?? []).includes(o.id);
              const lockedOut = !!outlineLock && q.id === outlineLock.qid && o.id === outlineLock.confirm && !outlineLock.confirmed;
              return (
                <button
                  key={o.id}
                  type="button"
                  role={q.multi_select ? "checkbox" : "radio"}
                  aria-checked={on}
                  className={`q-option${on ? " on" : ""}`}
                  disabled={lockedOut}
                  onClick={() => setDraft((d) => pickOption(d, q, o.id))}
                >
                  <span>
                    <span className="q-mark" aria-hidden="true">{on ? "✓" : q.multi_select ? "☐" : "○"}</span> {renderTokens(optionLabelText(o.label), tokenMap)}
                  </span>
                  {o.description && <small>{renderTokens(o.description, tokenMap)}</small>}
                </button>
              );
            })}
          </div>
          {outlineLock && q.id === outlineLock.qid && (
            <div className="cc-hint muted">{outlineLock.confirmed ? "已在上面的论点卡确认。" : "要按论点起草，请先在上面的论点卡确认；也可以选“先不起草”。"}</div>
          )}
          {/* V16：多行、随内容自动增高（最多 4 行），律师写一句完整的话看得全；提交逻辑不变 */}
          <textarea className="q-other" rows={1} placeholder="其他（直接输入；会取代上面的选择）" aria-label="其他（直接输入）" value={other[q.id] ?? ""} ref={autoGrow} onChange={(e) => { autoGrow(e.target); setDraft((d) => typeOther(d, q, e.target.value)); }} />
        </div>
      ))}
      {/* 不能提交的原因写在卡片上（读屏与触屏也能看到），不只放在按钮的悬停提示里 */}
      {!answered && <div className="cc-hint muted">{card.questions.length > 1 ? `还有 ${missing} 题未选：` : ""}先选一个选项，或在“其他”里写下你的意思。</div>}
      <div className="cc-actions">
        <button className="btn-primary" disabled={busy || !answered} onClick={() => onAnswer(buildAnswers(card.questions, draft))}>
          确定
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => onAnswer(Object.fromEntries(card.questions.map((q) => [q.id, { kind: "skipped" } as QuestionAnswer])))}>跳过</button>
      </div>
    </div>
  );
}

/** 检索将发出的改写稿：改写处加底色；原文被去掉的部分只说“去掉了几处”，不在首屏显示（UIUX 增量评审 P0-B）。 */
function QuerySend({ original, rewritten }: { original: string; rewritten: string }) {
  // 卡片每秒随倒计时重渲染：差异只在查询变化时重算（复核 B4-B15）
  const v = useMemo(() => sendView(original, rewritten), [original, rewritten]);
  const removedText = v.removedCount > 0 ? `已去掉 ${v.removedCount} 处当事人信息` : "";
  return (
    <div className="cc-send" aria-label={`将发出：${rewritten}。${removedText}`}>
      将发出：“
      {v.shown.map((p, i) => (p.kind === "added" ? <mark key={i} className="q-diff-add">{p.text}</mark> : <span key={i}>{p.text}</span>))}”
      {removedText && <div className="cc-note muted">不会发出当事人名称。</div>}
    </div>
  );
}
