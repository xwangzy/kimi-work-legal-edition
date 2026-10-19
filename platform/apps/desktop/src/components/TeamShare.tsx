/**
 * 团队共享（第 11 批 S11；含复核 S11B-04 处置；Z3 评审 #7、5.5）：团队事项经中软共享中继在成员电脑之间同步（端到端加密，中软没有事项密钥）。
 * 律师层只有一行结论（正常 / 有几个事项暂停同步）和“立即同步”；发出与收取的明细、每条告警的长说明收进“详情”，只给管理员看。
 * “重新同步成员名单”（原“本机重新引导”）只给管理员与事项负责人，用原位两步确认（不再用浏览器原生确认框）。
 */
import { useEffect, useState } from "react";
import { api, type RelayStatus } from "../api.ts";
import { relayErrorText, syncAlertSummary, syncAlertText, syncOutcomeText, teamShareLine } from "../lib/relay-text.ts";
import { fmtTime } from "../lib/labels.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";

export function TeamShare({ admin = false }: { admin?: boolean }) {
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // 起点不同的事项：本人是否负责人（负责人也可以重新同步成员名单）
  const [owners, setOwners] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const load = () => void api.relayStatus().then(setSt).catch(() => setSt(null));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const alerts = st?.alerts ?? [];
  const rootIds = alerts.filter((a) => a.kind === "root_conflict").map((a) => a.matter_id).join(",");
  useEffect(() => {
    if (!rootIds) return;
    for (const id of rootIds.split(",")) {
      if (id in owners) continue;
      void api
        .getMatter(id)
        .then((r: any) => setOwners((o) => ({ ...o, [id]: r?.matter?.my_role === "owner" })))
        .catch(() => setOwners((o) => ({ ...o, [id]: false })));
    }
  }, [rootIds]);
  if (!st || (st.blocked === "not_configured" && alerts.length === 0)) return null;
  const syncNow = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.relaySync();
      setSt(r.status);
      setMsg(syncOutcomeText(r));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // 第 12 批：清除这台电脑上该事项的成员链，下次收到时按首次同步的规则重新确认负责人（内容与密钥不动）
  const rebootstrap = async (matterId: string) => {
    setBusy(true);
    setMsg("");
    try {
      setMsg((await api.matterSyncRebootstrap(matterId)).note);
      setSt(await api.relayStatus());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const counts = [
    st.pending_upload ? `${st.pending_upload} 条改动待发出` : "",
    st.stuck ? `${st.stuck_matters ?? 1} 个事项有改动发不出去` : "",
    st.waiting_key ? `${st.waiting_key} 条同事的改动在等负责人确认你的成员身份` : "",
    st.waiting_blob ? `${st.waiting_blob} 条同事的改动在等材料文件` : "",
    st.retrying || st.deferred ? `${(st.retrying ?? 0) + (st.deferred ?? 0)} 条稍后重试` : "",
  ].filter(Boolean);
  const pushErr = relayErrorText(st.push_last_error);
  const pullErr = relayErrorText(st.pull_last_error);
  const stuckErr = st.stuck ? relayErrorText(st.stuck_errors?.[0]) : null;
  return (
    <div className="device-row">
      <div className="device-k">团队共享</div>
      <div>
        <span>{teamShareLine(st)}</span>
        {alerts.map((a) => (
          <div key={`${a.matter_id}-${a.kind}-${a.epoch}`} className="sync-alert">
            {syncAlertSummary(a)}
            {a.kind === "root_conflict" && (admin || owners[a.matter_id]) && (
              <>
                {" "}
                <ConfirmButton
                  label="重新同步成员名单"
                  className="btn btn-sm"
                  danger={false}
                  disabled={busy}
                  question={`这台电脑会重新向负责人${a.peer_name ?? a.peer_member ? ` ${a.peer_name ?? a.peer_member} ` : ""}确认「${a.title ?? "这个事项"}」有哪些成员。期间这个事项暂停同步，内容不受影响。`}
                  confirmLabel="重新同步"
                  onConfirm={() => rebootstrap(a.matter_id)}
                />
              </>
            )}
            {admin && (
              <details className="muted">
                <summary>详情</summary>
                {syncAlertText(a)}
              </details>
            )}
          </div>
        ))}
        {st.blocked === null && (
          <>
            {" "}
            <button className="btn btn-sm" disabled={busy} onClick={() => void syncNow()}>
              {busy ? "正在同步…" : "立即同步"}
            </button>
            {msg && <span className="muted"> {msg}</span>}
            {admin && (
              <details className="muted">
                <summary>同步明细（管理员）</summary>
                <div>
                  上次发出 {st.push_last_ok_at ? fmtTime(st.push_last_ok_at) : "—"} · 上次收取 {st.pull_last_ok_at ? fmtTime(st.pull_last_ok_at) : "—"}
                  {counts.length > 0 ? ` · ${counts.join(" · ")}` : ""}
                </div>
                {stuckErr && <div>发不出去的原因：{stuckErr}（每 6 小时自动再试一次；点“立即同步”马上再试）</div>}
                {st.dropped_total ? <div>另有 {st.dropped_total} 条同事的改动无法在这台电脑上处理（多为这台电脑加入事项之前的内容），已略过。</div> : null}
                {pushErr && pushErr !== stuckErr && <div>发出：{pushErr}</div>}
                {pullErr && <div>收取：{pullErr}</div>}
                {st.chain_last_error && <div>成员记录自动处理没有完成（{st.chain_last_error.slice(0, 80)}），会在下次同步时再试</div>}
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
