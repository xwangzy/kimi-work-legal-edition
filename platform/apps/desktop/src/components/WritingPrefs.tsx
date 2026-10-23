/**
 * 我的写作偏好（v9.4 第 22 批；评审 C1 §1 #29“个人偏好与案情分仓”）：落款、法条引用写法、其他格式说明存一次，之后每个 AI 任务都按它写。
 * 只存格式与文风，不存案情——写进像当事人名称、案号、金额的内容，内核会拒存并说明原因。
 */
import { useEffect, useState } from "react";
import { api, type WritingPrefs as Prefs } from "../api.ts";
import { Select } from "./Select.tsx";

export function WritingPrefs() {
  const [p, setP] = useState<Prefs | null>(null);
  // 上次保存的值：有改动才可保存，并在标题旁标“未保存”（第 26 批，与文书版式同一写法，评审 U2-02）
  const [saved, setSaved] = useState<Prefs | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api
      .writingPrefs()
      .then((x) => {
        setP(x);
        setSaved(x);
      })
      .catch(() => {
        const empty = { signature: null, citation: null, notes: null };
        setP(empty);
        setSaved(empty);
      });
  }, []);
  if (!p) return null;
  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.setWritingPrefs({ signature: p.signature ?? "", citation: p.citation, notes: p.notes ?? "" });
      setP(r);
      setSaved(r);
      setMsg("已保存：之后发起的 AI 任务按这里写");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dirty = !!saved && ((p.signature ?? "") !== (saved.signature ?? "") || (p.citation ?? "") !== (saved.citation ?? "") || (p.notes ?? "") !== (saved.notes ?? ""));
  // 第 26 批（评审 U2-01）：与文书版式同一张“标签 | 控件”网格
  return (
    <div className="device-row" id="writing-prefs">
      <div className="device-k">
        写作偏好
        {dirty && <span className="pill pill-orange unsaved">未保存</span>}
      </div>
      <div>
        <div className="muted">AI 起草文书时按你的习惯写。只写格式与文风，不写案情；会随任务说明一起发给 AI。</div>
        <div className="settings-grid">
          <span className="sg-k sg-top">落款</span>
          <div className="sg-v">
            <input value={p.signature ?? ""} maxLength={60} placeholder="例如：××律师事务所 张三 律师" onChange={(e) => setP({ ...p, signature: e.target.value || null })} aria-label="落款" />
          </div>
          <span className="sg-k sg-top">法条写法</span>
          <div className="sg-v sg-select">
            <Select
              aria-label="法条怎么写"
              value={p.citation ?? ""}
              onChange={(v) => setP({ ...p, citation: v === "full" || v === "short" ? v : null })}
              options={[
                { value: "", label: "不指定" },
                { value: "full", label: "每次写全称（《中华人民共和国民法典》）" },
                { value: "short", label: "首次全称，之后可简称（《民法典》）" },
              ]}
            />
          </div>
          <span className="sg-k sg-top">其他说明</span>
          <div className="sg-v">
            <textarea value={p.notes ?? ""} maxLength={200} rows={2} placeholder="例如：小标题用“一、（一）1.”三级；不用“综上所述”开头" onChange={(e) => setP({ ...p, notes: e.target.value || null })} aria-label="写作偏好的其他说明" />
            <span className="sg-help">可空，至多 200 字。</span>
          </div>
        </div>
        <div className="settings-actions">
          <button className="btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void save()}>
            保存
          </button>
        </div>
        {msg && (
          <p className="muted" role="status">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
