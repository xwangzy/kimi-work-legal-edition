/**
 * 客户授权（第 48 批重构 D-202；第 51 批改为“每个事项第一次用 AI 时逐案记录依据”，D-216）。
 *
 * 三件事分开：
 *  - 数据保护是系统默认做的，不问律师：发给 AI 前替换姓名、证件号、电话等；案卷只存本机且加密；每次发出可逐条查看。
 *  - 首次使用 AI 的数据去向告知是给律师本人的（components/AiNotice.tsx），看过一次即可，不代表客户授权。
 *  - 客户授权是法律与委托合同上的事实，系统替代不了。合规核验：律师点确认不等于客户授权，依据是每一份委托合同（或客户书面同意），
 *    不是律师的一次声明（第 48 批“设置里开一次、新建事项默认已授权”因此改掉）。所以每个事项第一次用 AI 时，在“开始前确认”里
 *    记录：依据类型（委托合同中的 AI 条款 / 客户单独书面同意）+ 可核对的出处 + 当时告知的次处理者清单（内核记版本与审计）。
 *    律师设了常用条款时预选并预填（一键确认）；次处理者清单变了再请律师确认一次；敏感事项另勾敏感个人信息的单独同意。
 * 内核仍分别记录四项依据（第 02 篇 §8.1，闸门、宿主、网关口径不变）。
 */
import type { AiSubprocessors, DataFlowEntry, MatterBasis } from "../api.ts";
import { aiRoleOf, authzFlowRows } from "../lib/team-matters.ts";
import { useRelayState } from "./TeamMatter.tsx";
import { BasisEditor } from "./MatterHeader.tsx";
import "../styles-authz.css";
import "../styles-motion.css";
import { BASIS_KIND_LABELS, BASIS_REF_MAX, basisForChoice, type AuthRecord, type BasisKind } from "../lib/authorization.ts";
export { authorizationLine, basisAfterConfirm, basisForChoice, confirmNeeds, initialRecord, needsReconfirm, recordReady, type AuthChoice, type AuthRecord, type BasisKind, type BasisSource } from "../lib/authorization.ts";

/** 次处理者清单读不到时（旧内核）的写法，与数据去向页口径一致。 */
const FALLBACK_PROCESSORS: AiSubprocessors = { version: "", items: [{ name: "中软国际", role: "云端转发，不保存内容" }, { name: "月之暗面", role: "Kimi 模型推理" }] };

/**
 * 记录本案的客户授权（开始前确认、事项页“记录授权”共用）。
 * 依据类型两张选择卡 → 出处（必填，可预填）→ 授权覆盖什么（只读三行：用途、次处理者、替换）→ 敏感事项的单独同意 → 一句“这是什么记录”。
 * 还没取得时不在这里勾：开始前确认给出“先只用本机功能”与“客户要求不上云”两个出口。
 */
export function AuthorizationRecord({
  matterTitle,
  clientName,
  value,
  onChange,
  sensitive,
  reconfirm,
  processors,
  detail,
  onDetail,
  endpoint,
  basis,
  needsRef = false,
  dataFlows = null,
  reconfirmWhy = "list",
  team = false,
}: {
  /** 事项是团队共享（collab_scope = team）：内核没给数据去向时也固定列出“同事电脑”；所内还没开通同事之间同步时写成“开通后会同步到…”。 */
  team?: boolean;
  /** 第 73 批（验收 P2-3）：按事项范围的数据去向（只有我 = 案卷只存这台电脑；和同事一起办 = 同事电脑、中软加密副本）。 */
  dataFlows?: readonly DataFlowEntry[] | null;
  /** 要重新确认的原因：次处理者清单更新 / 事项改为和同事一起办（原授权没覆盖同事之间同步）。 */
  reconfirmWhy?: "scope" | "list";
  /** 早期记录缺少出处（D-225）：重新确认卡说明“请补记一次”。 */
  needsRef?: boolean;
  matterTitle: string;
  clientName?: string | null;
  value: AuthRecord;
  onChange: (v: AuthRecord) => void;
  /** 敏感事项：须另勾敏感个人信息的单独同意。 */
  sensitive: boolean;
  /** 次处理者清单更新后的重新确认。 */
  reconfirm: boolean;
  processors?: AiSubprocessors | null;
  /** 逐项记录（四项编辑器，给要分项记录的律师）；null = 收起。 */
  detail: MatterBasis | null;
  onDetail: (b: MatterBasis | null) => void;
  endpoint: string;
  basis: MatterBasis | undefined;
}) {
  const list = (processors ?? FALLBACK_PROCESSORS).items;
  const relay = useRelayState(team);
  const flows = authzFlowRows(dataFlows, { team, relay: team ? relay.ready : null });
  // 产品评分 G5-3：分两段——“授权要覆盖（AI 使用时）”与“选团队共享时已发生”；同步与中软加密副本不放进 AI 次处理者里冒充
  const teamRows = flows.rows.filter((f) => f.when === "on_team_share");
  const aiRows = flows.rows.filter((f) => f.when !== "on_team_share");
  const split = teamRows.length > 0;
  // 中软那条去向若已写在次处理者的说明里、又没有单独一段时，不再单列一行（实拍：同一句说两遍）
  const flowRows = split ? aiRows : flows.rows.filter((f) => !(f.key === "zr_relay" && list.some((p) => /加密副本/.test(p.role))));
  // 第二段的标题：所内已开通同步时是“已发生”，没开通时如实说“开通后发生”
  const teamHead = team && relay.ready === false ? "选团队共享后、所内开通同事之间同步时发生" : "选团队共享时已发生（律所已开通同事之间同步）";
  const pick = (k: BasisKind) => onChange({ ...value, kind: k, ref: value.kind === k ? value.ref : k === "engagement_terms" && value.kind === null ? value.ref : "" });
  return (
    <section className="authz-record" aria-labelledby="authz-record-h">
      <div className="authz-record-head">
        <h3 id="authz-record-h">{needsRef ? "请补记本案授权的出处" : reconfirm ? (reconfirmWhy === "scope" ? "这个事项改为团队共享了，请重新确认本案授权" : "AI 次处理者有变化，请重新确认本案授权") : "记录本案的客户授权"}</h3>
        {/* 第二轮复评 T12：重新确认的说明压到两行，不再贴一遍标准段落（第一次记录时才说“这是什么记录”） */}
        <p>
          {needsRef
            ? "这是早期记录，缺少出处，请补记一次。"
            : reconfirm
              ? reconfirmWhy === "scope"
                ? "原来的授权只覆盖这台电脑，没覆盖同事之间同步；核实客户授权覆盖下面的范围后重新记录，记录前不会发给 AI。"
                : "原来记录的授权依据告知的是旧的次处理者清单；核实客户授权覆盖下面的新清单后重新确认，确认前不会发给 AI。"
              : "这是本事项第一次用 AI。请记下客户授权的依据——它是你核实过的事实记录，不代替客户本人的授权；记录随事项保存、写进事项日志。"}
        </p>
      </div>
      {detail ? (
        <>
          <BasisEditor basis={detail} endpoint={endpoint} onChange={onDetail} />
          {/* D-225：逐项记录同样要写出处（不填不能确认），并按当前次处理者清单记版本 */}
          <label className="authz-ref">
            <span>出处</span>
            <input
              value={value.ref}
              maxLength={BASIS_REF_MAX}
              placeholder="委托合同名称或编号、条款号；或客户书面同意的日期与方式"
              onChange={(e) => onChange({ ...value, ref: e.target.value })}
              aria-label="授权依据的出处"
            />
          </label>
        </>
      ) : (
        <>
          <div className="authz-kinds" role="radiogroup" aria-label="授权依据">
            {(Object.keys(BASIS_KIND_LABELS) as BasisKind[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={value.kind === k} className={`authz-kind${value.kind === k ? " on" : ""}`} onClick={() => pick(k)}>
                <span className="authz-kind-radio" aria-hidden="true" />
                <span className="authz-kind-text">
                  <b>{BASIS_KIND_LABELS[k].label}</b>
                  <small>{BASIS_KIND_LABELS[k].hint}</small>
                </span>
              </button>
            ))}
          </div>
          {value.kind && (
            <label className="authz-ref">
              <span>出处</span>
              <input
                value={value.ref}
                maxLength={BASIS_REF_MAX}
                placeholder={BASIS_KIND_LABELS[value.kind].placeholder}
                onChange={(e) => onChange({ ...value, ref: e.target.value })}
                aria-label="授权依据的出处"
                autoFocus={!value.ref}
              />
            </label>
          )}
          <dl className="authz-scope">
            <div>
              <dt>本案</dt>
              <dd>
                {matterTitle}
                {clientName ? ` · 客户 ${clientName}` : ""}
              </dd>
            </div>
            <div>
              <dt>
                授权要覆盖
                {split && <small className="authz-dt-when">（AI 使用时）</small>}
              </dt>
              <dd>使用 AI 辅助处理本案材料；次处理者：{list.map((p) => `${p.name}（${aiRoleOf(p.role, split)}）`).join("、")}</dd>
            </div>
            <div>
              <dt>系统另外做到</dt>
              <dd>发出前把姓名、证件号、电话等换成代号{flows.local ? `；${flows.local}` : ""}</dd>
            </div>
            {/* 第 73 批（验收 P2-3）：和同事一起办的事项如实列出数据去向（同事电脑、中软加密副本），不再写死“案卷只存这台电脑” */}
            {flowRows.map((f) => (
              <div key={f.key}>
                <dt>{f.label}</dt>
                <dd>{f.text}</dd>
              </div>
            ))}
          </dl>
          {split && (
            <div className="authz-scope authz-scope-team" role="group" aria-label={teamHead}>
              <p className="authz-scope-cap">{teamHead}</p>
              <dl className="authz-scope-list">
                {teamRows.map((f) => (
                  <div key={f.key}>
                    <dt>{f.label}</dt>
                    <dd>{f.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {sensitive && (
            <label className="authz-sensitive">
              <input type="checkbox" checked={value.sensitive} onChange={(e) => onChange({ ...value, sensitive: e.target.checked })} />
              <span>
                本案涉及的敏感个人信息（如健康、金融账户、未成年人信息），已取得客户的单独同意
                <small>敏感事项不随委托合同条款默认，须逐案确认。</small>
              </span>
            </label>
          )}
        </>
      )}
      <button type="button" className="btn-link authz-detail-toggle" onClick={() => onDetail(detail ? null : (basis ?? basisForChoice("pending", false)))}>
        {detail ? "收起逐项记录" : "改为逐项记录四项依据"}
      </button>
    </section>
  );
}
