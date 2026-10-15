/**
 * 上传诊断包给中软支持（第 9 批 S13；Y2 §3.13“预览将上传的内容 → 确认后上传”）。
 * 先由内核生成与“导出诊断信息”同一份脱敏诊断包并完整展示；律师确认后上传的正是这一份（内核按摘要核对，不重新生成）。
 * 律所策略未开启或本机未配置支持服务时只说明原因（仍可导出文件）。
 */
import { useState } from "react";
import { api, type SupportPreview } from "../api.ts";
import { diagSectionLabels } from "../lib/firm-usage.ts";

export function SupportUpload() {
  const [preview, setPreview] = useState<SupportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState<{ ticket: string } | null>(null);
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
    }
  };
  const blocked = preview && (!preview.allowed ? "律所没有开启“上传诊断包给中软支持”（由律所管理员在律所策略里开启）。你仍可以导出文件，按所内要求发送。" : !preview.configured ? "这台电脑没有配置中软支持服务：请导出文件，按所内要求发送。" : null);
  return (
    <div className="support-upload">
      {!preview ? (
        <div className="banner-actions">
          <button className="btn btn-sm" disabled={busy} onClick={() => void open()}>
            {busy ? "正在生成…" : "上传给中软支持…"}
          </button>
        </div>
      ) : (
        <div className="panel">
          <div>
            将上传 <b>{Math.ceil(preview.summary.bytes / 1024)} KB</b>：{diagSectionLabels(preview.summary.sections).join("、")}。内容与“导出诊断信息”相同，下面是完整内容，确认后上传的就是这一份。
          </div>
          <details>
            <summary>查看将上传的完整内容</summary>
            <pre className="support-preview">{preview.preview}</pre>
          </details>
          {blocked ? (
            <div className="banner banner-gray">{blocked}</div>
          ) : (
            <div className="muted">上传后得到一个工单号，请转告支持人员；中软只保存 7 天，查看记录留痕。</div>
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
    </div>
  );
}
