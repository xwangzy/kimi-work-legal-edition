/**
 * 发起前的预览（第 03 篇 §5 步骤 5：看到预计点数与数据去向预览；第 04 篇 §15.2 先预估、后确认）。
 * 预估与去向由内核按事项记录计算；律师确认后才发起。
 */
import { useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { MODE_LABELS, PREAUTH_LABELS } from "../lib/labels.ts";
import type { ComposerValue } from "./Composer.tsx";
import { SCENARIO_LABELS } from "../lib/labels.ts";
import { Modal } from "./Modal.tsx";
import { basisForConsent, ConsentQuestion, type ConsentAnswer } from "./Consent.tsx";
import type { MatterBasis, SendSummaryView } from "../api.ts";
import { SendSummary } from "./SendSummary.tsx";
import { notifyDataChanged } from "../lib/events.ts";
import { afterConsentNotice, busyRunOfError } from "../lib/start-block.ts";

export interface PendingStart {
  matter: Matter;
  value: ComposerValue;
  /** 业务场景卡指定的方法模板（Agent 任务）。 */
  skill?: string;
  /** 发起确认里“做什么”的显示名（业务场景名）。 */
  label?: string;
  estimate: {
    estimate_id: string;
    points: number;
    points_display: string;
    assumptions: string[];
    data_where?: { preview?: string; warning?: string | null; start_blocked?: boolean; block_kind?: "exit_mode" | "busy" | "consent" | "suspects" | null; busy_run_id?: string; send_summary?: SendSummaryView };
  };
}

/** 发起任务（确认卡与场景开始面板共用）：返回任务编号并跳到执行态。 */
export async function launchRun(p: PendingStart): Promise<string> {
  const agent = p.value.scenario === "a1.agent_task";
  const run = await api.startRun(p.matter.matter_id, {
    estimate_id: p.estimate.estimate_id,
    idempotency_key: `${p.matter.matter_id}-${p.value.scenario}-${Date.now()}`,
    ...(p.value.goal.trim() ? { goal: p.value.goal.trim() } : {}),
    ...(agent ? { mode: p.value.choice.mode, plan_first: p.value.choice.mode === "chat" ? false : p.value.choice.planFirst, preauthorizations: p.value.choice.mode === "auto" ? p.value.choice.preauth : [] } : {}),
    ...(agent && p.skill ? { skill: p.skill } : {}),
  });
  notifyDataChanged();
  nav(`/run/${run.run_id}/${p.matter.matter_id}`);
  return run.run_id;
}

/** 预估（失败抛出内核原因，例如场景须有材料）。 */
export async function prepareStart(matter: Matter, value: ComposerValue, o: { skill?: string; label?: string } = {}): Promise<PendingStart> {
  const extra: Record<string, unknown> = {};
  if (value.scenario === "s1b.draft_compare") {
    if (value.documentIds.length < 2) throw new Error("回稿比对需要选择两份文档：先选基线稿，再选回稿");
    extra.baseline_document_version_id = value.documentIds[0];
    extra.current_document_version_id = value.documentIds[1];
  }
  if (value.goal.trim()) extra.goal = value.goal.trim();
  const estimate = await api.estimate(matter.matter_id, { scenario: value.scenario, document_version_ids: value.documentIds, ...extra });
  return { matter, value, estimate: estimate as PendingStart["estimate"], ...(o.skill ? { skill: o.skill } : {}), ...(o.label ? { label: o.label } : {}) };
}

export function RunSheet({ pending, onClose }: { pending: PendingStart; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** 发起时被拒（并发发起，409 带进行中任务编号；复核 B4-B13）：错误提示旁给出入口。 */
  const [errBusyRun, setErrBusyRun] = useState<string | null>(null);
  const [cur, setCur] = useState(pending);
  const { matter, value, estimate } = cur;
  const agent = value.scenario === "a1.agent_task";
  const blocked = !!estimate.data_where?.start_blocked;
  // 只有“依据待确认”可以原地修复；事项里另有进行中的任务、或处于退出模式时只说明原因并禁用开始
  const consentBlocked = blocked && (estimate.data_where?.block_kind ?? "consent") === "consent";
  const busyRun = estimate.data_where?.block_kind === "busy" ? estimate.data_where.busy_run_id : undefined;
  // 敏感事项（L3a）：像姓名的文字核对完才能开始（v9.2 §3.3）；核对后重新估价
  const suspectsBlocked = blocked && estimate.data_where?.block_kind === "suspects";
  const reestimate = async () => {
    setErr("");
    try {
      setCur(await prepareStart(matter, value, { ...(cur.skill ? { skill: cur.skill } : {}), ...(cur.label ? { label: cur.label } : {}) }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  // 依据未齐时原地修复（UIUX 评审 P0-1）：在这里回答“客户是否同意”，记录后重新预估再发起
  const sensitive = matter.confidentiality === "high";
  const [consent, setConsent] = useState<ConsentAnswer>("consented");
  const [basis, setBasis] = useState<MatterBasis>(() => basisForConsent("consented", sensitive));
  const recordConsentAndStart = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.updateMatter(matter.matter_id, { basis });
      notifyDataChanged();
      const fresh = await prepareStart({ ...matter, basis }, value, { ...(cur.skill ? { skill: cur.skill } : {}), ...(cur.label ? { label: cur.label } : {}) });
      setCur(fresh);
      if (fresh.estimate.data_where?.start_blocked) {
        setErr(afterConsentNotice(fresh.estimate.data_where.block_kind, sensitive));
        return;
      }
      await doStart(fresh);
    } catch (e) {
      setErr((e as Error).message);
      setErrBusyRun(busyRunOfError(e));
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    setErr("");
    setErrBusyRun(null);
    try {
      await doStart(cur);
    } catch (e) {
      setErr((e as Error).message);
      setErrBusyRun(busyRunOfError(e));
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
        <dd>{cur.label ?? (agent ? "按你的描述处理" : SCENARIO_LABELS[value.scenario]) ?? value.scenario}{value.documentIds.length ? ` · 材料 ${value.documentIds.length} 份` : ""}</dd>
        {agent && (
          <>
            <dt>运行模式</dt>
            <dd>
              {MODE_LABELS[value.choice.mode]}
              {value.choice.mode !== "chat" && value.choice.planFirst ? " · 先给我看计划" : ""}
              {value.choice.mode === "auto" && value.choice.preauth.length > 0 ? `（预授权：${value.choice.preauth.map((p) => PREAUTH_LABELS[p] ?? p).join("；")}）` : ""}
            </dd>
          </>
        )}
        <dt>预计花费</dt>
        <dd>{estimate.points_display}</dd>
        <dt>内容会发给谁</dt>
        <dd>
          {estimate.data_where?.preview ?? "—"}
          {estimate.data_where?.send_summary && (
            <SendSummary matterId={matter.matter_id} summary={estimate.data_where.send_summary} documentIds={value.documentIds} goal={value.goal} mustReview={suspectsBlocked} onReviewed={() => void reestimate()} />
          )}
        </dd>
      </dl>
      {blocked && !consentBlocked ? (
        <div className="banner banner-orange">
          {estimate.data_where?.warning ?? "现在不能开始这个任务。"}
          {busyRun && (
            <div className="banner-actions">
              <button
                className="btn btn-sm"
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
        <div className="consent-fix">
          <p>这个任务需要用到 AI 模型。开始前请确认：</p>
          <ConsentQuestion answer={consent} onAnswer={setConsent} basis={basis} onBasis={setBasis} endpoint={matter.model_endpoint} sensitiveMatter={sensitive} allowRefuse={false} />
        </div>
      ) : (
        estimate.data_where?.warning && <div className="banner banner-orange">{estimate.data_where.warning}</div>
      )}
      {estimate.assumptions.length > 0 && (
        <ul className="sheet-notes">
          {estimate.assumptions.map((a, i) => <li key={i}>{a}</li>)}
        </ul>
      )}
      {err && (
        <div className="banner banner-red">
          {err}
          {errBusyRun && (
            <div className="banner-actions">
              <button
                className="btn btn-sm"
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
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>返回修改</button>
        {blocked && !consentBlocked ? (
          <button className="btn-primary" disabled>
            确认发起
          </button>
        ) : consentBlocked ? (
          <button className="btn-primary" disabled={busy || consent !== "consented"} onClick={() => void recordConsentAndStart()}>
            记录客户同意并开始
          </button>
        ) : (
          <button className="btn-primary" disabled={busy} onClick={() => void start()}>
            开始
          </button>
        )}
      </div>
    </Modal>
  );
}
