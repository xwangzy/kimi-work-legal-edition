/**
 * 问答（无事项）（第 03 篇 §4.1、第 02 篇 §9.3 Chat 模式与 §12、第 04 篇 §5.3）：
 * 不读任何事项；问题经出站闸门令牌化，并做本人可见事项的当事人词典检查——命中当事人限制（L3b）事项的当事人即拦截，
 * 命中其他事项的当事人同样拦截并给出“到事项中处理”的链接（方案为“提示”，偏离 D-22）；服务端不持久化问答内容，历史只在本机。
 * 回答流式显示：发送后问题先显示出来，回答按内核推送的部分内容（chat.delta）逐步显示；完成后换成保存下来的记录（含引用核对）。
 * 中途中断或被拦截时丢弃半截回答，只显示“未能取得回答”。
 */
import { scrollBehavior } from "../lib/ui-prefs.ts";
import { useEffect, useRef, useState } from "react";
import { api, onKernelEvent, type ChatMessage, type ChatModelChoice } from "../api.ts";
import { nav } from "../App.tsx";
import { Icon } from "../components/Icons.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { QA_CITATION_KIND, qaCitationLine, type QaCitationsView } from "../lib/qa-citations.ts";
import { fmtTime, fmtWhen } from "../lib/labels.ts";
import { notifyDataChanged } from "../lib/events.ts";
import { chatWaitView, deepToggleTitle, type ChatPhase, type ThinkingControl } from "../lib/chat-wait.ts";
import { fmtWait } from "../lib/waiting.ts";
import { ensureAiNotice } from "../lib/ai-notice.ts";
import { KimiPulse, LoadError } from "../components/Loading.tsx";

/** 问答输入框下的常驻提示（D-225）：问答用于一般法律问题；具体案件在事项里发起（事项里才有该案的客户授权与令牌化规则）。 */
export const CHAT_SCOPE_NOTE = "这里用于一般法律问题；涉及具体案件的材料与当事人，请在事项里发起。";

export function ChatPage({ conversationId }: { conversationId?: string | undefined }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /**
   * messages 属于哪个会话（第 51 批）：从侧栏点开旧对话时，在它的记录读回来之前不闪“新对话”欢迎页，
   * 也不把上一个对话的消息留在新地址下——显示对话骨架（延迟 160ms 出现，快的话一闪都没有）。
   */
  const [msgConv, setMsgConv] = useState<string | undefined>(conversationId === undefined ? undefined : "");
  /** 打开旧对话没读到：说清楚没读到并给重试（不显示成空对话）。 */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<{ reason: string; message: string; matters?: { matter_id: string; title: string }[] } | null>(null);
  const [err, setErr] = useState("");
  /** 删除这个问答：先问一句再删（删除后找不回来）。 */
  const [askDelete, setAskDelete] = useState(false);
  /** 正在回答的问题与到目前为止的回答（流式）；conv 是发问时所在的会话（新问答为 undefined）。 */
  const [pending, setPending] = useState<{ question: string; draft: string; conv: string | undefined; startedAt: number; deep: boolean; control?: ThinkingControl | undefined; phase: ChatPhase; thoughtChars: number } | null>(null);
  const streamRef = useRef<string | null>(null);
  // 深度思考开关（第 48 批）：关＝快速回答（通常十几秒），开＝先充分思考再答（常要 1～3 分钟）；记在本机偏好，没记过按内核缺省
  const [deep, setDeep] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(DEEP_KEY);
      return v === "1";
    } catch {
      return false;
    }
  });
  const deepChosen = useRef<boolean>(false);
  useEffect(() => {
    try {
      deepChosen.current = localStorage.getItem(DEEP_KEY) !== null;
    } catch {
      deepChosen.current = false;
    }
  }, []);
  const toggleDeep = () => {
    const next = !deep;
    deepChosen.current = true;
    setDeep(next);
    try {
      localStorage.setItem(DEEP_KEY, next ? "1" : "0");
    } catch {
      // 记不住只影响下次打开
    }
  };
  // 等待回答时每秒刷新一次已用时间
  const [now, setNow] = useState(() => Date.now());
  const waiting = pending !== null;
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  // 问答模型（第 47 批，Kimi 输入框右下的模型选择）：选项来自内核（只列云端已配置的别名），记在本机偏好
  const [models, setModels] = useState<ChatModelChoice[]>([]);
  const [route, setRoute] = useState<string | null>(() => {
    try {
      return localStorage.getItem(MODEL_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    void api
      .chatModels()
      .then((r) => {
        setModels(r.choices);
        // 律师没自己选过：开关跟内核缺省走
        if (!deepChosen.current && typeof r.default_deep === "boolean") setDeep(r.default_deep);
        // 记住的模型已不在可选之列（运营改了路由）：回到缺省
        setRoute((cur) => (cur && r.choices.some((c) => c.alias === cur) ? cur : r.default));
      })
      .catch(() => setModels([]));
  }, []);
  const chooseModel = (alias: string) => {
    setRoute(alias);
    try {
      localStorage.setItem(MODEL_KEY, alias);
    } catch {
      // 记不住只影响下次打开
    }
  };
  const convRef = useRef(conversationId);
  convRef.current = conversationId;
  const endRef = useRef<HTMLDivElement>(null);
  // 问答记录在侧栏 Chat 模式里（第 47 批，Kimi Work 同款）：发送、删除后通知侧栏刷新
  const loadList = async () => notifyDataChanged();
  useEffect(
    () =>
      onKernelEvent((m) => {
        if (m?.type === "chat.delta" && m.stream_id === streamRef.current && typeof m.text === "string") setPending((p) => (p ? { ...p, draft: m.text, phase: "writing" } : p));
        // 回答进度（第 48 批）：思考中（带思考字数）/ 撰写中
        if (m?.type === "chat.progress" && m.stream_id === streamRef.current && (m.phase === "thinking" || m.phase === "writing")) {
          setPending((p) => (p ? { ...p, phase: m.phase, thoughtChars: Number.isSafeInteger(m.thought_chars) ? m.thought_chars : p.thoughtChars } : p));
        }
      }),
    [],
  );
  useEffect(() => {
    setBlocked(null);
    setAskDelete(false);
    setLoadErr(null);
    // 换了会话：正在回答的那条只在它自己的会话里显示；切回来时接着显示（复核 Q5-06：原来清掉了，回答到了也不刷新）
    if (!conversationId) {
      setMessages([]);
      setMsgConv(undefined);
      return;
    }
    let live = true;
    api
      .chatGet(conversationId)
      .then((r) => {
        if (!live) return;
        setMessages(r.messages);
        setMsgConv(conversationId);
      })
      .catch((e) => live && setLoadErr((e as Error).message ?? ""));
    return () => {
      live = false;
    };
  }, [conversationId, reloadKey]);
  // 正在打开旧对话（记录还没读回来）：不显示欢迎页，也不显示别的对话的消息
  const opening = !!conversationId && msgConv !== conversationId && loadErr === null;
  useEffect(() => {
    // 新版 Chromium 的 scrollIntoView 返回 Promise：不能作为 effect 的返回值
    void endRef.current?.scrollIntoView({ behavior: scrollBehavior() });
  }, [messages, pending]);

  const send = async () => {
    const t = text.trim();
    // 一次只问一个问题（复核 Q5-01：回车不看按钮是否灰着，回答生成中再回车会并发两问）
    if (!t || streamRef.current) return;
    // 第一次用 AI 时先给律师本人看数据去向告知（第 51 批；看过一次即不再出现）
    if (!(await ensureAiNotice(api.aiNotice, api.ackAiNotice))) return;
    const from = conversationId;
    const streamId = `qs_${crypto.randomUUID().replace(/-/g, "")}`;
    streamRef.current = streamId;
    setBusy(true);
    setErr("");
    setBlocked(null);
    setText("");
    setPending({ question: t, draft: "", conv: from, startedAt: Date.now(), deep, control: selectedModel?.thinking, phase: "waiting", thoughtChars: 0 });
    const settle = () => {
      if (streamRef.current !== streamId) return false;
      streamRef.current = null;
      setPending(null);
      return true;
    };
    try {
      const r = await api.chatSendWithModel({ ...(from ? { conversation_id: from } : {}), text: t, stream_id: streamId, ...(route ? { route } : {}), deep });
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
        setMsgConv(r.conversation_id);
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

  // 当前所选（或缺省）模型：深度思考开关的说明与显示取决于它（第 49 批）
  const selectedModel = models.find((c) => c.alias === route) ?? models.find((c) => c.default) ?? null;
  return (
    <div className={`chat${messages.length === 0 && !pending && !opening && loadErr === null ? " chat-blank" : ""}`}>
      <main className="chat-main">
        {/* 一句话说清楚（Y4 C-1）；机制放进“了解更多” */}
        <div className="chat-notice">
          {/* 首句先说能做什么（U1 §1.6：原来首屏第一句是“不会读取……”，太防御） */}
          一般法律问题直接问；要结合案卷材料，到事项里发起任务。
          <details className="chat-more">
            <summary>了解更多</summary>
            发送前，问题里能识别的姓名、证件号、账号、联系方式会换成代号（识别依靠规则与名单，可能有遗漏），并与你的事项当事人名单比对：涉及“客户要求不上云”事项的当事人会被拦下。问答不读取事项材料。问题经 Kimi Work 的安全通道发给 Kimi 模型；问答记录只保存在这台电脑上。
            {/* 内容安全说明（D-142，10-23 拍板接受“先显示后撤回”） */}
            回答边生成边显示；如果被内容安全规则拦下，已经显示的部分会撤回，改为“未能取得回答”，这次回答不保存。
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
          {opening && <ChatSkeleton />}
          {loadErr !== null && <LoadError what="这个对话的记录" message={loadErr} onRetry={() => setReloadKey((k) => k + 1)} />}
          {!opening && loadErr === null && messages.length === 0 && !blocked && !(pending && pending.conv === conversationId) && (
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
          {!opening && messages.map((m) => (
            <div key={m.message_id} className={`msg msg-${m.role}`}>
              {m.role === "assistant" ? <Markdown text={m.text} /> : <div className="msg-text">{m.text}</div>}
              {m.citations && <CitationCheck c={m.citations} />}
              <div className="msg-meta" title={fmtTime(m.created_at)}>
                {m.role === "assistant" && m.route_label ? `${m.route_label} · ` : ""}
                {fmtWhen(m.created_at)}
              </div>
            </div>
          ))}
          {pending && pending.conv === conversationId && (
            <>
              {/* 切走再切回来时问题已从本机记录载入：不再重复显示 */}
              {(opening || messages.at(-1)?.role !== "user") && (
                <div className="msg msg-user">
                  <div className="msg-text">{pending.question}</div>
                </div>
              )}
              <div className="msg msg-assistant" aria-live="polite" aria-busy="true">
                {pending.draft && <Markdown text={pending.draft} />}
                <ChatWait pending={pending} now={now} />
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
            placeholder="输入法律问题，例如：股东未经其他股东同意对外转让股权，合同是否有效？"
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
            {/* 深度思考：开关实际控制什么随所选模型（K3 调推理强度、K2.6 开关思考）；模型不可控时不显示开关，免得点了不起作用 */}
            {selectedModel?.thinking !== "none" && (
              <button
                type="button"
                className={`deep-toggle${deep ? " on" : ""}`}
                aria-pressed={deep}
                onClick={toggleDeep}
                title={deepToggleTitle(deep, selectedModel?.thinking, selectedModel?.label)}
              >
                <span className="deep-dot" aria-hidden="true" />
                深度思考
              </button>
            )}
            {/* 第 66 批：与首页同一个模型选择器；选项来自云端模型目录（内核 chat.models 只列问答入口可用的） */}
            <ModelPicker
              title="问答模型"
              choices={models.map((c) => ({ id: c.alias, label: c.label, description: c.note.replace(/^缺省[，,、]\s*/, ""), available: true, isDefault: c.default }))}
              value={route}
              onChange={chooseModel}
              foot="按实际用量计入你的额度；具体型号由云端统一配置。"
            />
            {/* 问答页回车发送，与任务输入框（Ctrl / ⌘ + 回车）不同：写明（余项续复核 RC-B-15） */}
            <span className="send-hint muted" aria-hidden="true">回车发送 · Shift + 回车换行</span>
            <button className="send" disabled={busy || !text.trim()} onClick={() => void send()} aria-label="发送" title="发送（回车）"><Icon.send /></button>
          </div>
          {/* D-225：问答不绑定事项、不查客户授权——常驻说明适用范围，案件材料与当事人请在事项里发起 */}
          <p className="chat-scope-note">{CHAT_SCOPE_NOTE}</p>
        </div>
      </main>
    </div>
  );
}

const MODEL_KEY = "kwl.chat.model";
const DEEP_KEY = "kwl.chat.deep";

/**
 * 等回答时的状态（第 48 批；第 51 批统一等待反馈）：Kimi 蓝点呼吸 + 一句话说明现在在做什么 + 已用时间 + 补充说明。
 * 蓝点本身就是“还在动”的信号，不再叠一条不定长进度条（不画假进度，视觉也更干净）；已用时间用全库统一写法 fmtWait。
 * 回答已经开始逐字出现时只留一行“正在撰写回答… 已用时间”，不挡正文。
 * 没有“停止回答”：内核问答接口（chat.send）目前没有取消或中止的方法，不在界面上做一个点了不起作用的按钮。
 */
function ChatWait({ pending, now }: { pending: { draft: string; startedAt: number; deep: boolean; control?: ThinkingControl | undefined; phase: ChatPhase; thoughtChars: number }; now: number }) {
  const elapsedMs = Math.max(0, now - pending.startedAt);
  const phase: ChatPhase = pending.draft ? "writing" : pending.phase;
  const v = chatWaitView({ deep: pending.deep, phase, elapsedMs, thoughtChars: pending.thoughtChars, control: pending.control });
  return (
    <div className={`chat-wait${phase === "writing" ? " chat-wait-writing" : ""}`} role="status">
      <div className="chat-wait-head">
        <KimiPulse size="md" />
        <span className="chat-wait-title">{v.title}</span>
        <span className="chat-wait-time">已用时 {fmtWait(elapsedMs)}</span>
      </div>
      {v.hint && <div className="chat-wait-hint">{v.hint}</div>}
    </div>
  );
}

/** 打开旧对话时的占位：一问一答两组气泡形状（第 51 批），读屏念“正在载入对话”。 */
function ChatSkeleton() {
  return (
    <div className="kwl-skel chat-skel" role="status" aria-label="正在载入对话">
      <span className="kwl-skel-line chat-skel-q" />
      <span className="kwl-skel-line chat-skel-a" />
      <span className="kwl-skel-line chat-skel-a2" />
      <span className="kwl-skel-line chat-skel-q chat-skel-q2" />
      <span className="kwl-skel-line chat-skel-a" />
    </div>
  );
}

/** 问答模型选择（真实可用：选项与校验都在内核，所选别名随问题发给网关计量）。 */
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
