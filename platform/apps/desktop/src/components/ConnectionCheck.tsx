/**
 * 检测连接（第 52 批（第 50 批 IP 部署虚机演练后补）；设置 → 备份与安全）：给所内 IT 分清“证书问题”与“断网”。
 * 内核 connection.diagnose 经本机连接组件、按与平时完全相同的加密核对，对各云端服务各连一次（不带账号凭据、不发任何内容），
 * 回来每项的结果、地址与端口、耗时，以及一句结论。表格与结论的文字都由内核给出，这里只排版；可一键复制给 IT。
 * 第 56 批：呈现改成“遇到问题时”一节里的一行（说明 + 右侧按钮），结果在行下展开：一句结论（状态点）+ 逐项一行。
 */
import { useState } from "react";
import { api, type ConnectionDiagnosis } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import { connectionReport } from "../lib/connection-check.ts";

const TONE_DOT: Record<ConnectionDiagnosis["tone"], string> = { ok: "sdot sdot-ok", warn: "sdot sdot-warn", error: "sdot sdot-bad" };
const ROW_DOT: Record<string, string> = { ok: "sdot sdot-ok", not_configured: "sdot sdot-idle" };

/** 检测结果（逐项一行）：技术支持页的“运行状态”也用它。 */
export function ConnectionResult({ result }: { result: ConnectionDiagnosis }) {
  return (
    <div className="cc-result">
      <div className={`cc-conclusion${result.tone === "error" ? " is-error" : ""}`} role="status">
        <span className={TONE_DOT[result.tone]} aria-hidden="true" />
        {result.conclusion}
      </div>
      {result.rows.length > 0 && (
        <ul className="cc-rows" aria-label="逐项结果">
          {result.rows.map((r) => (
            <li key={r.upstream} title={[r.class, ...r.presented].join(" ")}>
              <span className={ROW_DOT[r.class] ?? "sdot sdot-bad"} aria-hidden="true" />
              <span className="cc-name">{r.name}</span>
              <span className={`cc-label${r.class !== "ok" && r.class !== "not_configured" ? " is-bad" : ""}`}>{r.label}</span>
              <span className="cc-addr mono">{r.host ? `${r.host}${r.port ? `:${r.port}` : ""}` : ""}</span>
              <span className="cc-ms mono">{r.class === "not_configured" ? "" : `${r.elapsed_ms} ms`}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="cc-at">检测时间 {fmtTime(result.checked_at)}</div>
    </div>
  );
}

export function ConnectionCheck() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectionDiagnosis | null>(null);
  const [msg, setMsg] = useState("");
  const run = async () => {
    setBusy(true);
    setMsg("");
    try {
      setResult(await api.connectionDiagnose());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="help-row" aria-labelledby="sec-conn">
      <div className="help-row-main">
        <div className="help-row-text">
          <div className="help-row-title" id="sec-conn">检测连接</div>
          <p className="help-row-desc">连不上 AI 或登录不了时，先检测一次：逐项连一下云端服务，分清是网络问题还是加密核对没通过。不发送任何事项内容。</p>
        </div>
        <div className="help-row-actions">
          {result && (
            <button
              className="btn-link"
              onClick={() => void navigator.clipboard?.writeText(connectionReport(result)).then(() => setMsg("已复制，可以直接发给所内 IT。"), () => setMsg("复制没有成功，请截图这一段发给 IT。"))}
            >
              复制给 IT 的说明
            </button>
          )}
          <button className="btn-ghost btn-sm" disabled={busy} aria-busy={busy} onClick={() => void run()}>
            {busy ? "正在检测…" : result ? "重新检测" : "检测连接"}
          </button>
        </div>
      </div>
      {result && <ConnectionResult result={result} />}
      {msg && <div className="help-row-msg">{msg}</div>}
    </div>
  );
}
