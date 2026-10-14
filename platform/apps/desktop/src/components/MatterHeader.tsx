/**
 * 事项头（第 03 篇 §4.4，常显）：客户 / 相对方 / 立场 / 法域 / 关键日期 / 数据模式 / 密级 / 依据状态（四项）/ 允许的模型端点 / 执行位置 / 当事人化名开关。
 * 依据任一项“待确认”时，该事项只运行不出站的本机能力（第 02 篇 §8.1）。
 */
import type { Matter, MatterBasis, RunPolicyView } from "../api.ts";
import { BASIS_FIELDS, BASIS_VALUE_LABELS, ENDPOINT_LABELS, LEVEL_LABELS } from "../lib/labels.ts";

export function basisComplete(b: MatterBasis | undefined): boolean {
  if (!b) return false;
  return BASIS_FIELDS.every((f) => b[f.key] !== "pending");
}

export function MatterHeader({ matter, policy, onEditBasis, onToggleFullPseudonym, onParties, onConsentNotice, onClearRefusal }: {
  matter: Matter;
  policy?: RunPolicyView | null;
  onEditBasis?: () => void;
  onToggleFullPseudonym?: (on: boolean) => void;
  onParties?: () => void;
  /** 一键生成告知函（第 05 篇“四项依据”：任一项待确认时可用；生成物为草稿，发出前须律师复核）。 */
  onConsentNotice?: () => void;
  /** 清除“当事人拒绝云端处理”的记录（律师核实新的书面同意后；留痕）。 */
  onClearRefusal?: () => void;
}) {
  const level = matter.data_level ?? "L2";
  const basis = matter.basis;
  const refused = matter.consent_status === "refused";
  const complete = matter.basis_complete ?? (!refused && basisComplete(basis));
  const dates = Object.entries(matter.key_dates ?? {}).filter(([, v]) => !!v);
  return (
    <div className="matter-head">
      <div className="mh-row">
        <Field k="客户" v={matter.client_name ?? "—"} />
        <Field k="相对方" v={matter.counterparty ?? "—"} />
        <Field k="立场" v={matter.stance} />
        <Field k="法域" v={matter.jurisdiction} />
        {dates.slice(0, 2).map(([k, v]) => (
          <Field key={k} k={k === "analysis_as_of" ? "分析截止日" : k} v={v} />
        ))}
      </div>
      <div className="mh-row">
        <span className="pill pill-local" title="案卷在这台电脑上处理与保存；团队共享只以端到端加密形式存在">本地事项</span>
        <span className={`pill ${level === "L3b" ? "pill-red" : level === "L3a" ? "pill-orange" : "pill-gray"}`}>{LEVEL_LABELS[level] ?? level}</span>
        <button className={`pill ${complete ? "pill-green" : "pill-orange"}`} onClick={onEditBasis} disabled={!onEditBasis} title="四项依据：委托/保密授权、个人信息处理依据、敏感信息特别条件、转委托与次处理者">
          依据：{complete ? "齐备" : "待确认（只运行本机能力）"}
        </button>
        <span className="pill pill-gray" title="允许的模型端点">{ENDPOINT_LABELS[matter.model_endpoint] ?? matter.model_endpoint}</span>
        <span className="pill pill-gray" title="执行位置">{policy?.execution_location ?? "本机"}</span>
        <label className="pill pill-gray pill-toggle" title="开启后机构名称也替换为代号（L3a 强制）">
          <input
            type="checkbox"
            checked={!!matter.full_pseudonym || level === "L3a"}
            disabled={level === "L3a" || !onToggleFullPseudonym}
            onChange={(e) => onToggleFullPseudonym?.(e.target.checked)}
          />
          全部化名
        </label>
        {onParties && (
          <button className="pill pill-link" onClick={onParties}>
            当事人词典
          </button>
        )}
      </div>
      {refused && (
        <div className="mh-note mh-red">
          当事人拒绝云端处理（记录）：按当事人限制（L3b）处理——不使用云端模型与联网检索，只能使用律所私有模型（如已部署）或本机能力；补录四项依据不改变这一点。如已取得新的书面同意，核实后再清除这条记录。
          {onClearRefusal && (
            <button className="btn-link" onClick={onClearRefusal}>
              清除拒绝记录
            </button>
          )}
        </div>
      )}
      {basis && !complete && !refused && (
        <div className="mh-note">
          {BASIS_FIELDS.filter((f) => basis[f.key] === "pending").map((f) => f.label).join("、")}待确认：模型推理、联网检索与抓取都不会发生，只运行解析、比对、脱敏、法条核验等本机能力。
          {onConsentNotice && (
            <button className="btn-link" onClick={onConsentNotice}>
              生成告知函（草稿）
            </button>
          )}
        </div>
      )}
      {level === "L3b" && !refused && <div className="mh-note mh-red">当事人限制（L3b）：不使用云端模型与联网检索；任何管理员不可放开。</div>}
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <span className="mh-field">
      <span className="mh-k">{k}</span>
      <span className="mh-v">{v}</span>
    </span>
  );
}

/**
 * 四项依据编辑（复核 S5-A09）：委托/保密授权不能“不适用”；转委托与次处理者只在律所私有模型或不使用模型时可“不适用”。
 */
export function BasisEditor({ basis, endpoint, onChange }: { basis: MatterBasis; endpoint: string; onChange: (b: MatterBasis) => void }) {
  const naAllowed = (key: string) => key !== "engagement" && (key !== "subprocessor" || endpoint === "private" || endpoint === "none");
  return (
    <div className="basis-editor">
      {BASIS_FIELDS.map((f) => (
        <div key={f.key} className="basis-row">
          <div>
            <div className="basis-label">{f.label}</div>
            <div className="muted">{f.hint}</div>
          </div>
          <div className="seg">
            {(["confirmed", "pending", "not_applicable"] as const).filter((v) => v !== "not_applicable" || naAllowed(f.key)).map((v) => (
              <button key={v} className={`seg-btn${basis[f.key] === v ? " on" : ""}`} onClick={() => onChange({ ...basis, [f.key]: v })}>
                {BASIS_VALUE_LABELS[v]}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
