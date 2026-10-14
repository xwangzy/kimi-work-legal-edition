import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { nav } from "../App.tsx";

/** 复核/签发页（§5.4 签发页线框：完整性单 + 确切文件 + 退回/确认签发）。 */
export function ReviewPage({ artifactId }: { artifactId: string }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);

  const reload = useCallback(() => {
    api.completeness(artifactId).then(setData).catch((e) => setErr(e.message));
  }, [artifactId]);
  useEffect(reload, [reload]);

  const act = useCallback(
    async (decision: "approved" | "rejected") => {
      setBusy(true);
      setErr("");
      try {
        await api.approve(artifactId, {
          decision,
          expected_sha256: data.sha256,
          checklist: { reviewed_open_items: ack, at: new Date().toISOString() },
        });
        reload();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [artifactId, data, ack, reload],
  );

  return (
      <main className="main">
        <div className="main-narrow">
          <button className="btn-link back" onClick={() => nav("/deliverables")}>← 交付件</button>
          <h1 className="page-title">复核与签发：{data?.filename ?? "…"}</h1>
          {data && (
            <p className="muted mono">
              v{data.version} · 文件 hash {data.sha256.slice(0, 16)}… · {data.status}
            </p>
          )}
          {err && <div className="banner banner-red">{err}</div>}
          {data && (
            <>
              <div className="section-title">完整性单</div>
              <table className="data">
                <tbody>
                  <tr>
                    <th>材料覆盖</th>
                    <td>
                      {data.completeness.materials.note ??
                        `已读 ${data.completeness.materials.loaded}/${data.completeness.materials.requested}，失败 ${data.completeness.materials.failed}`}
                    </td>
                  </tr>
                  <tr>
                    <th>引用核验</th>
                    <td>
                      {data.completeness.citations.note ??
                        `共 ${data.completeness.citations.total} 条，拦截 ${data.completeness.citations.intercepted} 条` +
                          (Number(data.completeness.citations.unverified_offline) > 0 ? `，未核实（离线） ${data.completeness.citations.unverified_offline} 条` : "") +
                          `（as_of ${data.completeness.citations.as_of}）`}
                    </td>
                  </tr>
                  <tr>
                    <th>未决项</th>
                    <td>{data.completeness.open_items.length === 0 ? "无" : JSON.stringify(data.completeness.open_items)}</td>
                  </tr>
                  <tr>
                    <th>文件完整性</th>
                    <td>{data.completeness.file_integrity === "ok" ? "✓ 服务端复算一致" : "✗ 不一致"}</td>
                  </tr>
                  <tr>
                    <th>受众</th>
                    <td>{data.completeness.audience_check}</td>
                  </tr>
                  <tr>
                    <th>AI 标识</th>
                    <td>{data.completeness.ai_marking}</td>
                  </tr>
                  {data.completeness.egress && (
                    <tr>
                      <th>数据去向</th>
                      <td>{data.completeness.egress.note}</td>
                    </tr>
                  )}
                  <tr>
                    <th>版本</th>
                    <td>{data.is_latest_version ? "最新版" : "已有更新版本（本版不得签发）"}</td>
                  </tr>
                </tbody>
              </table>

              {data.blockers.length > 0 && (
                <div className="banner banner-orange">
                  签发前须确认：{data.blockers.join("；")}
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  我已实质复核全部内容与未决项（点击不等于复核，系统记录本确认）
                </label>
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
                <button className="btn-ghost" disabled={busy || data.status !== "pending_review"} onClick={() => void act("rejected")}>
                  退回
                </button>
                <button
                  className="btn-primary"
                  disabled={busy || data.status !== "pending_review" || !ack || !data.is_latest_version}
                  onClick={() => void act("approved")}
                >
                  确认签发
                </button>
                <span className="spacer" />
                <button
                  className="btn-ghost"
                  onClick={() => void api.downloadArtifact(data.artifact_version_id, data.filename).then(() => api.deliver({ artifact_version_id: data.artifact_version_id, action: "download" })).catch((e) => setErr(e.message))}
                >
                  下载（留痕）
                </button>
              </div>
              <p className="muted" style={{ marginTop: 12 }}>
                签发绑定当前文件 hash；批准后任何实质编辑生成新版本，旧批准不迁移。内部稿不得外发。
                签发以本机设备密钥签名并记入签名事件链；对外发送、导出与改权限只能由人在桌面界面操作（Agent 与远程渠道不能触发）。
              </p>
            </>
          )}
        </div>
      </main>
  );
}
