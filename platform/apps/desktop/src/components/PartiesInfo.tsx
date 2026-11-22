/**
 * 当事人信息（D-224）：事项里“存一次、各文书自动带入”的一份材料《当事人信息（律师填写）.txt》。
 * - PartiesDialog：按我方 / 对方 / 第三人、其他当事人分组的轻量表单；全部选填。保存时序列化成固定格式的文字，作为同名材料的新版本
 *   （supersedes 指向上一版），事项里只有一份当前有效。律师手改过、认不出格式的，退化为直接编辑原文。
 * - usePartiesInfo：读当前那份材料并解析，事项概览与开始面板共用。
 */
import { useEffect, useState } from "react";
import { api, type Matter } from "../api.ts";
import { blankParty, currentPartiesDoc, initialParties, parseParties, PARTIES_FILENAME, PARTY_FIELDS, PARTY_KIND_LABELS, PARTY_SIDE_LABELS, serializeParties, type PartyEntry, type PartyKind, type PartySide } from "../lib/parties.ts";
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

export function PartiesDialog({ matter, info, onClose, onSaved }: { matter: Pick<Matter, "matter_id" | "client_name" | "counterparty" | "stance">; info: PartiesInfoState; onClose: () => void; onSaved: (r: { id: string; replaced: string | null }) => void }) {
  // 认不出格式（律师手改过文件）：直接编辑原文
  const raw0 = info.doc && info.text !== null && info.parties === null ? info.text : null;
  const [raw, setRaw] = useState<string | null>(raw0);
  const [list, setList] = useState<PartyEntry[]>(() => (info.parties && info.parties.length > 0 ? info.parties : initialParties(matter)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (i: number, p: Partial<PartyEntry>) => setList((cur) => cur.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const setField = (i: number, k: string, v: string) => setList((cur) => cur.map((x, j) => (j === i ? { ...x, fields: { ...x.fields, [k]: v } } : x)));
  const save = async () => {
    const text = raw !== null ? raw : serializeParties(list);
    // 没改、或什么都没填又没有旧材料：不出新版本
    if ((info.text !== null && text.trim() === info.text.trim()) || (!info.doc && raw === null && list.every((p) => !p.name.trim() && Object.values(p.fields).every((v) => !v?.trim())))) return onClose();
    setBusy(true);
    setErr("");
    try {
      const prev = info.doc?.document_version_id ?? null;
      const r = await api.importMaterialText(matter.matter_id, PARTIES_FILENAME, text, prev);
      await api.setMaterialRole(r.document_version_id, "reference").catch(() => {});
      // 第 56 批：表单里的自然人（当事人本人、法定代表人）登记进本事项的当事人词典——发给 AI 前按词典换成代号。
      // 只靠模式识别时，“对方（被告）：赵雪梅（自然人）”后面只跟“性别：女”这种写法认不出姓名，会原文发出（令牌化核对查出）。
      // 登记失败不挡保存（词典未启用的形态）；原文模式（律师手改过的文件）无法取出姓名，不登记。
      if (raw === null) {
        const people = new Map<string, string | null>();
        for (const p of list) {
          if (p.kind === "person" && p.name.trim()) people.set(p.name.trim(), p.role.trim() || null);
          const rep = p.fields.legal_rep?.trim();
          if (p.kind === "org" && rep && !people.has(rep)) people.set(rep, "法定代表人");
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
      <p className="pi-lead muted">起诉状、答辩状、律师函、合同等文书的首部按这里写；没填的项在文书里留【待填】。全部选填，填多少算多少。证件号、电话、住址门牌和自然人姓名发给 AI 前会换成代号，导出文书时还原。</p>
      {raw !== null ? (
        <label className="field pi-raw">
          <span>这份材料改过格式，直接在原文上改</span>
          <textarea aria-label="当事人信息原文" rows={14} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </label>
      ) : (
        <div className="pi-groups">
          {list.map((p, i) => (
            <section key={i} className="pi-group" aria-label={`${PARTY_SIDE_LABELS[p.side]}${i + 1}`}>
              <div className="pi-group-head">
                <Select aria-label="哪一方" value={p.side} onChange={(v) => set(i, { side: v as PartySide })} options={SIDES.map((s) => ({ value: s, label: PARTY_SIDE_LABELS[s] }))} />
                <input className="pi-role" aria-label="称谓" value={p.role} placeholder="称谓，如 原告、申请人（可空）" onChange={(e) => set(i, { role: e.target.value })} maxLength={20} />
                <span className="seg pi-kind" role="radiogroup" aria-label="类型">
                  {(["org", "person"] as PartyKind[]).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={p.kind === k} className={`seg-btn${p.kind === k ? " on" : ""}`} onClick={() => set(i, { kind: k })}>
                      {PARTY_KIND_LABELS[k]}
                    </button>
                  ))}
                </span>
                {list.length > 1 && (
                  <button type="button" className="icon-btn pi-remove" aria-label={`删去这一方：${p.name || PARTY_SIDE_LABELS[p.side]}`} onClick={() => setList((cur) => cur.filter((_, j) => j !== i))}>
                    <Icon.x />
                  </button>
                )}
              </div>
              <div className="form-grid">
                <label className="field field-wide">
                  <span>{p.kind === "org" ? "名称" : "姓名"}</span>
                  <input value={p.name} onChange={(e) => set(i, { name: e.target.value })} aria-label={p.kind === "org" ? "名称" : "姓名"} />
                </label>
                {PARTY_FIELDS[p.kind].map((f) => (
                  <label key={f.key} className={`field${f.key === "address" ? " field-wide" : ""}`}>
                    <span>{f.label}</span>
                    {f.key === "gender" ? (
                      <Select aria-label="性别" value={p.fields.gender ?? ""} placeholder="不填" onChange={(v) => setField(i, "gender", v)} options={[{ value: "", label: "不填" }, { value: "男", label: "男" }, { value: "女", label: "女" }]} />
                    ) : (
                      <input value={p.fields[f.key] ?? ""} placeholder={f.placeholder ?? ""} aria-label={f.label} onChange={(e) => setField(i, f.key, e.target.value)} />
                    )}
                  </label>
                ))}
              </div>
            </section>
          ))}
          <button type="button" className="btn-link pi-add" onClick={() => setList((cur) => [...cur, blankParty(cur.some((x) => x.side === "theirs") ? "third" : "theirs", "org")])}>
            ＋ 再加一方
          </button>
        </div>
      )}
      <p className="pi-note muted">存成本事项的一份材料《{PARTIES_FILENAME.replace(/\.txt$/, "")}》；再改会替换成新版本，事项里只留一份当前有效。</p>
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
