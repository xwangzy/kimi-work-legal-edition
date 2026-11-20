/**
 * 客户授权（第 48 批重构，D-202；取代 D-43 的“客户是否同意本案使用 AI 辅助？”三选一卡片）。
 *
 * 三件事分开说：
 *  - 数据保护是系统默认做的，不问律师：发给 AI 前替换姓名、证件号、电话等；案卷只存本机且加密；每次发出可逐条查看。
 *  - 客户授权是法律与委托合同上的事实，系统替代不了，但不该每个事项、每个任务都问：律师在设置里声明一次
 *    “我的委托合同含使用 AI 辅助及次处理者的条款”，之后新建事项默认按此记录（basis_source = engagement_terms）；
 *  - 例外按事项记：尚未取得（先只用本机功能）、客户要求不上云（只在本机处理）。敏感事项的“敏感信息特别条件”不随默认，逐案确认。
 * 内核仍分别记录四项依据（第 02 篇 §8.1，闸门、宿主、网关口径不变）。
 */
import { useState } from "react";
import type { MatterBasis } from "../api.ts";
import { BasisEditor } from "./MatterHeader.tsx";
import { basisForChoice, confirmNeeds, type AuthChoice } from "../lib/authorization.ts";
export { authorizationLine, basisAfterConfirm, basisForChoice, confirmNeeds, type AuthChoice, type BasisSource } from "../lib/authorization.ts";

const CHOICES: { v: AuthChoice; label: string; note: string }[] = [
  { v: "authorized", label: "已取得", note: "记为已取得客户同意（委托合同条款或书面确认）。发给 AI 前仍会把姓名、证件号、电话等换成代号。" },
  { v: "pending", label: "尚未取得", note: "先只用本机功能：读材料、比对、核对法条，不发给 AI、不联网；取得同意后，开始任务时一步记录即可。" },
  { v: "local_only", label: "客户要求不上云", note: "本事项只在这台电脑上处理：不用云端 AI，也不联网查询。" },
];

/**
 * 新建事项里的“客户授权”。已在设置里声明委托合同含 AI 条款时只占一行（按委托合同条款 · 本案不同），不再提问；
 * 没有声明时给三个选项，选“已取得”可顺手勾上“以后默认按委托合同条款”。
 */
export function AuthorizationField({
  engagementDefault,
  choice,
  onChoice,
  remember,
  onRemember,
  sensitiveMatter,
}: {
  /** 律师本人是否已声明委托合同含 AI 条款（设置 → 数据去向）。null = 还在读取。 */
  engagementDefault: boolean | null;
  choice: AuthChoice;
  onChoice: (c: AuthChoice) => void;
  remember: boolean;
  onRemember: (v: boolean) => void;
  sensitiveMatter: boolean;
}) {
  const [open, setOpen] = useState(false);
  const compact = engagementDefault === true && choice === "authorized" && !open;
  const sensitiveNote = sensitiveMatter && choice === "authorized" ? "敏感事项：敏感个人信息的单独同意不随默认设置，开始任务前另行确认。" : null;
  if (compact) {
    return (
      <div className="authz-field authz-compact">
        <span className="authz-k">客户授权</span>
        <span className="authz-v">
          <span className="authz-check" aria-hidden="true">✓</span>已取得 · 按你的委托合同条款
        </span>
        <button type="button" className="btn-link" onClick={() => setOpen(true)}>
          本案不同
        </button>
        {sensitiveNote && <p className="authz-note">{sensitiveNote}</p>}
      </div>
    );
  }
  const cur = CHOICES.find((c) => c.v === choice)!;
  return (
    <div className="authz-field" role="group" aria-label="客户授权">
      <div className="authz-head">
        <span className="authz-k">客户是否同意使用 AI 辅助</span>
        {engagementDefault && open && (
          <button type="button" className="btn-link" onClick={() => { onChoice("authorized"); setOpen(false); }}>
            恢复按委托合同条款
          </button>
        )}
      </div>
      <div className="seg authz-seg" role="radiogroup" aria-label="客户是否同意使用 AI 辅助">
        {CHOICES.map((c) => (
          <button key={c.v} type="button" role="radio" aria-checked={choice === c.v} className={`seg-btn${choice === c.v ? " on" : ""}`} onClick={() => onChoice(c.v)}>
            {c.label}
          </button>
        ))}
      </div>
      <p className="authz-note">{cur.note}</p>
      {sensitiveNote && <p className="authz-note">{sensitiveNote}</p>}
      {choice === "authorized" && !engagementDefault && engagementDefault !== null && (
        <label className="authz-remember">
          <input type="checkbox" checked={remember} onChange={(e) => onRemember(e.target.checked)} />
          <span>
            我的委托合同都含使用 AI 辅助的条款，以后新建事项默认按此记录
            <small>可在 设置 → 数据去向 里随时改；撤回只影响之后新建的事项。</small>
          </span>
        </label>
      )}
    </div>
  );
}

/**
 * 开始任务时补记授权（只在内核判定“依据待确认”时出现；L3b、不使用模型、席位失效等别的原因不在这里问）。
 * 一句说明 + 一到两个勾选：已取得客户同意；敏感事项另勾敏感个人信息的单独同意。逐项记录收在“逐项调整”。
 */
export function AuthorizationConfirm({
  basis,
  endpoint,
  general,
  sensitive,
  onGeneral,
  onSensitive,
  detail,
  onDetail,
}: {
  basis: MatterBasis | undefined;
  endpoint: string;
  general: boolean;
  sensitive: boolean;
  onGeneral: (v: boolean) => void;
  onSensitive: (v: boolean) => void;
  /** 逐项调整（四项编辑器）的当前值；null = 收起。 */
  detail: MatterBasis | null;
  onDetail: (b: MatterBasis | null) => void;
}) {
  const need = confirmNeeds(basis);
  return (
    <div className="authz-confirm" role="group" aria-label="记录客户授权">
      <div className="authz-confirm-title">{need.general ? "这个事项还没有记录客户授权" : "敏感事项还需确认一项授权"}</div>
      <p className="authz-note">
        {need.general ? "使用 AI 前需要客户同意（委托合同条款或书面确认）。" : "涉及敏感个人信息时，需取得单独同意。"}发给 AI 的内容仍会先把姓名、证件号、电话等换成代号。
      </p>
      {detail ? (
        <BasisEditor basis={detail} endpoint={endpoint} onChange={onDetail} />
      ) : (
        <>
          {need.general && (
            <label className="authz-remember">
              <input type="checkbox" checked={general} onChange={(e) => onGeneral(e.target.checked)} />
              <span>已取得客户同意</span>
            </label>
          )}
          {need.sensitive && (
            <label className="authz-remember">
              <input type="checkbox" checked={sensitive} onChange={(e) => onSensitive(e.target.checked)} />
              <span>敏感个人信息已取得单独同意</span>
            </label>
          )}
        </>
      )}
      <button type="button" className="btn-link authz-detail-toggle" onClick={() => onDetail(detail ? null : (basis ?? basisForChoice("pending", false)))}>
        {detail ? "收起逐项记录" : "逐项记录"}
      </button>
    </div>
  );
}
