/**
 * 问答（无事项）（第 03 篇 §4.1、第 02 篇 §9.3 Chat 模式与 §12、第 04 篇 §5.3）：
 * 不读任何事项；问题经出站闸门令牌化，并做本人可见事项的当事人词典检查——命中当事人限制（L3b）事项的当事人即拦截，
 * 命中其他事项的当事人同样拦截并给出“到事项中处理”的链接（方案为“提示”，偏离 D-22）；服务端不持久化问答内容，历史只在本机。
 */
import { useEffect, useRef, useState } from "react";
import { api, type ChatMessage } from "../api.ts";
import { nav } from "../App.tsx";
import { Icon } from "../components/Icons.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { fmtShortTime } from "../lib/labels.ts";

export function ChatPage({ conversationId }: { conversationId?: string | undefined }) {
  const [list, setList] = useState<{ conversation_id: string; title: string; updated_at: string }[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<{ reason: string; message: string; matters?: { matter_id: string; title: string }[] } | null>(null);
  const [err, setErr] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const loadList = () => api.chatList().then((r) => setList(r.conversations)).catch((e) => setErr(e.message));
  useEffect(() => {
    void loadList();
  }, []);
  useEffect(() => {
    setBlocked(null);
    if (!conversationId) {
      setMessages([]);
      return;
    }
    api.chatGet(conversationId).then((r) => setMessages(r.messages)).catch((e) => setErr(e.message));
  }, [conversationId]);
  useEffect(() => {
    // 新版 Chromium 的 scrollIntoView 返回 Promise：不能作为 effect 的返回值
    void endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr("");
    setBlocked(null);
    try {
      const r = await api.chatSend({ ...(conversationId ? { conversation_id: conversationId } : {}), text: t });
      if (r.blocked) {
        setBlocked(r.blocked);
      } else {
        setText("");
        setMessages(r.messages);
        if (r.conversation_id !== conversationId) nav(`/chat/${r.conversation_id}`);
        void loadList();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
        <div className="chat-notice">
          无事项问答：不读取任何事项材料；问题经出站闸门令牌化并做当事人词典检查后发给 Kimi 模型（经中软网关，不保存）；历史只在本机。涉及具体案件请在事项内处理。
        </div>
        <div className="chat-messages">
          {messages.length === 0 && !blocked && (
            <div className="chat-empty">
              <h2>法律问答</h2>
              <p className="muted">例如：“股权转让中未实缴出资股东的补足责任如何认定？”</p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.message_id} className={`msg msg-${m.role}`}>
              {m.role === "assistant" ? <Markdown text={m.text} /> : <div className="msg-text">{m.text}</div>}
              <div className="msg-meta">{fmtShortTime(m.created_at)}</div>
            </div>
          ))}
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
            <span className="chip chip-static">问答（只读）</span>
            <span className="spacer" />
            <button className="send" disabled={busy || !text.trim()} onClick={() => void send()} aria-label="发送"><Icon.send /></button>
          </div>
        </div>
      </main>
    </div>
  );
}
