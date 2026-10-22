/**
 * 我的写作偏好（v9.4 第 22 批；评审 C1 §1 #29“个人偏好与案情分仓”）：落款、法条引用写法、其他格式说明存一次，之后每个 AI 任务都按它写。
 * 只存格式与文风，不存案情——写进像当事人名称、案号、金额的内容，内核会拒存并说明原因。
 */
import { useEffect, useState } from "react";
import { api, type WritingPrefs as Prefs } from "../api.ts";
import { Select } from "./Select.tsx";

export function WritingPrefs() {
  const [p, setP] = useState<Prefs | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.writingPrefs().then(setP).catch(() => setP({ signature: null, citation: null, notes: null }));
  }, []);
  if (!p) return null;
  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      setP(await api.setWritingPrefs({ signature: p.signature ?? "", citation: p.citation, notes: p.notes ?? "" }));
      setMsg("已保存：之后发起的 AI 任务按这里写");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="device-row" id="writing-prefs">
      <div className="device-k">写作偏好</div>
      <div>
        <div className="muted">AI 起草文书时按你的习惯写。只写格式与文风，不写案情；会随任务说明一起发给 AI。</div>
        <div className="form-grid">
          <label className="field">
            <span>落款</span>
            <input value={p.signature ?? ""} maxLength={60} placeholder="例如：××律师事务所 张三 律师" onChange={(e) => setP({ ...p, signature: e.target.value || null })} aria-label="落款" />
          </label>
          <label className="field">
            <span>法条怎么写</span>
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
          </label>
          <label className="field field-wide">
            <span>其他说明（可空）</span>
            <textarea value={p.notes ?? ""} maxLength={200} rows={2} placeholder="例如：小标题用“一、（一）1.”三级；不用“综上所述”开头" onChange={(e) => setP({ ...p, notes: e.target.value || null })} aria-label="写作偏好的其他说明" />
          </label>
        </div>
        <div className="settings-choice">
          <button className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
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
