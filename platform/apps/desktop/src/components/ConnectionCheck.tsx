/**
 * 检测连接（第 52 批（第 50 批 IP 部署虚机演练后补）；设置 → 备份与安全）：给所内 IT 分清“证书问题”与“断网”。
 * 内核 connection.diagnose 经本机连接组件、按与平时完全相同的加密核对，对各云端服务各连一次（不带账号凭据、不发任何内容），
 * 回来每项的结果、地址与端口、耗时，以及一句结论。表格与结论的文字都由内核给出，这里只排版；可一键复制给 IT。
 */
import { useState } from "react";
import { api, type ConnectionDiagnosis } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import { connectionReport } from "../lib/connection-check.ts";

const TONE_BANNER: Record<ConnectionDiagnosis["tone"], string> = { ok: "banner banner-green", warn: "banner banner-orange", error: "banner banner-red" };
const PILL: Record<string, string> = { ok: "pill pill-green", not_configured: "pill pill-gray" };

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
    <section className="panel device-section" aria-labelledby="sec-conn">
      <h2 className="section-h h-section" id="sec-conn">检测连接</h2>
      <p>连不上 AI 或登录不了时，先在这里检测一次：逐项连一下云端服务，看是网络问题还是加密核对没通过。不发送任何事项内容。</p>
      <div className="banner-actions">
        <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void run()}>
          {busy ? "正在检测…" : result ? "重新检测" : "检测连接"}
        </button>
        {result && (
          <button
            className="btn-ghost btn-sm"
            onClick={() => void navigator.clipboard?.writeText(connectionReport(result)).then(() => setMsg("已复制，可以直接发给所内 IT。"), () => setMsg("复制没有成功，请截图这一段发给 IT。"))}
          >
            复制给 IT 的说明
          </button>
        )}
      </div>
      {result && (
        <>
          <div className={TONE_BANNER[result.tone]} role="status">
            {result.conclusion}
          </div>
          {result.rows.length > 0 && (
            <table className="data">
              <thead>
                <tr>
                  <th>服务</th>
                  <th>地址</th>
                  <th>结果</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.upstream}>
                    <td>{r.name}</td>
                    <td className="mono">{r.host ? `${r.host}${r.port ? `:${r.port}` : ""}` : "—"}</td>
                    <td>
                      <span className={PILL[r.class] ?? "pill pill-red"} title={[r.class, ...r.presented].join(" ")}>
                        {r.label}
                      </span>
                    </td>
                    <td className="mono">{r.class === "not_configured" ? "—" : `${r.elapsed_ms} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="muted">检测时间 {fmtTime(result.checked_at)}</div>
        </>
      )}
      {msg && <div className="muted">{msg}</div>}
    </section>
  );
}
