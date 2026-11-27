/**
 * 新建事项（第 03 篇 §5 步骤 5；第 02 篇 §8.1：四项依据分别记录，任一项“待确认”时该事项只运行不出站的本机能力）。
 * 第 48 批（D-202）：客户授权不再每次三选一——律师在设置里声明过“委托合同含 AI 辅助条款”时只占一行，默认按此记录。
 * 第 51 批（D-216）：新建时不再记录客户授权——授权依据要逐案、可核对（合同条款或书面同意的出处），在本事项第一次用 AI 时
 * 由“开始前确认”记录（见 components/Consent.tsx）；新建只定“怎么处理”：一般 / 敏感（全部化名）/ 客户要求不上云（只在本机）。
 */
import { useEffect, useState } from "react";
import { api, type Matter, type MatterBasis, type MatterTemplate } from "../api.ts";
import { loadTemplates } from "./MatterSetup.tsx";
import { LINE_LABELS } from "../lib/scenarios.ts";
import { ENDPOINT_LABELS } from "../lib/labels.ts";
import { basisForChoice } from "../lib/authorization.ts";
import { Modal } from "./Modal.tsx";
import { notifyDataChanged } from "../lib/events.ts";
import { Select } from "./Select.tsx";
import { eventDateProblem, STAGE_LABELS, stagesFor } from "../lib/matter-stage.ts";

// 我方立场（v9.4：补上劳动争议、借贷担保、委托服务、建设工程与二审的立场——S1 评审 §2.4；按业务类型分组提示）
export const STANCE_GROUPS: [string, string[]][] = [
  ["诉讼仲裁", ["原告", "被告", "上诉人", "被上诉人", "申请人", "被申请人", "第三人"]],
  ["劳动争议", ["用人单位", "劳动者"]],
  ["交易与合同", ["买方", "卖方", "受让方", "转让方", "出租人", "承租人", "出借人", "借款人", "保证人", "委托方", "服务方", "发包人", "承包人", "投资方", "目标公司", "创始股东"]],
  ["顾问", ["常年顾问", "其他"]],
];
export const STANCE_OPTIONS = STANCE_GROUPS.flatMap(([hint, list]) => list.map((s) => ({ value: s, label: s, hint })));
// 怎么处理（第 51 批）：一般 / 敏感 / 客户要求不上云（L3b，只在本机）——放在表单主体里，一处设定，不再拆到“客户授权”与“更多设置”两处
export const LEVELS = [
  { v: "normal", label: "一般", hint: "委托事项中的合同、函件、案卷、意见书。第一次用 AI 时记录客户授权依据" },
  { v: "high", label: "敏感", hint: "敏感个人信息、刑事卷宗等：公司名称也替换为代号，每条联网检索都要你确认；用 AI 前另需敏感信息的单独同意" },
  { v: "strict", label: "客户要求不上云", hint: "只在这台电脑上处理：不用云端 AI，也不联网查询" },
];

/**
 * 精简新建（第 72 批，D-301）：首页发送时就地新建事项，只问名称、我方立场、处理方式三项；其余与完整弹窗的缺省相同
 * （中国大陆、标准 AI 端点、四项依据待确认——第一次用 AI 时在“开始前确认”逐案记录，D-216）。
 */
export async function quickCreateMatter(f: { title: string; stance: string; confidentiality: string }): Promise<Matter> {
  const basis: MatterBasis = basisForChoice("pending", f.confidentiality === "high");
  const r = await api.createMatter({
    title: f.title.trim(),
    client_name: null,
    counterparty: null,
    stance: f.stance,
    jurisdiction: "中国大陆",
    confidentiality: f.confidentiality,
    model_endpoint: "standard",
    basis: { ...basis, subprocessor: basis.subprocessor === "not_applicable" ? "pending" : basis.subprocessor },
    key_dates: {},
  });
  notifyDataChanged();
  return r.matter;
}

export function NewMatterDialog({ onClose, onCreated, initial }: { onClose: () => void; onCreated: (m: Matter) => void; /** 第 72 批：从首页“放进哪个事项”的“更多设置”进来时带上已填的三项。 */ initial?: { title?: string; stance?: string; confidentiality?: string } }) {
  const [f, setF] = useState({ title: initial?.title ?? "", client_name: "", counterparty: "", stance: initial?.stance || "原告", jurisdiction: "中国大陆", confidentiality: initial?.confidentiality ?? "normal", model_endpoint: "standard", analysis_as_of: "", stage: "", event_date: "", region: "" });
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
    if (t) setF((cur) => ({ ...cur, stance: t.stances.includes(cur.stance) || (t.stance_aliases ?? []).includes(cur.stance) ? cur.stance : t.stances[0]!, stage: t.stage ?? cur.stage }));
  };
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    if (!f.title.trim()) return setErr("请填写事项名称");
    const ep = eventDateProblem(f.event_date);
    if (ep) return setErr(`事件时点：${ep}`);
    setBusy(true);
    setErr("");
    // 四项依据一律待确认（第 51 批）：第一次用 AI 时在“开始前确认”逐案记录依据与出处；敏感事项的“敏感信息特别条件”同样逐案确认
    const basis: MatterBasis = basisForChoice("pending", f.confidentiality === "high");
    try {
      const r = await api.createMatter({
        title: f.title.trim(),
        client_name: f.client_name.trim() || null,
        counterparty: f.counterparty.trim() || null,
        stance: f.stance,
        jurisdiction: f.jurisdiction,
        // “客户要求不上云”= 当事人限制（只在本机处理，L3b）
        confidentiality: f.confidentiality,
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
          {/* 立场与事项类型对不上（复核 Q4 建议 3）：期限按模板的一方推算，填了起算日的内核拒绝创建 */}
          {tpl && !tpl.stances.includes(f.stance) && !(tpl.stance_aliases ?? []).includes(f.stance) && (
            <small className="field-warn">“{tpl.title}”通常是{tpl.stances.join("、")}一方{tpl.start_fact ? "，期限也按这一方推算：立场不改的话请不要填起算日期" : ""}</small>
          )}
        </label>
        <label className="field">
          <span>当前阶段（可空）</span>
          <Select aria-label="当前阶段" value={f.stage} placeholder="不填" onChange={(v) => set("stage")({ target: { value: v } })} options={[{ value: "", label: "不填" }, ...stagesFor(f.stance, f.stage).map((s) => ({ value: s, label: STAGE_LABELS[s] }))]} />
        </label>
      </div>
      <div className="authz-field" role="group" aria-label="怎么处理">
        <div className="authz-head">
          <span className="authz-k">怎么处理</span>
        </div>
        <div className="seg authz-seg" role="radiogroup" aria-label="怎么处理">
          {LEVELS.map((l) => (
            <button key={l.v} type="button" role="radio" aria-checked={f.confidentiality === l.v} className={`seg-btn${f.confidentiality === l.v ? " on" : ""}`} onClick={() => set("confidentiality")({ target: { value: l.v } })}>
              {l.label}
            </button>
          ))}
        </div>
        <p className="authz-note">{LEVELS.find((l) => l.v === f.confidentiality)?.hint}</p>
      </div>
      <button type="button" className="btn-link" onClick={() => setMore((v) => !v)}>{more ? "收起更多设置" : "更多设置（事件时点、地域、使用哪种 AI、分析截止日）"}</button>
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
