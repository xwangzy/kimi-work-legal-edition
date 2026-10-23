/**
 * 本所范本库（v9.4 第 24 批；评审 C1 §1 #23，10-23 拍板）：律师主动放入、去掉客户信息的合同范本。
 * 审合同时，审查工作台的卡片会列出“本所范本对此条的写法”，可照着改。存在这台电脑，不同步、不发给 AI。
 * 放入时内核逐条查像客户信息的写法；查到的列给律师看，可以取消去改原文件，也可以一键换成【】占位符再放入。
 */
import { useEffect, useRef, useState } from "react";
import { api, type FirmTemplate, type FirmTemplateAddResult } from "../api.ts";
import { fmtDate } from "../lib/labels.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";

type Source = { text: string } | { file: File } | { handle: string; name: string };

export function FirmTemplates() {
  const [list, setList] = useState<FirmTemplate[] | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const load = () =>
    void api
      .firmTemplates()
      .then((r) => {
        setList(r.templates);
        setTypes(r.contract_types);
      })
      .catch((e) => setMsg((e as Error).message));
  useEffect(load, []);
  const groups = new Map<string, FirmTemplate[]>();
  for (const t of list ?? []) groups.set(t.contract_type, [...(groups.get(t.contract_type) ?? []), t]);
  return (
    <section aria-label="本所范本" id="firm-templates">
      <div className="section-title">本所范本</div>
      <p className="muted">
        放入本所常用的合同范本（去掉客户信息）。审合同时，工作台的每张卡片会列出“本所范本对此条的写法”，可以照着改。范本存在这台电脑上，不发给 AI。
      </p>
      {msg && <div className="banner banner-orange">{msg}</div>}
      {list === null ? (
        <p className="muted">载入中…</p>
      ) : list.length === 0 ? (
        <p className="muted">还没有范本。</p>
      ) : (
        <table className="data ft-table">
          <thead>
            <tr>
              <th>合同类型</th>
              <th>范本</th>
              <th>适用立场</th>
              <th className="num">条款</th>
              <th>放入日期</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].flatMap(([type, ts]) =>
              ts.map((t, i) => (
                <tr key={t.template_id}>
                  <td>{i === 0 ? type : ""}</td>
                  <td>
                    <button className="btn-link" onClick={() => setViewing(t.template_id)}>
                      {t.title}
                    </button>
                    {t.note && <div className="muted">{t.note}</div>}
                  </td>
                  <td>{t.stance ?? "通用"}</td>
                  <td className="num">{t.clauses}</td>
                  <td>{fmtDate(t.created_at)}</td>
                  <td>
                    <ConfirmButton
                      label="删除"
                      className="btn-ghost btn-sm btn-danger"
                      question="删除后，审合同时不再列出这份范本的条款；已经照着改过的卡片不受影响。"
                      confirmLabel="删除这份范本"
                      onConfirm={async () => {
                        try {
                          setList((await api.removeFirmTemplate(t.template_id)).templates);
                          setMsg("");
                        } catch (e) {
                          setMsg((e as Error).message);
                        }
                      }}
                    />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      <div className="settings-choice">
        <button className="btn-ghost btn-sm" onClick={() => setAdding(true)}>
          放入范本…
        </button>
      </div>
      {adding && (
        <AddTemplate
          types={types}
          onClose={() => setAdding(false)}
          onSaved={(t, replaced) => {
            setAdding(false);
            setMsg(replaced > 0 ? `已放入「${t.title}」：${replaced} 处像客户信息的写法已换成占位符` : "");
            load();
          }}
        />
      )}
      {viewing && <ViewTemplate templateId={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}

function AddTemplate({ types, onClose, onSaved }: { types: string[]; onClose: () => void; onSaved: (t: FirmTemplate, replaced: number) => void }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("");
  const [stance, setStance] = useState("");
  const [note, setNote] = useState("");
  const [how, setHow] = useState<"file" | "paste">("file");
  const [text, setText] = useState("");
  const [src, setSrc] = useState<Exclude<Source, { text: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cleanup, setCleanup] = useState<Extract<FirmTemplateAddResult, { status: "needs_cleanup" }> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const source: Source | null = how === "paste" ? (text.trim() ? { text } : null) : src;
  const submit = async (replace: boolean) => {
    if (!source) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.addFirmTemplate({ title, contract_type: type, stance, note, replace_hits: replace }, source);
      if (r.status === "saved") onSaved(r.template, r.replaced);
      else setCleanup(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    if (window.zrKernel?.pickFiles) {
      const f = await api.pickTemplateFile();
      if (f) setSrc(f);
    } else fileRef.current?.click();
  };
  const srcName = src ? ("file" in src ? src.file.name : src.name) : "";
  return (
    <Modal title="放入范本" onClose={onClose} wide>
      {cleanup ? (
        <>
          <p>范本里有 {cleanup.hits.length} 处像客户信息的写法，没有放入：</p>
          <ul className="ft-hits">
            {cleanup.hits.slice(0, 30).map((h, i) => (
              <li key={i}>
                <b>{h.heading || "首部"}</b>：“{h.text}”<span className="muted">（{h.reason}）</span>
              </li>
            ))}
            {cleanup.hits.length > 30 && <li className="muted">另有 {cleanup.hits.length - 30} 处</li>}
          </ul>
          <p className="muted">可以回去改原文件再放入；也可以把这些地方换成【当事人】【案号】【电话】这样的占位符后放入。范本里其他具体交易的金额、日期，请自己核一遍。</p>
          {err && <div className="banner banner-red">{err}</div>}
          <div className="settings-choice">
            <button className="btn-primary btn-sm" disabled={busy} onClick={() => void submit(true)}>
              换成占位符后放入
            </button>
            <button className="btn-ghost btn-sm" disabled={busy} onClick={() => setCleanup(null)}>
              返回修改
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="form-grid">
            <label className="field">
              <span>范本名称</span>
              <input value={title} maxLength={40} placeholder="例如：采购合同（买方版）" onChange={(e) => setTitle(e.target.value)} aria-label="范本名称" />
            </label>
            <label className="field">
              <span>合同类型</span>
              <Select aria-label="合同类型" value={type} onChange={setType} placeholder="请选择" options={types.map((t) => ({ value: t, label: t }))} />
            </label>
            <label className="field">
              <span>适用立场（可空）</span>
              <input value={stance} maxLength={20} placeholder="例如：买方；不填为通用" onChange={(e) => setStance(e.target.value)} aria-label="适用立场" />
            </label>
            <label className="field">
              <span>说明（可空）</span>
              <input value={note} maxLength={200} placeholder="例如：2025 年合伙人会议定稿" onChange={(e) => setNote(e.target.value)} aria-label="范本说明" />
            </label>
          </div>
          <div className="settings-choice" role="radiogroup" aria-label="范本来源">
            <button role="radio" aria-checked={how === "file"} className={`q-option${how === "file" ? " on" : ""}`} onClick={() => setHow("file")}>
              选 Word 或文本文件
            </button>
            <button role="radio" aria-checked={how === "paste"} className={`q-option${how === "paste" ? " on" : ""}`} onClick={() => setHow("paste")}>
              粘贴正文
            </button>
          </div>
          {how === "file" ? (
            <div className="settings-choice">
              <button className="btn-ghost btn-sm" onClick={() => void pick()}>
                {srcName ? "换一个文件" : "选择文件…"}
              </button>
              {srcName && <span className="muted">{srcName}</span>}
              <input
                ref={fileRef}
                type="file"
                accept=".docx,.txt"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) setSrc({ file: f });
                }}
              />
            </div>
          ) : (
            <textarea className="ft-paste" rows={8} value={text} placeholder="粘贴范本正文：按“第一条”“一、”“1.”开头的段拆成条款" onChange={(e) => setText(e.target.value)} aria-label="范本正文" />
          )}
          <p className="muted">放入前会逐条检查像客户名称、案号、证件号、电话、账号、邮箱的写法；查到的会先列给你看。</p>
          {err && <div className="banner banner-red">{err}</div>}
          <div className="settings-choice">
            <button className="btn-primary btn-sm" disabled={busy || !title.trim() || !type || !source} onClick={() => void submit(false)}>
              {busy ? "检查中…" : "检查并放入"}
            </button>
            <button className="btn-ghost btn-sm" disabled={busy} onClick={onClose}>
              取消
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ViewTemplate({ templateId, onClose }: { templateId: string; onClose: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.firmTemplate>> | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    void api
      .firmTemplate(templateId)
      .then(setData)
      .catch((e) => setErr((e as Error).message));
  }, [templateId]);
  return (
    <Modal title={data ? `${data.template.title}（${data.template.contract_type}）` : "范本"} onClose={onClose} wide>
      {err && <div className="banner banner-red">{err}</div>}
      {!data && !err && <p className="muted">载入中…</p>}
      {data && (
        <ol className="ft-clauses">
          {data.clauses.map((c) => (
            <li key={c.seq}>
              <div className="ft-clause-head">{c.heading}</div>
              <div className="ft-clause-text">{c.text}</div>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
