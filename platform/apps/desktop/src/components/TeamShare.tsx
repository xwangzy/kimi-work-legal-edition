/**
 * 团队共享（第 11 批 S11；含复核 S11B-04 处置）：团队事项经中软共享中继在成员电脑之间同步（端到端加密，中软没有事项密钥）。
 * 发出与收到分别显示；“待发出 / 卡住 / 等密钥 / 等材料 / 稍后重试”分开计数；失败原因用律师看得懂的说法；显示期间每 15 秒刷新；
 * “立即同步”有错误时如实说明，不说“已是最新”。
 */
import { useEffect, useState } from "react";
import { api, type RelayStatus } from "../api.ts";
import { relayErrorText, syncAlertText, syncOutcomeText } from "../lib/relay-text.ts";
import { fmtTime } from "../lib/labels.ts";

export function TeamShare() {
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const load = () => void api.relayStatus().then(setSt).catch(() => setSt(null));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const alerts = st?.alerts ?? [];
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
  const counts = [
    st.pending_upload ? `${st.pending_upload} 条改动待发出` : "",
    st.stuck ? `${st.stuck_matters ?? 1} 个事项有改动发不出去` : "",
    st.waiting_key ? `${st.waiting_key} 条同事的改动在等密钥（通常是成员资格还没送到）` : "",
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
        {alerts.map((a) => (
          <div key={`${a.matter_id}-${a.kind}-${a.epoch}`} className="sync-alert">
            {syncAlertText(a)}
          </div>
        ))}
        {st.blocked === "not_allowed" && st.policy_fallback && <span>这台电脑的律所策略已过期或尚未收到：经中软中继的团队共享暂停，联网更新律所策略后自动恢复。</span>}
        {st.blocked === "not_allowed" && !st.policy_fallback && <span>本所未开启经中软中继的团队共享（由律所管理员在“管理”里开启）。团队事项仍可经律所指定的共享文件夹同步。</span>}
        {st.blocked === "exit_mode" && <span className="pill pill-red">许可失效或这台电脑已停用：团队共享已暂停</span>}
        {st.blocked === null && (
          <>
            <span>已开启：团队事项加密后经中软中继在成员电脑之间同步，中软没有事项密钥、看不到内容。</span>
            <div className="muted">
              上次发出 {st.push_last_ok_at ? fmtTime(st.push_last_ok_at) : "—"} · 上次收取 {st.pull_last_ok_at ? fmtTime(st.pull_last_ok_at) : "—"}
              {counts.length > 0 ? ` · ${counts.join(" · ")}` : ""}
            </div>
            {stuckErr && <div className="muted">发不出去的原因：{stuckErr}（每 6 小时自动再试一次；点“立即同步”马上再试）</div>}
            {st.dropped_total ? <div className="muted">另有 {st.dropped_total} 条同事的改动无法在这台电脑上处理（多为这台电脑加入事项之前的内容），已略过。</div> : null}
            {pushErr && pushErr !== stuckErr && <div className="muted">发出：{pushErr}</div>}
            {pullErr && <div className="muted">收取：{pullErr}</div>}
            <button className="btn btn-sm" disabled={busy} onClick={() => void syncNow()}>
              {busy ? "正在同步…" : "立即同步"}
            </button>
            {msg && <span className="muted"> {msg}</span>}
          </>
        )}
      </div>
    </div>
  );
}
