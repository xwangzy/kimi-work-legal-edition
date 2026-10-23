/**
 * 问答（无事项）（第 03 篇 §4.1、第 02 篇 §9.3 Chat 模式与 §12、第 04 篇 §5.3）：
 * 不读任何事项；问题经出站闸门令牌化，并做本人可见事项的当事人词典检查——命中当事人限制（L3b）事项的当事人即拦截，
 * 命中其他事项的当事人同样拦截并给出“到事项中处理”的链接（方案为“提示”，偏离 D-22）；服务端不持久化问答内容，历史只在本机。
 * 回答流式显示：发送后问题先显示出来，回答按内核推送的部分内容（chat.delta）逐步显示；完成后换成保存下来的记录（含引用核对）。
 * 中途中断或被拦截时丢弃半截回答，只显示“未能取得回答”。
 */
import { scrollBehavior } from "../lib/ui-prefs.ts";
import { useEffect, useRef, useState } from "react";
import { api, onKernelEvent, type ChatMessage } from "../api.ts";
import { nav } from "../App.tsx";
import { Icon } from "../components/Icons.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { QA_CITATION_KIND, qaCitationLine, type QaCitationsView } from "../lib/qa-citations.ts";
import { fmtTime, fmtWhen } from "../lib/labels.ts";

export function ChatPage({ conversationId }: { conversationId?: string | undefined }) {
  const [list, setList] = useState<{ conversation_id: string; title: string; updated_at: string }[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<{ reason: string; message: string; matters?: { matter_id: string; title: string }[] } | null>(null);
  const [err, setErr] = useState("");
  /** 删除这个问答：先问一句再删（删除后找不回来）。 */
  const [askDelete, setAskDelete] = useState(false);
  /** 正在回答的问题与到目前为止的回答（流式）；conv 是发问时所在的会话（新问答为 undefined）。 */
  const [pending, setPending] = useState<{ question: string; draft: string; conv: string | undefined } | null>(null);
  const streamRef = useRef<string | null>(null);
  const convRef = useRef(conversationId);
  convRef.current = conversationId;
  const endRef = useRef<HTMLDivElement>(null);
  const loadList = () => api.chatList().then((r) => setList(r.conversations)).catch((e) => setErr(e.message));
  useEffect(() => {
    void loadList();
  }, []);
  useEffect(
    () =>
      onKernelEvent((m) => {
        if (m?.type === "chat.delta" && m.stream_id === streamRef.current && typeof m.text === "string") setPending((p) => (p ? { ...p, draft: m.text } : p));
      }),
    [],
  );
  useEffect(() => {
    setBlocked(null);
    setAskDelete(false);
    // 换了会话：正在回答的那条只在它自己的会话里显示；切回来时接着显示（复核 Q5-06：原来清掉了，回答到了也不刷新）
    if (!conversationId) {
      setMessages([]);
      return;
    }
    api.chatGet(conversationId).then((r) => setMessages(r.messages)).catch((e) => setErr(e.message));
  }, [conversationId]);
  useEffect(() => {
    // 新版 Chromium 的 scrollIntoView 返回 Promise：不能作为 effect 的返回值
    void endRef.current?.scrollIntoView({ behavior: scrollBehavior() });
  }, [messages, pending]);

  const send = async () => {
    const t = text.trim();
    // 一次只问一个问题（复核 Q5-01：回车不看按钮是否灰着，回答生成中再回车会并发两问）
    if (!t || streamRef.current) return;
    const from = conversationId;
    const streamId = `qs_${crypto.randomUUID().replace(/-/g, "")}`;
    streamRef.current = streamId;
    setBusy(true);
    setErr("");
    setBlocked(null);
    setText("");
    setPending({ question: t, draft: "", conv: from });
    const settle = () => {
      if (streamRef.current !== streamId) return false;
      streamRef.current = null;
      setPending(null);
      return true;
    };
    try {
      const r = await api.chatSend({ ...(from ? { conversation_id: from } : {}), text: t, stream_id: streamId });
      // 等回答期间换了会话：不把结果放进别的会话；切回了这个会话的照常显示
      if (!settle() || (convRef.current !== from && convRef.current !== r.conversation_id)) {
        if (!r.blocked) void loadList();
        return;
      }
      if (r.blocked) {
        setBlocked(r.blocked);
        setText(t);
      } else {
        setMessages(r.messages);
        if (r.conversation_id !== from) nav(`/chat/${r.conversation_id}`);
        void loadList();
      }
    } catch (e) {
      if (settle() && convRef.current === from) {
        setErr((e as Error).message);
        setText(t);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!conversationId) return;
    try {
      await api.chatDelete(conversationId);
      setAskDelete(false);
      await loadList();
      nav("/chat");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const answeringHere = !!pending && pending.conv === conversationId;

  return (
    <div className="chat">
      <aside className="chat-list">
        <button className="btn-ghost chat-new" onClick={() => nav("/chat")}><Icon.plus /> 新问答</button>
        {list.map((c) => (
          <button key={c.conversation_id} className={`sidebar-link${c.conversation_id === conversationId ? " active" : ""}`} onClick={() => nav(`/chat/${c.conversation_id}`)} title={c.title}>
            {c.title}
          </button>
        ))}
        {list.length === 0 && <p className="muted">还没有问答。</p>}
      </aside>
      <main className="chat-main">
        {/* 一句话说清楚（Y4 C-1）；机制放进“了解更多” */}
        <div className="chat-notice">
          {/* 首句先说能做什么（U1 §1.6：原来首屏第一句是“不会读取……”，太防御） */}
          一般法律问题直接问；要结合案卷材料，到事项里发起任务。
          <details className="chat-more">
            <summary>了解更多</summary>
            发送前，问题里能识别的姓名、证件号、账号、联系方式会换成代号（识别依靠规则与名单，可能有遗漏），并与你的事项当事人名单比对：涉及“客户要求不上云”事项的当事人会被拦下。问答不读取事项材料。问题经 Kimi Work 的安全通道发给 Kimi 模型；问答记录只保存在这台电脑上。
          </details>
        </div>
        {/* 问答记录只在这台电脑上，留存到你删除（驻留面第 27 类）：原来没有删除的入口 */}
        {conversationId && !answeringHere && (
          <div className="chat-tools">
            {askDelete ? (
              <span>
                删除后找不回来。{" "}
                <button className="btn-ghost btn-sm" onClick={() => void remove()}>删除</button>{" "}
                <button className="btn-link" onClick={() => setAskDelete(false)}>取消</button>
              </span>
            ) : (
              <button className="btn-link" onClick={() => setAskDelete(true)}>删除这个问答</button>
            )}
          </div>
        )}
        <div className="chat-messages">
          {messages.length === 0 && !blocked && !(pending && pending.conv === conversationId) && (
            <div className="chat-empty">
              <h2>法律问答</h2>
              <p className="muted">可以这样问（点一下填入）：</p>
              {/* 空态给出可点击的示例问题（Y4 C-2） */}
              <div className="chat-examples">
                {["股权转让中，未实缴出资股东的补足责任如何认定？", "买卖合同逾期付款违约金过高时，法院一般如何调整？", "劳动合同到期不续签，用人单位需要支付经济补偿吗？"].map((q) => (
                  <button key={q} className="chip chat-example" onClick={() => setText(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.message_id} className={`msg msg-${m.role}`}>
              {m.role === "assistant" ? <Markdown text={m.text} /> : <div className="msg-text">{m.text}</div>}
              {m.citations && <CitationCheck c={m.citations} />}
              <div className="msg-meta" title={fmtTime(m.created_at)}>{fmtWhen(m.created_at)}</div>
            </div>
          ))}
          {pending && pending.conv === conversationId && (
            <>
              {/* 切走再切回来时问题已从本机记录载入：不再重复显示 */}
              {messages.at(-1)?.role !== "user" && (
                <div className="msg msg-user">
                  <div className="msg-text">{pending.question}</div>
                </div>
              )}
              <div className="msg msg-assistant" aria-live="polite" aria-busy="true">
                {pending.draft ? <Markdown text={pending.draft} /> : <div className="msg-pending muted">正在回答…</div>}
              </div>
            </>
          )}
          {blocked && (
            <div className={`banner ${blocked.reason === "l3b_party" ? "banner-red" : "banner-orange"}`}>
              {blocked.message}
              {blocked.matters && blocked.matters.length > 0 && (
                <div className="banner-actions">
                  {blocked.matters.map((m) => (
                    <button key={m.matter_id} className="btn-link" onClick={() => nav(`/matter/${m.matter_id}`)}>到事项「{m.title}」中处理</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {err && <div className="banner banner-red">{err}</div>}
          <div ref={endRef} />
        </div>
        <div className="composer chat-composer">
          <textarea
            placeholder="输入法律问题（不要粘贴案件材料；涉及具体当事人请在事项内处理）"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-bar">
            <span className="spacer" />
            {/* 问答页回车发送，与任务输入框（Ctrl / ⌘ + 回车）不同：写明（余项续复核 RC-B-15） */}
            {/* 内容安全说明（D-142，10-23 拍板接受“先显示后撤回”）：回答边生成边显示，被内容安全规则拦下时已显示的部分会撤回 */}
            <span className="send-hint muted" title="回答边生成边显示；如果被内容安全规则拦下，已经显示的部分会撤回，改为“未能取得回答”，这次回答不保存。">回答边写边显示，被内容安全规则拦下时会撤回</span>
            <span className="send-hint muted" aria-hidden="true">回车发送 · Shift + 回车换行</span>
            <button className="send" disabled={busy || !text.trim()} onClick={() => void send()} aria-label="发送" title="发送（回车）"><Icon.send /></button>
          </div>
        </div>
      </main>
    </div>
  );
}

/** 回答下面的引用核对（B-6）：一行结论，点开逐条看。 */
function CitationCheck({ c }: { c: QaCitationsView }) {
  const line = qaCitationLine(c);
  return (
    <details className={`msg-cite msg-cite-${line.tone}`}>
      <summary>{line.text}</summary>
      <ul>
        {c.items.map((i, n) => (
          <li key={n}>
            <span className="mono">{i.raw}</span> · {i.partial ? "核到（只核到条号）" : QA_CITATION_KIND[i.kind]}
            {i.reason && (i.kind !== "ok" || i.partial) ? `：${i.reason}` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}
