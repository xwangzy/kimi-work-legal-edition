/**
 * 团队共享（第 11 批 S11）：团队事项经中软共享中继在成员电脑之间同步（端到端加密，中软没有事项密钥）。
 * 只说明状态与原因（律所未开启、许可失效、连不上），有待发出或等密钥的改动时如实写出条数；可手动“立即同步”。
 */
import { useEffect, useState } from "react";
import { api, type RelayStatus } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";

/** 错误代码 → 律师看得懂的说法（只取前缀判断，不显示代码本身以外的内容）。 */
export function relayErrorText(code: string | null | undefined): string | null {
  if (!code) return null;
  if (/timeout|connect|unreachable|gate_|http_5/.test(code)) return "暂时连不上中软中继，会自动重试";
  if (/tls_/.test(code)) return "与中软中继的加密连接核对未通过，已停止收发（请联系 IT）";
  if (/credential_|no_seat|seat_revoked|license/.test(code)) return "席位或许可暂时不可用，团队共享已暂停";
  if (code === "relay_not_allowed") return "中软中继按本所策略拒绝了请求（策略可能刚更改），稍后自动重试";
  if (code === "tenant_storage_full") return "本所在中软中继上的存储已满，请联系中软客服";
  if (/digest_mismatch|blob_mismatch|segment_digest/.test(code)) return "有一份同事的改动在中继上核对不通过，已跳过并会重试";
  if (code === "not_reader") return "有一份改动属于你已不在其中的事项，已跳过";
  if (code === "segment_too_large") return "有一批改动过大（超过 256 MiB 或材料过多），暂时无法经中继同步；请联系中软客服，或先经律所共享文件夹同步";
  return "有改动暂时没有同步成功，会自动重试";
}

export function TeamShare() {
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => void api.relayStatus().then(setSt).catch(() => setSt(null));
  useEffect(load, []);
  if (!st || st.blocked === "not_configured") return null;
  const syncNow = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.relaySync();
      setSt(r.status);
      const sent = r.push.uploaded;
      const got = r.pull.applied;
      setMsg(sent + got === 0 ? "已是最新" : `发出 ${sent} 条改动，收到并合入 ${got} 条同事的改动`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="device-row">
      <div className="device-k">团队共享</div>
      <div>
        {st.blocked === "not_allowed" && <span>本所未开启经中软中继的团队共享（由律所管理员在“管理”里开启）。团队事项仍可经律所指定的共享文件夹同步。</span>}
        {st.blocked === "exit_mode" && <span className="pill pill-red">许可失效或这台电脑已停用：团队共享已暂停</span>}
        {st.blocked === null && (
          <>
            <span>已开启：团队事项加密后经中软中继在成员电脑之间同步，中软没有事项密钥、看不到内容。</span>
            <div className="muted">
              上次同步 {st.last_ok_at ? fmtTime(st.last_ok_at) : "—"}
              {st.pending_upload ? ` · ${st.pending_upload} 条改动待发出` : ""}
              {st.held ? ` · ${st.held} 条同事的改动在等密钥（通常是成员资格还没送到）` : ""}
              {st.retrying ? ` · ${st.retrying} 条改动稍后重试` : ""}
            </div>
            {relayErrorText(st.last_error) && <div className="muted">{relayErrorText(st.last_error)}</div>}
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
