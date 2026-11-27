/**
 * 发起前的预览（第 03 篇 §5 步骤 5：看到预计用量（占本月份额的百分比）与数据去向预览；第 04 篇 §15.2 先预估、后确认）。
 * 预估与去向由内核按事项记录计算；律师确认后才发起。
 */
import { useModelCatalog } from "./ModelPicker.tsx";
import { modelLabelOf } from "../lib/model-choices.ts";
import { pendingOptions } from "../lib/pending-options.ts";
import { useEffect, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { materialsLine, PREAUTH_LABELS } from "../lib/labels.ts";
import { modeSheetText } from "../lib/mode-options.ts";
import { freeTaskWhat, usageNoteShort } from "../lib/sheet-text.ts";
import type { ComposerValue } from "./Composer.tsx";
import { SCENARIO_LABELS } from "../lib/labels.ts";
import { Modal } from "./Modal.tsx";
import { AuthorizationRecord, basisAfterConfirm, confirmNeeds, initialRecord, needsReconfirm, recordReady, type AuthRecord } from "./Consent.tsx";
import { detailReady, detailSource } from "../lib/authorization.ts";
import type { AiAuthorization, MatterBasis, SendSummaryView } from "../api.ts";
import { AI_NOTICE_DECLINED, ensureAiNotice } from "../lib/ai-notice.ts";
import { BusyLabel } from "./Loading.tsx";
import { SendSummary } from "./SendSummary.tsx";
import { SendPoints } from "./SendPoints.tsx";
import { notifyDataChanged } from "../lib/events.ts";
import { afterConsentNotice, busyRunOfError, startHintOf, type StartHint } from "../lib/start-block.ts";
import { StartHintBanner } from "./StartHint.tsx";
import { localOnlyBlocked, reconfirmReason, teamFaultText } from "../lib/team-matters.ts";

export interface PendingStart {
  matter: Matter;
  value: ComposerValue;
  /** 业务场景卡指定的方法模板（Agent 任务）。 */
  skill?: string;
  /** 发起确认里“做什么”的显示名（业务场景名）。 */
  label?: string;
  /** 场景卡字段（方法参数；v9.4 显式传给 Agent）。 */
  skillArgs?: Record<string, string>;
  /** 本事项审查要点（v9.4 第 22 批）：false = 本次不按要点审；缺省由内核按方法决定。 */
  reviewRules?: boolean;
  /** 场景卡指定的主交付物（第 29 批）。 */
  primaryOutput?: string;
  /** 所选材料的文件名（第 26 批，评审 U2-23：确认卡回显用到哪几份，只在本机显示）。 */
  docNames?: string[];
  /** 第 66 批：首页选择器选的模型（api.modelsList("task") 的 ModelOption.id）；不给 = 内核按律师记住的或缺省。 */
  model?: string;
  estimate: {
    estimate_id: string;
    points: number;
    points_display: string;
    assumptions: string[];
    data_where?: { preview?: string; preview_rows?: { label: string; text: string }[]; bullets?: string[]; bullet_kinds?: string[]; warning?: string | null; start_blocked?: boolean; block_kind?: "exit_mode" | "busy" | "consent" | "policy" | "suspects" | "account" | "quota" | null; reconfirm?: boolean; needs_ref?: boolean; busy_run_id?: string; send_summary?: SendSummaryView; start_hint?: StartHint };
  };
}

/** 发起任务（确认卡与场景开始面板共用）：返回任务编号并跳到执行态。 */
export async function launchRun(p: PendingStart): Promise<string> {
  // 第一次用 AI 时先给律师本人看数据去向告知（第 51 批；看过一次即不再出现，读不到告知接口时不拦）
  if (!(await ensureAiNotice(api.aiNotice, api.ackAiNotice))) throw new Error(AI_NOTICE_DECLINED);
  const agent = p.value.scenario === "a1.agent_task";
  const run = await api.startRun(p.matter.matter_id, {
    estimate_id: p.estimate.estimate_id,
    idempotency_key: `${p.matter.matter_id}-${p.value.scenario}-${Date.now()}`,
    ...(p.value.goal.trim() ? { goal: p.value.goal.trim() } : {}),
    // 任务名（第 26 批）：场景卡名等固定文字，列表与执行页标题用它；律师自己描述的任务不传，标题用描述
    ...(p.label ? { title: p.label } : {}),
    ...(agent ? { mode: p.value.choice.mode, plan_first: p.value.choice.mode === "chat" ? false : p.value.choice.planFirst, preauthorizations: p.value.choice.mode === "auto" ? p.value.choice.preauth : [] } : {}),
    ...(agent && p.skill ? { skill: p.skill } : {}),
    ...(agent && p.skill && p.skillArgs && Object.keys(p.skillArgs).length > 0 ? { skill_args: p.skillArgs } : {}),
    ...(agent && p.skill && p.reviewRules === false ? { review_rules: false } : {}),
    ...(agent && p.skill && p.primaryOutput ? { primary_output: p.primaryOutput } : {}),
    ...(p.model ? { model: p.model } : {}),
  });
  notifyDataChanged();
  nav(`/run/${run.run_id}/${p.matter.matter_id}`);
  return run.run_id;
}

/** 预估（失败抛出内核原因，例如场景须有材料）。 */
export async function prepareStart(matter: Matter, value: ComposerValue, o: { skill?: string; label?: string; skillArgs?: Record<string, string>; reviewRules?: boolean; primaryOutput?: string; docNames?: string[]; /** 第 66 批：所选模型。 */ model?: string } = {}): Promise<PendingStart> {
  const extra: Record<string, unknown> = {};
  if (value.scenario === "s1b.draft_compare") {
    if (value.documentIds.length < 2) throw new Error("回稿比对需要选择两份文档：先选基线稿，再选回稿");
    extra.baseline_document_version_id = value.documentIds[0];
    extra.current_document_version_id = value.documentIds[1];
  }
  if (value.goal.trim()) extra.goal = value.goal.trim();
  if (value.scenario === "s2.case_file" && value.issues?.length) extra.issues = value.issues;
  const estimate = await api.estimate(matter.matter_id, { scenario: value.scenario, document_version_ids: value.documentIds, ...extra });
  return { matter, value, estimate: estimate as PendingStart["estimate"], ...(o.skill ? { skill: o.skill } : {}), ...(o.label ? { label: o.label } : {}), ...(o.skillArgs ? { skillArgs: o.skillArgs } : {}), ...(o.reviewRules !== undefined ? { reviewRules: o.reviewRules } : {}), ...(o.primaryOutput ? { primaryOutput: o.primaryOutput } : {}), ...(o.docNames ? { docNames: o.docNames } : {}), ...(o.model ? { model: o.model } : {}) };
}

export function RunSheet({ pending, onClose }: { pending: PendingStart; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** 发起时被拒（并发发起，409 带进行中任务编号；复核 B4-B13）：错误提示旁给出入口。 */
  const [errBusyRun, setErrBusyRun] = useState<string | null>(null);
  /** 发起时内核按登录、额度拦下（第 46 批）：显示成可操作的提示，不当红色报错。 */
  const [errHint, setErrHint] = useState<StartHint | null>(null);
  const [cur, setCur] = useState(pending);
  const { matter, value, estimate } = cur;
  const agent = value.scenario === "a1.agent_task";
  // 第 66 批：显示本次用的模型（与首页 / 开始面板同一份云端目录）
  const [catalog] = useModelCatalog("task", agent);
  const modelName = catalog ? modelLabelOf(cur.model ? { ...catalog, selected: cur.model } : catalog) : null;
  const blocked = !!estimate.data_where?.start_blocked;
  // 只有“依据待确认”可以原地修复（第 48 批：内核把 L3b、不使用模型、席位失效等分成 policy，不再一律当成“去记录同意”）；
  // 事项里另有进行中的任务、或处于退出模式时只说明原因并禁用开始
  const consentBlocked = blocked && estimate.data_where?.block_kind === "consent";
  const busyRun = estimate.data_where?.block_kind === "busy" ? estimate.data_where.busy_run_id : undefined;
  // 敏感事项（L3a）：像姓名的文字核对完才能开始（v9.2 §3.3）；核对后重新估价
  const suspectsBlocked = blocked && estimate.data_where?.block_kind === "suspects";
  // 要重新登录、额度暂停（第 46 批）：原因与入口
  const hint = blocked ? startHintOf(estimate.data_where?.start_hint) : null;
  const failed = (e: unknown) => {
    const h = startHintOf(e);
    setErrHint(h);
    setErr(h ? "" : (e as Error).message);
    setErrBusyRun(h ? null : busyRunOfError(e));
  };
  const reestimate = async () => {
    setErr("");
    try {
      setCur(await prepareStart(matter, value, pendingOptions(cur)));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  // 依据未齐时原地记录（第 51 批，D-216）：本事项第一次用 AI——记下依据类型与出处（委托合同条款 / 客户书面同意），
  // 律师设了常用条款时预选并预填；次处理者清单变了时重新确认；敏感事项另勾单独同意。记录后重新预估再发起
  const sensitive = matter.confidentiality === "high";
  const need = confirmNeeds(matter.basis);
  const [defaults, setDefaults] = useState<AiAuthorization | null>(null);
  const [record, setRecord] = useState<AuthRecord>(() => initialRecord(null, matter));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!consentBlocked) return;
    // 第 73 批（验收 P2-3）：按事项范围取次处理者清单与数据去向（和同事一起办的事项另有一份）
    api
      .aiAuthorization(matter.matter_id)
      .then((a) => {
        setDefaults(a);
        // 律师还没动过表单时按常用条款预填（读取有先后，不覆盖律师已经填的）
        if (!touched) setRecord(initialRecord(a, matter));
      })
      .catch(() => setDefaults(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consentBlocked]);
  // D-225：早期记录缺少出处（内核 needs_ref / basis_state）同样走重新确认卡，文案说明“请补记一次”
  const needsRef = !!estimate.data_where?.needs_ref || matter.basis_state === "needs_ref";
  // 按事项范围的清单版本判断（团队共享事项拿全局清单比会被误判要重新确认）
  const scopeVersion = matter.subprocessors?.version ?? defaults?.subprocessors?.version;
  const reconfirm = needsRef || !!estimate.data_where?.reconfirm || needsReconfirm(matter, scopeVersion);
  const reconfirmWhy = reconfirmReason(matter, scopeVersion);
  const [detail, setDetail] = useState<MatterBasis | null>(null);
  // 逐项记录同样须写出处（D-225）
  const canRecord = detail ? detailReady(record.ref) : recordReady(record, need.sensitive);
  const [localOnlyBusy, setLocalOnlyBusy] = useState(false);
  // 第 73 批（D-307，内核 team_scope_conflict）：团队共享事项不能记为客户要求不上云——置灰并说原因
  const localOnlyWhy = localOnlyBlocked(matter);
  /** 客户要求不上云：记录后本事项只在这台电脑上处理（不用云端 AI、不联网），关闭确认卡。 */
  const markLocalOnly = async () => {
    setLocalOnlyBusy(true);
    setErr("");
    try {
      await api.updateMatter(matter.matter_id, { consent_status: "refused" });
      notifyDataChanged();
      onClose();
    } catch (e) {
      setErr(teamFaultText(e));
    } finally {
      setLocalOnlyBusy(false);
    }
  };
  const recordConsentAndStart = async () => {
    setBusy(true);
    setErr("");
    const basis: MatterBasis = detail ?? basisAfterConfirm(matter.basis, { general: true, sensitive: record.sensitive });
    try {
      // 告知在记录之前：律师先知道数据去哪，再记录客户授权（第 51 批）
      if (!(await ensureAiNotice(api.aiNotice, api.ackAiNotice))) throw new Error(AI_NOTICE_DECLINED);
      // 两条路径都带依据类型与出处（D-225：逐项记录不再只交四项）；内核按当前次处理者清单记版本、追加授权记录
      await api.updateMatter(matter.matter_id, { basis, basis_source: detail ? detailSource(record, matter) : record.kind, basis_ref: record.ref.trim() });
      notifyDataChanged();
      const fresh = await prepareStart({ ...matter, basis }, value, pendingOptions(cur));
      setCur(fresh);
      if (fresh.estimate.data_where?.start_blocked) {
        setErr(afterConsentNotice(fresh.estimate.data_where.block_kind, sensitive));
        return;
      }
      await doStart(fresh);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    setErr("");
    setErrHint(null);
    setErrBusyRun(null);
    try {
      await doStart(cur);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const doStart = async (p: PendingStart) => {
    await launchRun(p);
    onClose();
  };
  return (
    <Modal title="开始前确认" onClose={onClose}>
      <dl className="sheet">
        <dt>事项</dt>
        <dd>{matter.title}</dd>
        <dt>做什么</dt>
        <dd>
          {cur.label ?? (agent ? freeTaskWhat(value.choice.mode !== "chat" && value.choice.planFirst) : SCENARIO_LABELS[value.scenario]) ?? value.scenario}
          {/* 回显任务说明（第 26 批，评审 U2-23）：确认卡要能用来核对“我要做的事”；最多两行，悬停看全文 */}
          {value.goal.trim() && (
            <div className="sheet-goal" title={value.goal.trim()}>
              {value.goal.trim()}
            </div>
          )}
        </dd>
        {(value.documentIds.length > 0 || agent) && (
          <>
            <dt>材料</dt>
            <dd>{materialsLine(value.documentIds.length, cur.docNames)}</dd>
          </>
        )}
        {agent && (
          <>
            {/* 第 27 批（评审 U3-03）：与输入框的做法胶囊同名，不再把“标准（推荐）”与“先给我看计划”叠在一起 */}
            <dt>做法</dt>
            <dd>
              {modeSheetText({ mode: value.choice.mode, planFirst: value.choice.mode !== "chat" && value.choice.planFirst })}
              {value.choice.mode === "auto" && value.choice.preauth.length > 0 ? `（事先同意：${value.choice.preauth.map((p) => PREAUTH_LABELS[p] ?? p).join("；")}）` : ""}
            </dd>
            {/* 第 66 批：用哪个模型（云端目录里的显示名；没选时写“缺省”） */}
            <dt>模型</dt>
            <dd>{modelName ?? "缺省模型"}</dd>
          </>
        )}
        <dt>预计用量</dt>
        <dd>
          {estimate.points_display}
          {/* V16 A5：用量说明缩成一行，原话收进“了解更多” */}
          {estimate.assumptions.length > 0 && (
            <div className="muted sheet-note">
              {usageNoteShort(estimate.assumptions).line}
              {usageNoteShort(estimate.assumptions).more.length > 0 && (
                <details className="sheet-more">
                  <summary>了解更多</summary>
                  {usageNoteShort(estimate.assumptions).more.map((m) => (
                    <div key={m}>{m}</div>
                  ))}
                </details>
              )}
            </div>
          )}
        </dd>
      </dl>
      {/* 发送说明（v9.4 认知减负）：默认只列三四句要点，完整口径收进“完整说明”；与开始面板共用（第 27 批，评审 U3-01） */}
      {/* 授权待记录时，这一块只剩一句“不会发送：四项依据待确认”，与下面的记录表单重复（第 51 批走查）：先只显示记录表单，
          表单里“授权要覆盖 / 系统另外做到”已说明发什么、发给谁；记录后重新估价时这一块照常出现 */}
      {!consentBlocked && (
        <SendPoints dataWhere={estimate.data_where}>
          {estimate.data_where?.send_summary && (
            <SendSummary matterId={matter.matter_id} summary={estimate.data_where.send_summary} documentIds={value.documentIds} goal={value.goal} mustReview={suspectsBlocked} onReviewed={() => void reestimate()} />
          )}
        </SendPoints>
      )}
      {hint ? (
        <StartHintBanner hint={hint} onAction={onClose} />
      ) : blocked && !consentBlocked ? (
        <div className="banner banner-orange">
          {estimate.data_where?.warning ?? "现在不能开始这个任务。"}
          {busyRun && (
            <div className="banner-actions">
              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  onClose();
                  nav(`/run/${busyRun}/${matter.matter_id}`);
                }}
              >
                查看进行中的任务
              </button>
            </div>
          )}
        </div>
      ) : consentBlocked ? (
        <>
          <AuthorizationRecord
            matterTitle={matter.title}
            clientName={matter.client_name}
            value={record}
            onChange={(v) => {
              setTouched(true);
              setRecord(v);
            }}
            sensitive={need.sensitive}
            reconfirm={reconfirm}
            reconfirmWhy={reconfirmWhy}
            needsRef={needsRef}
            processors={matter.subprocessors ?? defaults?.subprocessors ?? null}
            dataFlows={matter.data_flows ?? defaults?.data_flows ?? null}
            team={matter.collab_scope === "team"}
            detail={detail}
            onDetail={setDetail}
            endpoint={matter.model_endpoint}
            basis={matter.basis}
          />
          <div className="authz-exits">
            <span>还没有取得授权？</span>
            <button type="button" className="btn-link" onClick={onClose}>
              先只用本机功能
            </button>
            <span aria-hidden="true">·</span>
            {/* 设计评分第一轮 T3：团队共享事项上置灰（与“谁能看到”同一种禁用样式），原因一句写在同一行，完整说法放悬停 */}
            {/* 置灰项与原因是一组：窄窗口换行时一起换，不把“（…）”孤零零留在下一行开头 */}
            <span className="authz-exit-local">
              <button type="button" className="btn-link" disabled={localOnlyBusy || !!localOnlyWhy} aria-busy={localOnlyBusy} aria-describedby={localOnlyWhy ? "local-only-why" : undefined} title={localOnlyWhy?.long} onClick={() => void markLocalOnly()}>
                <BusyLabel busy={localOnlyBusy} busyText="正在记录…">
                  记为客户要求不上云
                </BusyLabel>
              </button>
              {localOnlyWhy && (
                <span className="authz-exit-why" id="local-only-why" title={localOnlyWhy.long}>
                  （{localOnlyWhy.short}）
                </span>
              )}
            </span>
          </div>
        </>
      ) : (
        estimate.data_where?.warning && <div className="banner banner-orange">{estimate.data_where.warning}</div>
      )}
      {errHint && <StartHintBanner hint={errHint} onAction={onClose} />}
      {err && (
        <div className="banner banner-red">
          {err}
          {errBusyRun && (
            <div className="banner-actions">
              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  onClose();
                  nav(`/run/${errBusyRun}/${matter.matter_id}`);
                }}
              >
                查看进行中的任务
              </button>
            </div>
          )}
        </div>
      )}
      <div className="modal-actions modal-actions-sticky">
        <button className="btn-ghost" onClick={onClose}>返回修改</button>
        {blocked && !consentBlocked ? (
          <button className="btn-primary" disabled>
            确认发起
          </button>
        ) : consentBlocked ? (
          <button className="btn-primary" disabled={busy || !canRecord} aria-busy={busy} onClick={() => void recordConsentAndStart()}>
            <BusyLabel busy={busy} busyText="正在记录并开始…">
              {reconfirm ? "重新确认并开始" : "记录授权并开始"}
            </BusyLabel>
          </button>
        ) : (
          <button className="btn-primary" disabled={busy} aria-busy={busy} onClick={() => void start()}>
            <BusyLabel busy={busy} busyText="正在开始…">
              开始
            </BusyLabel>
          </button>
        )}
      </div>
    </Modal>
  );
}
