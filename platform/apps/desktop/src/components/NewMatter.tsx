/**
 * 新建事项（第 03 篇 §5 步骤 5：填写或确认四项依据；第 02 篇 §8.1：数据准入不是一个“已同意”勾选框，四项分别记录）。
 * 任一项“待确认”时，该事项只运行不出站的本机能力。
 */
import { useEffect, useState } from "react";
import { api, type Matter, type MatterBasis, type MatterTemplate } from "../api.ts";
import { loadTemplates } from "./MatterSetup.tsx";
import { LINE_LABELS } from "../lib/scenarios.ts";
import { ENDPOINT_LABELS } from "../lib/labels.ts";
import { ConsentQuestion, type ConsentAnswer } from "./Consent.tsx";
import { Modal } from "./Modal.tsx";
import { notifyDataChanged } from "../lib/events.ts";
import { Select } from "./Select.tsx";
import { eventDateProblem, STAGE_LABELS, stagesFor } from "../lib/matter-stage.ts";

// 我方立场（v9.4：补上劳动争议、借贷担保、委托服务、建设工程与二审的立场——S1 评审 §2.4；按业务类型分组提示）
const STANCE_GROUPS: [string, string[]][] = [
  ["诉讼仲裁", ["原告", "被告", "上诉人", "被上诉人", "申请人", "被申请人", "第三人"]],
  ["劳动争议", ["用人单位", "劳动者"]],
  ["交易与合同", ["买方", "卖方", "受让方", "转让方", "出租人", "承租人", "出借人", "借款人", "保证人", "委托方", "服务方", "发包人", "承包人", "投资方", "目标公司"]],
  ["顾问", ["常年顾问", "其他"]],
];
const STANCE_OPTIONS = STANCE_GROUPS.flatMap(([hint, list]) => list.map((s) => ({ value: s, label: s, hint })));
const LEVELS = [
  { v: "normal", label: "一般", hint: "委托事项中的合同、函件、案卷、意见书" },
  { v: "high", label: "敏感", hint: "敏感个人信息、刑事卷宗等：公司名称也替换为代号，每条联网检索都要你确认" },
  { v: "strict", label: "客户要求不上云", hint: "只在这台电脑上处理：不用 AI，不联网查询" },
];

export function NewMatterDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (m: Matter) => void }) {
  const [f, setF] = useState({ title: "", client_name: "", counterparty: "", stance: "原告", jurisdiction: "中国大陆", confidentiality: "normal", model_endpoint: "standard", analysis_as_of: "", stage: "", event_date: "", region: "" });
  const [basis, setBasis] = useState<MatterBasis>({ engagement: "pending", personal_info: "pending", sensitive: "not_applicable", subprocessor: "pending" });
  const [consent, setConsent] = useState<ConsentAnswer>("not_yet");
  const [more, setMore] = useState(false);
  // 事项类型（v9.4 第 22 批，C1 #20）：选了就预置阶段、待办与常用方法；要起算日的（如收到起诉状之日）推出届满日
  const [templates, setTemplates] = useState<MatterTemplate[]>([]);
  const [tplId, setTplId] = useState("");
  const [tplStart, setTplStart] = useState("");
  useEffect(() => {
    void loadTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);
  const tpl = templates.find((t) => t.id === tplId) ?? null;
  const pickTemplate = (id: string) => {
    setTplId(id);
    setTplStart("");
    const t = templates.find((x) => x.id === id);
    // 立场与阶段跟着类型走（律师仍可改；阶段下拉框显示的就是创建后的阶段）
    if (t) setF((cur) => ({ ...cur, stance: t.stances.includes(cur.stance) ? cur.stance : t.stances[0]!, stage: t.stage ?? cur.stage }));
  };
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value });
    // 敏感事项（L3a）：“敏感信息特别条件”缺省改为待确认（不默认“不适用”）
    if (k === "confidentiality" && e.target.value === "high" && basis.sensitive === "not_applicable") setBasis({ ...basis, sensitive: "pending" });
  };
  const submit = async () => {
    if (!f.title.trim()) return setErr("请填写事项名称");
    const ep = eventDateProblem(f.event_date);
    if (ep) return setErr(`事件时点：${ep}`);
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
        // 程序阶段、事件时点、地域（v9.4 S-08）：没填不传
        ...(f.stage ? { stage: f.stage } : {}),
        ...(f.event_date.trim() ? { event_date: f.event_date.trim() } : {}),
        ...(f.region.trim() ? { region: f.region.trim() } : {}),
        ...(tpl ? { template_id: tpl.id } : {}),
        ...(tpl?.start_fact && tplStart ? { template_start: tplStart } : {}),
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
          <span>事项类型（可空）</span>
          <Select
            aria-label="事项类型"
            value={tplId}
            placeholder="不选"
            onChange={pickTemplate}
            options={[{ value: "", label: "不选" }, ...templates.map((t) => ({ value: t.id, label: t.title, hint: LINE_LABELS[t.line] }))]}
          />
          {tpl && <small className="muted">{tpl.hint}。会预置阶段、{tpl.todos.length + (tpl.start_fact && tplStart ? 1 : 0)} 条待办和常用方法，之后都可以改。</small>}
        </label>
        {tpl?.start_fact && (
          <label className="field field-wide">
            <span>{tpl.start_fact.label}（可空）</span>
            <input type="date" value={tplStart} onChange={(e) => setTplStart(e.target.value)} aria-label={tpl.start_fact.label} />
            <small className="muted">填了就按法定期间推出“{tpl.start_fact.deadline_key}”，写进关键日期和待办（不会自动设提醒）。{tpl.start_fact.basis}</small>
          </label>
        )}
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
          <Select aria-label="我方立场" value={f.stance} onChange={(v) => set("stance")({ target: { value: v } })} options={STANCE_OPTIONS} />
        </label>
        <label className="field">
          <span>当前阶段（可空）</span>
          <Select aria-label="当前阶段" value={f.stage} placeholder="不填" onChange={(v) => set("stage")({ target: { value: v } })} options={[{ value: "", label: "不填" }, ...stagesFor(f.stance, f.stage).map((s) => ({ value: s, label: STAGE_LABELS[s] }))]} />
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
      <button type="button" className="btn-link" onClick={() => setMore((v) => !v)}>{more ? "收起更多设置" : "更多设置（事件时点、地域、保密程度、AI 服务、资料截止日）"}</button>
      {more && (
        <div className="form-grid">
        <label className="field">
          <span>事件时点（可空）</span>
          <input value={f.event_date} onChange={set("event_date")} placeholder="如 2023-05 或 2023-05-06" />
          <small className="muted">{eventDateProblem(f.event_date) ?? "纠纷或交易的主要事实发生的时间；签发前按当时的版本核对引用"}</small>
        </label>
        <label className="field">
          <span>地域（可空）</span>
          <input value={f.region} onChange={set("region")} placeholder="如 上海市" maxLength={20} />
        </label>
        <label className="field">
          <span>法域</span>
          <input value={f.jurisdiction} onChange={set("jurisdiction")} />
        </label>
        <label className="field">
          <span>密级</span>
          <Select aria-label="敏感程度" value={f.confidentiality} onChange={(v) => set("confidentiality")({ target: { value: v } })} options={LEVELS.map((l) => ({ value: l.v, label: l.label }))} />
          <small className="muted">{LEVELS.find((l) => l.v === f.confidentiality)?.hint}</small>
        </label>
        <label className="field">
          <span>使用哪种 AI</span>
          <Select aria-label="使用哪种 AI" value={f.model_endpoint} onChange={(v) => set("model_endpoint")({ target: { value: v } })} options={Object.entries(ENDPOINT_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
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
