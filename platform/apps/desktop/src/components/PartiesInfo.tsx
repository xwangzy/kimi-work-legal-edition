/**
 * 当事人信息（D-224）：事项里“存一次、各文书自动带入”的一份材料《当事人信息（律师填写）.txt》。
 * - PartiesDialog：每方一张卡（哪一方 + 称谓 + 自然人 / 法人 / 其他组织 + 名称 + 身份事项），卡里可挂至多两名委托诉讼代理人（第 64 批）；
 *   全部选填。保存时序列化成固定格式的文字（末尾附自动生成的文书首部写法），作为同名材料的新版本（supersedes 指向上一版），
 *   事项里只有一份当前有效。律师手改过、认不出格式的，退化为直接编辑原文。
 * - usePartiesInfo：读当前那份材料并解析，事项概览与开始面板共用。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { api, type Matter } from "../api.ts";
import {
  AGENT_FIELDS,
  AGENT_IDENTITIES,
  AGENT_IDENTITY_LABELS,
  agentLabelFor,
  blankAgent,
  blankParty,
  currentPartiesDoc,
  initialParties,
  isBlankParty,
  MAX_AGENTS,
  namedAgents,
  parseParties,
  PARTIES_FILENAME,
  PARTIES_HEADER_MARK,
  PARTY_FIELDS,
  PARTY_KIND_HINTS,
  PARTY_KIND_LABELS,
  PARTY_KINDS,
  PARTY_SIDE_LABELS,
  partyCompleteness,
  roleSuggestions,
  serializeParties,
  SPECIAL_POWERS,
  type AgentIdentity,
  type AgentLabel,
  type AgentScope,
  type PartyAgent,
  type PartyEntry,
  type PartySide,
} from "../lib/parties.ts";
import { notifyDataChanged } from "../lib/events.ts";
import { BusyLabel } from "./Loading.tsx";
import { Icon } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";
import "../styles-matter.css";

export type PartiesDocRow = { document_version_id: string; filename: string; supersedes?: string | null; quarantined_at?: string | null; created_at?: string };

export interface PartiesInfoState {
  /** 当前有效的那份材料；没有为 null。 */
  doc: PartiesDocRow | null;
  /** 材料原文（读到之前为 null）。 */
  text: string | null;
  /** 解析结果；认不出格式为 null。 */
  parties: PartyEntry[] | null;
  loading: boolean;
}

/** 读本事项当前那份当事人信息材料（docs 变了重读）。 */
export function usePartiesInfo(docs: readonly PartiesDocRow[] | null): PartiesInfoState {
  const doc = docs ? currentPartiesDoc(docs) : null;
  const id = doc?.document_version_id ?? null;
  const [st, setSt] = useState<{ id: string | null; text: string | null }>({ id: null, text: null });
  useEffect(() => {
    if (!id) return;
    let live = true;
    void api
      .materialText(id)
      .then((r) => live && setSt({ id, text: r.paragraphs.join("\n") }))
      .catch(() => live && setSt({ id, text: "" }));
    return () => {
      live = false;
    };
  }, [id]);
  const text = id && st.id === id ? st.text : null;
  return { doc, text, parties: text === null ? null : parseParties(text), loading: !!id && text === null };
}

const SIDES: PartySide[] = ["ours", "theirs", "third", "other"];
const SCOPES: { value: AgentScope; label: string }[] = [
  { value: "", label: "暂不写" },
  { value: "general", label: "一般授权" },
  { value: "special", label: "特别授权" },
];

/** 对话框里的一方：多一个稳定的 key（删去一方时其余各卡的输入状态不串）。 */
type DraftAgent = PartyAgent & { _k: number };
type Draft = Omit<PartyEntry, "agents"> & { _k: number; agents: DraftAgent[] };
type PartyPatch = Partial<Omit<PartyEntry, "agents">>;
let seq = 0;
const nextKey = () => ++seq;
const toDraft = (p: PartyEntry): Draft => ({ ...p, _k: nextKey(), agents: (p.agents ?? []).map((a) => ({ ...a, _k: nextKey() })) });

export function PartiesDialog({
  matter,
  info,
  cardId,
  onClose,
  onSaved,
}: {
  matter: Pick<Matter, "matter_id" | "client_name" | "counterparty" | "stance">;
  info: PartiesInfoState;
  /** 从哪张卡打开（称谓建议与“委托诉讼代理人 / 委托代理人”的称呼按卡给）；事项概览打开时为空。 */
  cardId?: string | null;
  onClose: () => void;
  onSaved: (r: { id: string; replaced: string | null }) => void;
}) {
  // 认不出格式（律师手改过文件）：直接编辑原文
  const raw0 = info.doc && info.text !== null && info.parties === null ? info.text : null;
  const [raw, setRaw] = useState<string | null>(raw0);
  const [list, setList] = useState<Draft[]>(() => (info.parties && info.parties.length > 0 ? info.parties : initialParties(matter, cardId)).map(toDraft));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const label: AgentLabel = agentLabelFor(cardId, info.text);
  // “填入我”：本机登记的律师姓名与律所（取不到时不显示这个按钮；不编造执业证号、电话）
  const [me, setMe] = useState<{ name: string; firm: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    api
      .kernelStatus()
      .then((s) => {
        const name = String(s?.activation?.member?.name ?? "").trim();
        const firm = String(s?.activation?.firm?.name ?? "").trim();
        if (live && name) setMe({ name, firm: firm || null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const set = (k: number, p: PartyPatch) => setList((cur) => cur.map((x) => (x._k === k ? { ...x, ...p } : x)));
  const setField = (k: number, f: string, v: string) => setList((cur) => cur.map((x) => (x._k === k ? { ...x, fields: { ...x.fields, [f]: v } } : x)));
  const setAgent = (k: number, ak: number, p: Partial<PartyAgent>) => setList((cur) => cur.map((x) => (x._k === k ? { ...x, agents: x.agents.map((a) => (a._k === ak ? { ...a, ...p } : a)) } : x)));
  const addAgent = (k: number) => setList((cur) => cur.map((x) => (x._k === k && x.agents.length < MAX_AGENTS ? { ...x, agents: [...x.agents, { ...blankAgent(), _k: nextKey() }] } : x)));
  const removeAgent = (k: number, ak: number) => setList((cur) => cur.map((x) => (x._k === k ? { ...x, agents: x.agents.filter((a) => a._k !== ak) } : x)));

  const save = async () => {
    // 原文模式：改完认得出格式就按表单重新写出（末尾的首部写法随之重新生成）；认不出照原文存
    const reparsed = raw !== null ? parseParties(raw) : null;
    const text = raw !== null ? (reparsed ? serializeParties(reparsed, { agentLabel: label }) : raw) : serializeParties(list, { agentLabel: label });
    // 没改、或什么都没填又没有旧材料：不出新版本
    if ((info.text !== null && text.trim() === info.text.trim()) || (!info.doc && raw === null && list.every((p) => isBlankParty(p)))) return onClose();
    setBusy(true);
    setErr("");
    try {
      const prev = info.doc?.document_version_id ?? null;
      const r = await api.importMaterialText(matter.matter_id, PARTIES_FILENAME, text, prev);
      await api.setMaterialRole(r.document_version_id, "reference").catch(() => {});
      // 第 56 批：表单里的自然人（当事人本人、法定代表人）登记进本事项的当事人词典——发给 AI 前按词典换成代号。
      // 只靠模式识别时，“对方（被告）：赵雪梅（自然人）”后面只跟“性别：女”这种写法认不出姓名，会原文发出（令牌化核对查出）。
      // 第 64 批：委托诉讼代理人的姓名同样登记。登记失败不挡保存（词典未启用的形态）；原文模式（律师手改过的文件）无法取出姓名，不登记。
      const parsed = raw === null ? list : reparsed;
      if (parsed) {
        const people = new Map<string, string | null>();
        for (const p of parsed) {
          if (p.kind === "person" && p.name.trim()) people.set(p.name.trim(), p.role.trim() || null);
          const rep = p.fields.legal_rep?.trim();
          if (p.kind !== "person" && rep && !people.has(rep)) people.set(rep, p.kind === "org" ? "法定代表人" : "主要负责人");
          for (const a of namedAgents(p)) if (!people.has(a.name.trim())) people.set(a.name.trim(), label);
        }
        // 词典里已有的不动（重写会清掉律师已确认的别名）；名称须 2–64 字（词典的规则）
        const known = new Set((await api.parties(matter.matter_id).catch(() => ({ parties: [] as { name: string }[] }))).parties.map((x) => x.name));
        for (const [name, role] of people) if (!known.has(name) && name.length >= 2 && name.length <= 64) await api.upsertParty(matter.matter_id, { name, kind: "person", aliases: [], role }).catch(() => {});
      }
      notifyDataChanged();
      onSaved({ id: r.document_version_id, replaced: prev });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="当事人信息" onClose={onClose} wide>
      <p className="pi-lead muted">
        起诉状、答辩状、仲裁申请书、律师函、合同等文书的首部按这里写；没填的项在文书里留【待填】，全部选填，填多少算多少。证件号、电话、住址门牌和自然人姓名发给 AI 前会换成代号，导出文书时还原。
      </p>
      {raw !== null ? (
        <label className="field pi-raw">
          <span>这份材料改过格式，直接在原文上改。末尾“{PARTIES_HEADER_MARK.replace(/^——|——$/g, "")}”不会跟着改：改了上面的身份事项，请一并改它，或把这一段整段删去（格式认得出时保存会重新生成）。</span>
          <textarea aria-label="当事人信息原文" rows={16} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </label>
      ) : (
        <div className="pi-groups">
          {list.map((p, i) => (
            <PartyCard
              key={p._k}
              p={p}
              n={i + 1}
              cardId={cardId}
              label={label}
              me={me}
              removable={list.length > 1}
              onChange={(x) => set(p._k, x)}
              onField={(f, v) => setField(p._k, f, v)}
              onRemove={() => setList((cur) => cur.filter((x) => x._k !== p._k))}
              onAddAgent={() => addAgent(p._k)}
              onAgent={(ak, x) => setAgent(p._k, ak, x)}
              onRemoveAgent={(ak) => removeAgent(p._k, ak)}
            />
          ))}
          <button type="button" className="btn-ghost btn-sm pi-add" onClick={() => setList((cur) => [...cur, toDraft(blankParty(cur.some((x) => x.side === "theirs") ? "third" : "theirs", "org"))])}>
            ＋ 再加一方
          </button>
        </div>
      )}
      <p className="pi-note muted">存成本事项的一份材料《{PARTIES_FILENAME.replace(/\.txt$/, "")}》，末尾附按各项生成的文书首部写法；再改会替换成新版本，事项里只留一份当前有效。</p>
      {err && <div className="banner banner-red">{err}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>取消</button>
        <button className="btn-primary" disabled={busy} aria-busy={busy} onClick={() => void save()}>
          <BusyLabel busy={busy} busyText="正在保存…">保存</BusyLabel>
        </button>
      </div>
    </Modal>
  );
}

function PartyCard(props: {
  p: Draft;
  n: number;
  cardId?: string | null;
  label: AgentLabel;
  me: { name: string; firm: string | null } | null;
  removable: boolean;
  onChange: (x: PartyPatch) => void;
  onField: (f: string, v: string) => void;
  onRemove: () => void;
  onAddAgent: () => void;
  onAgent: (ak: number, x: Partial<PartyAgent>) => void;
  onRemoveAgent: (ak: number) => void;
}) {
  const { p, label } = props;
  const fields = PARTY_FIELDS[p.kind];
  const main = fields.filter((f) => !f.more);
  const more = fields.filter((f) => f.more);
  const [moreOpen, setMoreOpen] = useState(() => more.some((f) => (p.fields[f.key] ?? "").trim()));
  const st = partyCompleteness(p);
  const nameLabel = p.kind === "person" ? "姓名" : "名称";
  const renderField = (f: (typeof fields)[number]) => {
    const empty = !(p.fields[f.key] ?? "").trim();
    return (
      <label key={f.key} className={`field pi-field${f.key === "address" || f.key === "residence" || f.key === "employer" ? " field-wide" : ""}`}>
        <span className="pi-flabel">
          {f.label}
          {f.core && empty && <em className="pi-due">待补</em>}
        </span>
        {f.key === "gender" ? (
          <Select aria-label="性别" value={p.fields.gender ?? ""} placeholder="不填" onChange={(v) => props.onField("gender", v)} options={[{ value: "", label: "不填" }, { value: "男", label: "男" }, { value: "女", label: "女" }]} />
        ) : (
          <input value={p.fields[f.key] ?? ""} placeholder={f.placeholder ?? ""} aria-label={f.label} onChange={(e) => props.onField(f.key, e.target.value)} />
        )}
      </label>
    );
  };
  return (
    <section className="pi-group pi-card" aria-label={`${PARTY_SIDE_LABELS[p.side]}${props.n}`}>
      <div className="pi-group-head">
        <Select aria-label="哪一方" className="pi-side-select" value={p.side} onChange={(v) => props.onChange({ side: v as PartySide })} options={SIDES.map((s) => ({ value: s, label: PARTY_SIDE_LABELS[s] }))} />
        <RoleInput value={p.role} options={roleSuggestions(props.cardId, p.side)} onChange={(role) => props.onChange({ role })} />
        <span className="seg pi-kind" role="radiogroup" aria-label="类型">
          {PARTY_KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={p.kind === k} title={PARTY_KIND_HINTS[k]} className={`seg-btn${p.kind === k ? " on" : ""}`} onClick={() => props.onChange({ kind: k })}>
              {PARTY_KIND_LABELS[k]}
            </button>
          ))}
        </span>
        {props.removable && (
          <button type="button" className="icon-btn pi-remove" aria-label={`删去这一方：${p.name || PARTY_SIDE_LABELS[p.side]}`} title="删去这一方" onClick={props.onRemove}>
            <Icon.x />
          </button>
        )}
      </div>
      <label className="field pi-name">
        <span className="pi-flabel">
          {nameLabel}
          {p.kind !== "person" && <span className="pi-hint">{PARTY_KIND_HINTS[p.kind]}</span>}
        </span>
        <input value={p.name} onChange={(e) => props.onChange({ name: e.target.value })} aria-label={nameLabel} placeholder={p.kind === "person" ? "与身份证一致" : "与营业执照一致"} />
      </label>
      <div className="form-grid pi-grid">{main.map(renderField)}</div>
      {more.length > 0 && (
        <>
          <button type="button" className={`btn-link pi-more${moreOpen ? " open" : ""}`} aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            <Icon.chevron /> 更多<span className="muted">（{more.map((f) => f.label).join("、")}，填了才写进首部）</span>
          </button>
          {moreOpen && <div className="form-grid pi-grid">{more.map(renderField)}</div>}
        </>
      )}
      <div className="pi-foot muted" aria-live="polite">
        {st.missing.length === 0 ? `首部常用的 ${st.expected} 项已填齐` : `首部常用的 ${st.expected} 项已填 ${st.filled} 项；没填的在文书里写【待填】`}
      </div>
      <div className="pi-agents" role="group" aria-label={label}>
        <div className="pi-agents-head">
          <span className="pi-agents-title">{label}</span>
          <span className="muted">每方至多 {MAX_AGENTS} 人；只填姓名也可以</span>
        </div>
        {p.agents.map((a, j) => (
          <AgentForm key={a._k} a={a} n={j} label={label} me={props.me} onChange={(x) => props.onAgent(a._k, x)} onRemove={() => props.onRemoveAgent(a._k)} />
        ))}
        {p.agents.length < MAX_AGENTS && (
          <button type="button" className="btn-link pi-agent-add" onClick={props.onAddAgent}>
            ＋ 添加{label}
          </button>
        )}
      </div>
    </section>
  );
}

function AgentForm({ a, n, label, me, onChange, onRemove }: { a: PartyAgent; n: number; label: AgentLabel; me: { name: string; firm: string | null } | null; onChange: (x: Partial<PartyAgent>) => void; onRemove: () => void }) {
  const setF = (k: string, v: string) => onChange({ fields: { ...a.fields, [k]: v } });
  const togglePower = (k: PartyAgent["powers"][number]) => {
    const has = new Set(a.powers);
    if (has.has(k)) has.delete(k);
    else has.add(k);
    onChange({ powers: SPECIAL_POWERS.map((x) => x.key).filter((x) => has.has(x)) });
  };
  const title = `${label}${["一", "二"][n] ?? ""}`;
  return (
    <div className="pi-agent" role="group" aria-label={title}>
      <div className="pi-agent-head">
        <span className="pi-agent-n">{title}</span>
        {me && (
          <button type="button" className="btn-link pi-fillme" title={`填入 ${me.name}${me.firm ? `（${me.firm}）` : ""}，身份为律师；执业证号、电话请自己补`} onClick={() => onChange({ name: me.name, identity: "lawyer", fields: { ...a.fields, ...(me.firm ? { org: me.firm } : {}) } })}>
            填入我
          </button>
        )}
        <button type="button" className="icon-btn pi-remove" aria-label={`删去${title}${a.name ? `：${a.name}` : ""}`} title="删去这名代理人" onClick={onRemove}>
          <Icon.x />
        </button>
      </div>
      <div className="form-grid pi-grid">
        <label className="field pi-field">
          <span className="pi-flabel">姓名</span>
          <input value={a.name} aria-label={`${title}姓名`} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className="field pi-field">
          <span className="pi-flabel">身份</span>
          <Select aria-label={`${title}身份`} value={a.identity} onChange={(v) => onChange({ identity: v as AgentIdentity })} options={AGENT_IDENTITIES.map((k) => ({ value: k, label: AGENT_IDENTITY_LABELS[k] }))} />
        </label>
        {AGENT_FIELDS[a.identity].map((f) => (
          <label key={f.key} className="field pi-field">
            <span className="pi-flabel">{f.label}</span>
            <input value={a.fields[f.key] ?? ""} placeholder={f.placeholder ?? ""} aria-label={`${title}${f.label}`} onChange={(e) => setF(f.key, e.target.value)} />
          </label>
        ))}
        <div className="field field-wide pi-field">
          <span className="pi-flabel">授权范围</span>
          <span className="seg pi-scope" role="radiogroup" aria-label={`${title}授权范围`}>
            {SCOPES.map((s) => (
              <button key={s.value || "none"} type="button" role="radio" aria-checked={a.scope === s.value} className={`seg-btn${a.scope === s.value ? " on" : ""}`} onClick={() => onChange({ scope: s.value, ...(s.value === "special" ? {} : { powers: [] }) })}>
                {s.label}
              </button>
            ))}
          </span>
          {a.scope === "special" && (
            <div className="pi-powers" role="group" aria-label="特别授权事项">
              {SPECIAL_POWERS.map((x) => (
                <label key={x.key} className="pi-power">
                  <input type="checkbox" checked={a.powers.includes(x.key)} onChange={() => togglePower(x.key)} />
                  {x.label}
                </label>
              ))}
              <button type="button" className="btn-link pi-power-all" onClick={() => onChange({ powers: a.powers.length === SPECIAL_POWERS.length ? [] : SPECIAL_POWERS.map((x) => x.key) })}>
                {a.powers.length === SPECIAL_POWERS.length ? "全不选" : "全选"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 称谓：按这张卡给的建议下拉，也可以自己写（第 64 批）。 */
function RoleInput({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const shown = value.trim() && !options.includes(value.trim()) ? options.filter((o) => o.includes(value.trim())) : options;
  const pick = (o: string) => {
    onChange(o);
    setOpen(false);
    setActive(-1);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((x) => (shown.length === 0 ? -1 : (x + d + shown.length) % shown.length));
    } else if (e.key === "Enter" && open && active >= 0 && shown[active]) {
      e.preventDefault();
      pick(shown[active]!);
    } else if (e.key === "Escape" && open) {
      // 只收起建议，不关对话框
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    }
  };
  return (
    <span className="pi-combo">
      <input
        ref={input}
        className="pi-role"
        role="combobox"
        aria-label="称谓"
        aria-expanded={open && shown.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        value={value}
        placeholder="称谓，如 原告（可空）"
        maxLength={20}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      <button type="button" className="pi-combo-btn" tabIndex={-1} aria-label="称谓建议" onMouseDown={(e) => e.preventDefault()} onClick={() => {
          if (open) return setOpen(false);
          setOpen(true);
          input.current?.focus();
        }}
      >
        <Icon.chevron />
      </button>
      {open && shown.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="pi-combo-list" aria-label="常用称谓">
          {shown.map((o, i) => (
            <li key={o} id={`${id}-${i}`} role="option" aria-selected={o === value} className={`pi-combo-opt${i === active ? " active" : ""}${o === value ? " on" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
              {o}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
