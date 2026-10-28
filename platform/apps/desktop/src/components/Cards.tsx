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
import { buildAnswers, isAnswered, optionLabelText, pickOption, typeOther, unansweredCount, type AnswerDraft } from "../lib/question-answers.ts";

/** 卡片标题（动词短语，律师语言）。 */
export const KIND_TITLES: Record<ApprovalCard["kind"], string> = {
  plan: "请确认工作计划",
  search: "要联网查一条资料",
  fetch: "要打开一个网页",
  image: "要把图片直接发给 AI",
  budget: "本任务的预算用完了",
  schedule: "要创建定时任务",
  stop: "要停止一个后台任务",
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
  const [showFeedback, setShowFeedback] = useState(false);
  const [forTask, setForTask] = useState(false);
  const [confirmOriginal, setConfirmOriginal] = useState(false);
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
    return (
      <div className="card-confirm card-plan" aria-live="polite">
        <div className="cc-head"><Icon.list /> 请确认工作计划 {timer}</div>
        <div className="cc-plan">{card.preview.plan ? <Markdown text={card.preview.plan} tokenMap={tokenMap} /> : <p className="muted">（计划正文为空）</p>}</div>
        {showFeedback && <textarea className="cc-feedback" placeholder="写下你希望怎么改（会转给助手）" value={feedback} onChange={(e) => setFeedback(e.target.value)} autoFocus />}
        <div className="cc-actions">
          <button className="btn-primary" disabled={busy} onClick={() => onDecide({ decision: "approve", scope: "once" })}>按这个计划开始</button>
          {showFeedback ? (
            <button className="btn-ghost" disabled={busy} onClick={() => onDecide({ decision: "reject", feedback: feedback.trim() || "请按意见修改计划" })}>退回修改</button>
          ) : (
            <button className="btn-ghost" disabled={busy} onClick={() => setShowFeedback(true)}>提修改意见</button>
          )}
        </div>
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
            <dt>预计费用</dt>
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

export function QuestionCardView({ card, tokenMap, busy, onAnswer }: {
  card: QuestionCard;
  tokenMap?: Map<string, string | null>;
  busy?: boolean;
  onAnswer: (answers: Record<string, QuestionAnswer>) => void;
}) {
  // 选项与“其他”互斥（复核 B4-B16：此前“其他”有文字时静默覆盖已选项，界面上两者同时呈选中）
  const [draft, setDraft] = useState<AnswerDraft>({ sel: {}, other: {} });
  const { sel, other } = draft;
  const answered = isAnswered(card.questions, draft);
  const missing = unansweredCount(card.questions, draft);
  const idBase = useId();
  return (
    <div className="card-confirm card-question">
      <div className="cc-head"><Icon.question /> 需要你定一下{card.questions[0]?.header ? `：${card.questions[0].header}` : ""}</div>
      {card.questions.map((q) => (
        <div key={q.id} className="q-block">
          {/* 只有一个问题时标题已写明，不再重复 */}
          {q.header && card.questions.length > 1 && <div className="q-header">{renderTokens(q.header, tokenMap)}</div>}
          <div className="q-text" id={`${idBase}-${q.id}`}>{renderTokens(q.question, tokenMap)}</div>
          <div className="q-options" role={q.multi_select ? "group" : "radiogroup"} aria-labelledby={`${idBase}-${q.id}`}>
            {q.options.map((o) => {
              const on = (sel[q.id] ?? []).includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  role={q.multi_select ? "checkbox" : "radio"}
                  aria-checked={on}
                  className={`q-option${on ? " on" : ""}`}
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
          <input className="q-other" placeholder="其他（直接输入；会取代上面的选择）" aria-label="其他（直接输入）" value={other[q.id] ?? ""} onChange={(e) => setDraft((d) => typeOther(d, q, e.target.value))} />
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
