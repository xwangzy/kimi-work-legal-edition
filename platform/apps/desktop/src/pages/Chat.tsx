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
import { ModelPicker, useModelCatalog } from "../components/ModelPicker.tsx";
import { ComposerFrame, SendButton, sendOnEnter } from "../components/ComposerFrame.tsx";
import { modelChoices } from "../lib/model-choices.ts";
import { Markdown } from "../components/Markdown.tsx";
import { QA_CITATION_KIND, qaCitationLine, type QaCitationsView } from "../lib/qa-citations.ts";
import { fmtTime, fmtWhen } from "../lib/labels.ts";
import { notifyDataChanged } from "../lib/events.ts";
import { chatWaitView, deepToggleTitle, type ChatPhase, type ThinkingControl } from "../lib/chat-wait.ts";
import { fmtWait } from "../lib/waiting.ts";
import { ensureAiNotice } from "../lib/ai-notice.ts";
import { KimiPulse, LoadError } from "../components/Loading.tsx";
import { scopedKey } from "../lib/profile-scope.ts";

/**
 * 问答输入框下的常驻提示（D-225）：问答用于一般法律问题；具体案件在事项里发起（事项里才有该案的客户授权与令牌化规则）。
 * 第 72 批（D-303）：移到输入框外、框下居中一行，压成一句；细节在“了解更多”浮层里。
 */
export const CHAT_SCOPE_NOTE = "一般法律问题在这里问；涉及具体案件的材料与当事人，请在事项里发起";

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
  // 第 71 批（区域 2）：删除挪进标题行右侧的“…”菜单（原先是正文上方一条黑色文字链，像提示条的一部分）
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** 正在回答的问题与到目前为止的回答（流式）；conv 是发问时所在的会话（新问答为 undefined）。 */
  const [pending, setPending] = useState<{ question: string; draft: string; conv: string | undefined; startedAt: number; deep: boolean; control?: ThinkingControl | undefined; phase: ChatPhase; thoughtChars: number } | null>(null);
  const streamRef = useRef<string | null>(null);
  // 第 71 批第三轮：新问答在回答生成中就切到它的会话（侧栏选中）；每次发送只切一次
  const adoptedRef = useRef<string | null>(null);
  // 深度思考开关（第 48 批）：关＝快速回答（通常十几秒），开＝先充分思考再答（常要 1～3 分钟）；记在本机偏好，没记过按内核缺省
  const [deep, setDeep] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(scopedKey(DEEP_KEY));
      return v === "1";
    } catch {
      return false;
    }
  });
  const deepChosen = useRef<boolean>(false);
  useEffect(() => {
    try {
      deepChosen.current = localStorage.getItem(scopedKey(DEEP_KEY)) !== null;
    } catch {
      deepChosen.current = false;
    }
  }, []);
  const toggleDeep = () => {
    const next = !deep;
    deepChosen.current = true;
    setDeep(next);
    try {
      localStorage.setItem(scopedKey(DEEP_KEY), next ? "1" : "0");
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
  // 问答模型（第 47 批，Kimi 输入框右下的模型选择）。第 72 批（D-299）：选项改读云端模型目录 models.list("qa")（与首页任务同一来源、
  // 不可用的置灰写原因），所选走 models.select("qa")——与内核 model_prefs 统一；本机旧的 kwl.chat.model 只作一次性迁移。
  // 旧内核没有目录时退回 chat.models（只为取“深度思考”缺省与兜底选项）。
  const [qaCatalog, setQaCatalog] = useModelCatalog("qa");
  const [legacyModels, setLegacyModels] = useState<ChatModelChoice[]>([]);
  useEffect(() => {
    void api
      .chatModels()
      .then((r) => {
        setLegacyModels(r.choices);
        // 律师没自己选过：开关跟内核缺省走
        if (!deepChosen.current && typeof r.default_deep === "boolean") setDeep(r.default_deep);
      })
      .catch(() => setLegacyModels([]));
  }, []);
  const migrated = useRef(false);
  useEffect(() => {
    if (!qaCatalog || migrated.current) return;
    migrated.current = true;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(scopedKey(MODEL_KEY));
      localStorage.removeItem(scopedKey(MODEL_KEY));
    } catch {
      saved = null;
    }
    if (saved && saved !== qaCatalog.selected && qaCatalog.models.some((m) => m.id === saved && m.available))
      void api.modelsSelect("qa", saved).then(() => setQaCatalog((v) => (v ? { ...v, selected: saved! } : v))).catch(() => {});
  }, [qaCatalog, setQaCatalog]);
  const models: { alias: string; label: string; thinking?: ChatModelChoice["thinking"] }[] = qaCatalog ? qaCatalog.models.map((m) => ({ alias: m.id, label: m.label, thinking: m.thinking })) : legacyModels;
  const route: string | null = qaCatalog ? qaCatalog.selected : (legacyModels.find((c) => c.default)?.alias ?? null);
  const [modelErr, setModelErr] = useState("");
  const chooseModel = (alias: string) => {
    setModelErr("");
    if (!qaCatalog) return;
    void api
      .modelsSelect("qa", alias)
      .then(() => setQaCatalog((v) => (v ? { ...v, selected: alias } : v)))
      .catch((e) => setModelErr((e as Error).message));
  };
  const convRef = useRef(conversationId);
  convRef.current = conversationId;
  const endRef = useRef<HTMLDivElement>(null);
  // 问答记录在侧栏 Chat 模式里（第 47 批，Kimi Work 同款）：发送、删除后通知侧栏刷新
  const loadList = async () => notifyDataChanged();
  useEffect(
    () =>
      onKernelEvent((m) => {
        // 第 71 批第三轮：推送带会话编号——新问答在生成中就进入自己的会话（侧栏选中、问题气泡写“刚刚”），回答到了照常接上
        const sid = streamRef.current;
        if ((m?.type === "chat.delta" || m?.type === "chat.progress") && sid && m.stream_id === sid && typeof m.conversation_id === "string" && adoptedRef.current !== sid) {
          adoptedRef.current = sid;
          const cid: string = m.conversation_id;
          setPending((p) => (p && !p.conv ? { ...p, conv: cid } : p));
          if (!convRef.current) {
            nav(`/chat/${cid}`);
            void loadList();
          }
        }
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

  const send = async (again?: string) => {
    const t = (again ?? text).trim();
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
  /** 停止生成（第 71 批第三轮）：内核中止上游并保存已生成的部分（标“已停止”），chat.send 随即返回。 */
  const stop = () => {
    const id = streamRef.current;
    if (id) void api.chatStop(id).catch(() => {});
  };
  // 生成中按 Esc 停止（输入框外也行）
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  // 当前所选（或缺省）模型：深度思考开关的说明与显示取决于它（第 49 批）
  const selectedModel = models.find((c) => c.alias === route) ?? null;
  return (
    <div className={`chat${messages.length === 0 && !pending && !opening && loadErr === null ? " chat-blank" : ""}`}>
      <main className="chat-main">
        {/* 问答记录只在这台电脑上，留存到你删除（驻留面第 27 类）。第 71 批（区域 2）：删除收进右上角“…”菜单、红字、二次确认 */}
        {conversationId && !answeringHere && (
          <div className="chat-tools">
            {askDelete ? (
              <span className="chat-del-confirm" role="alertdialog" aria-label="确认删除这个问答">
                删除后找不回来。
                <button className="btn-ghost btn-sm btn-danger-text" onClick={() => void remove()}>删除</button>
                <button className="btn-ghost btn-sm" onClick={() => setAskDelete(false)}>取消</button>
              </span>
            ) : (
              <span className="chat-menu-wrap">
                <button className="icon-btn chat-menu-btn" aria-label="更多操作" aria-expanded={menuOpen} title="更多操作" onClick={() => setMenuOpen((v) => !v)}>
                  <Icon.more />
                </button>
                {menuOpen && (
                  <span className="chat-menu" role="menu">
                    <button role="menuitem" className="chat-menu-danger" onClick={() => { setMenuOpen(false); setAskDelete(true); }}>
                      删除这个问答…
                    </button>
                  </span>
                )}
              </span>
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
          {!opening && messages.map((m, i) => {
            // 第 71 批（区域 2）：回答下方常驻“复制 / 重新回答”（重新回答 = 把上一问再问一次，新回答接在后面；只在最后一条回答上）
            const isLast = i === messages.length - 1;
            const prevQ = m.role === "assistant" ? [...messages.slice(0, i)].reverse().find((x) => x.role === "user")?.text : undefined;
            return (
              <div key={m.message_id} className={`msg msg-${m.role}`}>
                {m.role === "assistant" ? <Markdown text={m.text} /> : <div className="msg-text">{m.text}</div>}
                {m.citations && <CitationCheck c={m.citations} />}
                <div className="msg-meta">
                  <span title={fmtTime(m.created_at)}>
                    {m.role === "assistant" && m.route_label ? `${m.route_label} · ` : ""}
                    {fmtWhen(m.created_at)}
                  </span>
                  {m.stopped && <span className="msg-stopped">已停止</span>}
                  {m.role === "assistant" && (
                    <span className="msg-actions">
                      <button
                        type="button"
                        className="msg-act"
                        onClick={() => {
                          void navigator.clipboard?.writeText(m.text).then(() => {
                            setCopied(m.message_id);
                            setTimeout(() => setCopied((c) => (c === m.message_id ? null : c)), 1500);
                          });
                        }}
                      >
                        {copied === m.message_id ? "已复制" : "复制"}
                      </button>
                      {isLast && prevQ && (
                        <button type="button" className="msg-act" disabled={busy} title="把上一问再问一次，新回答接在后面" onClick={() => void send(prevQ)}>
                          重新回答
                        </button>
                      )}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {pending && pending.conv === conversationId && (
            <>
              {/* 切走再切回来时问题已从本机记录载入：不再重复显示 */}
              {(opening || messages.at(-1)?.role !== "user") && (
                <div className="msg msg-user">
                  <div className="msg-text">{pending.question}</div>
                  <div className="msg-meta">刚刚</div>
                </div>
              )}
              {/* 逐字出现时最后一个字后面一根闪动的光标（第 71 批第三轮：跟在字后，不另起一行；样式表 .is-streaming） */}
              <div className={`msg msg-assistant${pending.draft ? " is-streaming" : ""}`} aria-live="polite" aria-busy="true">
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
        <div className="chat-composer-wrap">
          <ComposerFrame
            className="chat-composer"
            // 左槽：深度思考（与任务输入框的运行模式同一种胶囊）；模型不可控时不显示开关，免得点了不起作用
            left={
              selectedModel?.thinking !== "none" ? (
                <button type="button" className={`deep-toggle${deep ? " on" : ""}`} aria-pressed={deep} onClick={toggleDeep} title={deepToggleTitle(deep, selectedModel?.thinking, selectedModel?.label)}>
                  <Icon.sparkle />
                  深度思考
                </button>
              ) : null
            }
            // 右槽：模型（与首页同一个选择器、同一份云端目录）+ 发送 / 停止
            right={
              <ModelPicker
                title="问答模型"
                choices={qaCatalog ? modelChoices(qaCatalog) : legacyModels.map((c) => ({ id: c.alias, label: c.label, description: c.note.replace(/^缺省[，,、]\s*/, ""), available: true, isDefault: c.default }))}
                value={route}
                onChange={chooseModel}
                foot="按实际用量计入你的额度；具体型号由云端统一配置。"
              />
            }
            send={<SendButton busy={busy} onStop={stop} disabled={!text.trim()} onSend={() => void send()} />}
          >
            <textarea
              placeholder="输入法律问题，例如：股东未经其他股东同意对外转让股权，合同是否有效？"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={sendOnEnter(() => void send())}
            />
          </ComposerFrame>
          {modelErr && <p className="composer-foot" role="alert">{modelErr}</p>}
          {/* D-225：问答不绑定事项、不查客户授权——常驻说明适用范围（框外一行），细节在“了解更多”浮层 */}
          <ChatScopeNote />
        </div>
      </main>
    </div>
  );
}

/** 适用范围一行 + “了解更多”浮层（第 72 批，D-303）：浮层点外面或 Esc 关闭。 */
function ChatScopeNote() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <p className="composer-foot chat-scope-note" ref={ref}>
      <span>{CHAT_SCOPE_NOTE}</span>
      <button type="button" className="btn-link" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        了解更多
      </button>
      {open && (
        <span className="popover scope-pop" role="dialog" aria-label="问答怎么处理你的问题">
          <span className="scope-p">发送前，问题里能识别的姓名、证件号、账号、联系方式会换成代号（识别依靠规则与名单，可能有遗漏），并与你的事项当事人名单比对：涉及“客户要求不上云”事项的当事人会被拦下。问答不读取事项材料。问题经 Kimi Work 的安全通道发给 Kimi 模型；问答记录只保存在这台电脑上。</span>
          {/* 内容安全说明（D-142，10-23 拍板接受“先显示后撤回”） */}
          <span className="scope-p">回答边生成边显示；如果被内容安全规则拦下，已经显示的部分会撤回，改为“未能取得回答”，这次回答不保存。</span>
        </span>
      )}
    </p>
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
