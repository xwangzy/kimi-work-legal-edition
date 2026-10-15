/**
 * 上传诊断包给中软支持（第 9 批 S13；Y2 §3.13“预览将上传的内容 → 确认后上传”）。
 * 先由内核生成与“导出诊断信息”同一份脱敏诊断包并完整展示；律师确认后上传的正是这一份（内核按摘要核对，不重新生成）。
 * 律所策略未开启或本机未配置支持服务时只说明原因（仍可导出文件）；本机上传记录（含“结果不明”）列在下面（复核 S9B-02）。
 */
import { useEffect, useState } from "react";
import { api, type SupportPreview } from "../api.ts";
import { diagSectionLabels } from "../lib/firm-usage.ts";
import { fmtTime } from "../lib/labels.ts";

type UploadRow = Awaited<ReturnType<typeof api.diagnosticsUploads>>["uploads"][number];
const STATUS_TEXT: Readonly<Record<UploadRow["status"], string>> = { pending: "进行中", sent: "已上传", failed: "没有送出", unknown: "结果不明（中软可能已收到）" };

export function SupportUpload({ allowed, configured }: { allowed: boolean | null; configured: boolean | null }) {
  const [preview, setPreview] = useState<SupportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState<{ ticket: string } | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const loadUploads = () => void api.diagnosticsUploads().then((r) => setUploads(r.uploads)).catch(() => setUploads([]));
  useEffect(loadUploads, []);
  const open = async () => {
    setBusy(true);
    setMsg("");
    setDone(null);
    try {
      setPreview(await api.diagnosticsUploadPreview());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = async () => {
    if (!preview) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await api.diagnosticsUpload(preview.file_sha256);
      setDone({ ticket: r.ticket });
      setPreview(null);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      loadUploads();
    }
  };
  // 律所未开启 / 未配置：不必生成整份诊断包再说明（复核 S9B-15）
  const unavailable = allowed === false ? "律所没有开启这一项（由律所管理员在律所策略里开启）：请导出文件，按所内要求发送。" : configured === false ? "这台电脑没有配置中软支持服务：请导出文件，按所内要求发送。" : null;
  const blocked =
    preview && (!preview.allowed ? "律所没有开启“上传诊断包给中软支持”：你仍可以导出文件，按所内要求发送。" : !preview.configured ? "这台电脑没有配置中软支持服务：请导出文件，按所内要求发送。" : preview.too_large ? "诊断包超过 2 MB，无法上传：请导出文件，按所内要求发送。" : null);
  return (
    <div className="support-upload">
      {unavailable ? (
        <div className="muted">上传给中软支持：{unavailable}</div>
      ) : !preview ? (
        <div className="banner-actions">
          <button className="btn btn-sm" disabled={busy} onClick={() => void open()}>
            {busy ? "正在生成…" : "上传给中软支持…"}
          </button>
        </div>
      ) : (
        <div className="panel">
          <div>
            将上传 <b>{Math.ceil(preview.summary.bytes / 1024)} KB</b>：{diagSectionLabels(preview.summary.sections).join("、")}。内容与“导出诊断信息”相同，确认后上传的就是这一份；中软同时看得到这台电脑的网络地址。
          </div>
          <details>
            <summary>展开查看将上传的完整内容</summary>
            <pre className="support-preview">{preview.preview}</pre>
          </details>
          {blocked ? (
            <div className="banner banner-gray">{blocked}</div>
          ) : (
            <div className="muted">上传后得到一个工单号，请转告支持人员；中软只保存 7 天，中软内部记录每次查看。</div>
          )}
          <div className="banner-actions">
            {!blocked && (
              <button className="btn-primary btn-sm" disabled={busy} onClick={() => void upload()}>
                {busy ? "正在上传…" : "确认上传"}
              </button>
            )}{" "}
            <button className="btn btn-sm" disabled={busy} onClick={() => setPreview(null)}>
              取消
            </button>
          </div>
        </div>
      )}
      {done && (
        <div className="banner">
          已上传。工单号 <b className="mono">{done.ticket}</b>：请把它告诉支持人员；中软 7 天后自动删除。
        </div>
      )}
      {msg && <div className="muted">{msg}</div>}
      {uploads.length > 0 && (
        <details className="vis-more">
          <summary>这台电脑的上传记录（{uploads.length}）</summary>
          <table className="data">
            <tbody>
              {uploads.map((u) => (
                <tr key={u.upload_id}>
                  <td className="num">{fmtTime(u.created_at)}</td>
                  <td>{STATUS_TEXT[u.status]}</td>
                  <td className="mono">{u.ticket ?? "—"}</td>
                  <td className="num">{Math.ceil(u.bytes / 1024)} KB</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
