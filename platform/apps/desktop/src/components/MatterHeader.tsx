/**
 * 事项头（第 03 篇 §4.4，常显）：客户 / 相对方 / 立场 / 法域 / 关键日期；第二行只放一个“保护状态”胶囊（依据、密级、端点、化名合在一起说，
 * 点开四行；UIUX 增量评审 §3.2）与当事人名单。
 * 依据任一项“待确认”时，该事项只运行不出站的本机能力（第 02 篇 §8.1）。
 */
import type { Matter, MatterBasis, RunPolicyView } from "../api.ts";
import { BASIS_FIELDS, BASIS_VALUE_LABELS, ENDPOINT_LABELS } from "../lib/labels.ts";
import { jurisdictionLabel, stanceLabel } from "../lib/labels.ts";
import { Icon } from "./Icons.tsx";
import { STAGE_LABELS, type Stage } from "../lib/matter-stage.ts";

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
  const fullPseudonym = !!matter.full_pseudonym || level === "L3a";
  const protect =
    refused || level === "L3b"
      ? { icon: Icon.lock, label: "客户要求不上云 · 只用本机功能", tone: "pill-red" }
      : !complete
        ? { icon: Icon.question, label: "AI 暂不可用：客户同意待确认", tone: "pill-orange" }
        : level === "L3a"
          ? { icon: Icon.shield, label: "敏感事项 · 全部化名 · 每条检索都要你确认", tone: "pill-blue" }
          : { icon: Icon.shield, label: `可用 AI · 姓名证件发送前换成代号${fullPseudonym ? " · 公司名称也换" : ""}`, tone: "pill-green" };
  return (
    <div className="matter-head">
      <div className="mh-row">
        <Field k="客户" v={matter.client_name ?? "—"} />
        <Field k="相对方" v={matter.counterparty ?? "—"} />
        <Field k="立场" v={stanceLabel(matter.stance)} />
        <Field k="法域" v={jurisdictionLabel(matter.jurisdiction)} />
        {matter.stage && matter.stage in STAGE_LABELS && <Field k="阶段" v={STAGE_LABELS[matter.stage as Stage]} />}
        {dates.slice(0, 2).map(([k, v]) => (
          <Field key={k} k={k === "analysis_as_of" ? "分析截止日" : k} v={v} />
        ))}
      </div>
      <div className="mh-row">
        {/* 保护状态（UIUX 增量评审 §3.2）：一个胶囊说清“能不能用 AI、发出去前替换了什么”，展开四行；技术细节在设置页 */}
        <details className="protect">
          <summary className={`pill ${protect.tone}`} aria-label={`保护状态：${protect.label}`}>
            <protect.icon /> {protect.label} <Icon.down />
          </summary>
          <div className="protect-pop" role="group" aria-label="本事项的保护状态">
            <div className="protect-line">
              <span className="protect-k">客户同意</span>
              <span>{refused ? "客户要求不上云（已记录）" : complete ? "已记录" : "客户同意还没记录：暂时只能用不联网的本机功能"}</span>
              {onEditBasis && !refused && (
                <button className="btn-link" onClick={onEditBasis}>
                  {complete ? "调整" : "去确认"}
                </button>
              )}
            </div>
            <div className="protect-line">
              <span className="protect-k">发给 AI 前替换</span>
              <span>证件号、手机号、账号、住址、自然人姓名 ✓ · 公司名称：{fullPseudonym ? "也替换" : "保留"}</span>
              {level !== "L3a" && onToggleFullPseudonym && (
                <button className="btn-link" onClick={() => onToggleFullPseudonym(!matter.full_pseudonym)}>
                  {matter.full_pseudonym ? "改为保留公司名称" : "改为也替换"}
                </button>
              )}
              {level === "L3a" && <span className="muted">（敏感事项必须）</span>}
            </div>
            <div className="protect-line">
              <span className="protect-k">联网检索</span>
              <span>{level === "L3b" || refused ? "不可用" : level === "L3a" ? "只发改写后的一般性查询，每一条都要你确认" : "自动去掉当事人名称后发出；含当事人名称的要你确认"}</span>
            </div>
            <div className="protect-line">
              <span className="protect-k">案卷保存</span>
              <span>存在这台电脑，已加密 · 使用 {ENDPOINT_LABELS[matter.model_endpoint] ?? matter.model_endpoint}</span>
            </div>
            {(level === "L3a" || level === "L3b") && (
              <div className="protect-line">
                <span className="protect-k">截屏与共享</span>
                <span>已遮挡：截图、录屏和远程会议共享屏幕时，看不到本事项的页面</span>
              </div>
            )}
          </div>
        </details>
        {onParties && (
          <button className="pill pill-link" onClick={onParties}>
            当事人名单
          </button>
        )}
      </div>
      {refused && (
        <div className="mh-note mh-red">
          客户拒绝云端处理（已记录）：不用云端 AI，也不联网检索，只能用律所私有模型（如已部署）或本机能力；补填客户授权情况也不改变这一点。如已取得新的书面同意，核实后再清除这条记录。
          {onClearRefusal && (
            <button className="btn-link" onClick={onClearRefusal}>
              清除拒绝记录
            </button>
          )}
        </div>
      )}
      {basis && !complete && !refused && (
        <div className="mh-note">
          {BASIS_FIELDS.filter((f) => basis[f.key] === "pending").map((f) => f.label).join("、")}待确认：确认前不会把材料发给 AI，也不会联网查询；只能用本机功能（读材料、比对、脱敏、核对法条）。
          {onConsentNotice && (
            <button className="btn-link" onClick={onConsentNotice}>
              生成告知函（草稿）
            </button>
          )}
        </div>
      )}
      {level === "L3b" && !refused && <div className="mh-note mh-red">客户要求不上云：不用云端 AI，也不联网检索；任何人都不能放开。</div>}
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
