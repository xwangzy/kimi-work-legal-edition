/**
 * 新建事项（第 03 篇 §5 步骤 5：填写或确认四项依据；第 02 篇 §8.1：数据准入不是一个“已同意”勾选框，四项分别记录）。
 * 任一项“待确认”时，该事项只运行不出站的本机能力。
 */
import { useState } from "react";
import { api, type Matter, type MatterBasis } from "../api.ts";
import { ENDPOINT_LABELS } from "../lib/labels.ts";
import { ConsentQuestion, type ConsentAnswer } from "./Consent.tsx";
import { Modal } from "./Modal.tsx";
import { notifyDataChanged } from "../lib/events.ts";

const STANCES = ["原告", "被告", "申请人", "被申请人", "第三人", "受让方", "转让方", "买方", "卖方", "出租人", "承租人", "投资方", "目标公司", "常年顾问", "其他"];
const LEVELS = [
  { v: "normal", label: "一般", hint: "委托事项中的合同、函件、案卷、意见书" },
  { v: "high", label: "敏感", hint: "敏感个人信息、刑事卷宗等：公司名称也替换为代号，每条联网检索都要你确认" },
  { v: "strict", label: "客户要求不上云", hint: "只在这台电脑上处理，不使用云端模型与联网检索" },
];

export function NewMatterDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (m: Matter) => void }) {
  const [f, setF] = useState({ title: "", client_name: "", counterparty: "", stance: "原告", jurisdiction: "中国大陆", confidentiality: "normal", model_endpoint: "standard", analysis_as_of: "" });
  const [basis, setBasis] = useState<MatterBasis>({ engagement: "pending", personal_info: "pending", sensitive: "not_applicable", subprocessor: "pending" });
  const [consent, setConsent] = useState<ConsentAnswer>("not_yet");
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value });
    // 敏感事项（L3a）：“敏感信息特别条件”缺省改为待确认（不默认“不适用”）
    if (k === "confidentiality" && e.target.value === "high" && basis.sensitive === "not_applicable") setBasis({ ...basis, sensitive: "pending" });
  };
  const submit = async () => {
    if (!f.title.trim()) return setErr("请填写事项名称");
    setBusy(true);
    setErr("");
    try {
      const r = await api.createMatter({
        title: f.title.trim(),
        client_name: f.client_name.trim() || null,
        counterparty: f.counterparty.trim() || null,
        stance: f.stance,
        jurisdiction: f.jurisdiction,
        // “客户明确不同意使用云端 AI”= 当事人限制（只在本机处理）
        confidentiality: consent === "refused" ? "strict" : f.confidentiality,
        model_endpoint: f.model_endpoint,
        // 同意状态由内核按四项派生；转委托与次处理者在标准端点下不能“不适用”
        basis: { ...basis, subprocessor: basis.subprocessor === "not_applicable" && f.model_endpoint !== "private" && f.model_endpoint !== "none" ? "pending" : basis.subprocessor },
        key_dates: f.analysis_as_of ? { analysis_as_of: f.analysis_as_of } : {},
      });
      notifyDataChanged();
      onCreated(r.matter);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="新建事项" onClose={onClose} wide>
      <div className="form-grid">
        <label className="field field-wide">
          <span>事项名称</span>
          <input autoFocus value={f.title} onChange={set("title")} placeholder="例如：甲公司股权转让（受让方）" />
        </label>
        <label className="field">
          <span>客户</span>
          <input value={f.client_name} onChange={set("client_name")} placeholder="委托人（发给 AI 前会替换为代号）" />
        </label>
        <label className="field">
          <span>相对方</span>
          <input value={f.counterparty} onChange={set("counterparty")} placeholder="多个以顿号分隔" />
        </label>
        <label className="field">
          <span>我方立场</span>
          <select value={f.stance} onChange={set("stance")}>{STANCES.map((s) => <option key={s}>{s}</option>)}</select>
        </label>
      </div>
      <ConsentQuestion
        answer={consent}
        onAnswer={setConsent}
        basis={basis}
        onBasis={setBasis}
        endpoint={f.model_endpoint}
        sensitiveMatter={f.confidentiality === "high"}
      />
      <button type="button" className="btn-link" onClick={() => setMore((v) => !v)}>{more ? "收起更多设置" : "更多设置（密级、法域、模型、分析截止日）"}</button>
      {more && (
        <div className="form-grid">
        <label className="field">
          <span>法域</span>
          <input value={f.jurisdiction} onChange={set("jurisdiction")} />
        </label>
        <label className="field">
          <span>密级</span>
          <select value={f.confidentiality} onChange={set("confidentiality")}>{LEVELS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}</select>
          <small className="muted">{LEVELS.find((l) => l.v === f.confidentiality)?.hint}</small>
        </label>
        <label className="field">
          <span>AI 模型通道</span>
          <select value={f.model_endpoint} onChange={set("model_endpoint")}>
            {Object.entries(ENDPOINT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field">
          <span>分析截止日（可选）</span>
          <input type="date" value={f.analysis_as_of} onChange={set("analysis_as_of")} />
        </label>
        </div>
      )}
      {err && <div className="banner banner-red">{err}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>取消</button>
        <button className="btn-primary" disabled={busy} onClick={() => void submit()}>创建事项</button>
      </div>
    </Modal>
  );
}
