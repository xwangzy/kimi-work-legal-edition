/**
 * 管理 → 用量与上限（第 9 批 S3）、中软侧操作记录（第 9 批 S14）。
 * 用量：本所本月已用、律所设的月度上限（到达即暂停 AI 处理）、按成员明细；上限只有管理员设备能改（内核与控制面各自核验）。
 * 操作记录：中软云端对本所做过的每个写操作（谁、何时、做了什么、结果）；本机验过控制面签名与哈希链后留存，云端改写已给出的历史即告警。
 */
import { useEffect, useState } from "react";
import { api, type CpAuditRow, type QuotaStatus } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import { auditActionLabel, auditActorLabel, auditDetailLabel, auditFetchErrorText, auditResultLabel, auditTargetLabel, capRatio, fmtPoints, periodLabel } from "../lib/firm-usage.ts";

export function UsagePanel() {
  const [q, setQ] = useState<QuotaStatus | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [capInput, setCapInput] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => {
    setErr("");
    api
      .quotaStatus()
      .then((r) => {
        setQ(r);
        setCapInput(r.cap_monthly === null || r.cap_monthly === undefined ? "" : String(r.cap_monthly));
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);
  const save = async (cap: number | null) => {
    setBusy(true);
    setMsg("");
    try {
      await api.quotaSetCap(cap);
      setMsg(cap === null ? "已取消月度上限" : `月度上限已设为 ${fmtPoints(cap)} 点（几分钟内生效，已发出的请求照常完成）`);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (err) return <div className="banner banner-red">{err}</div>;
  if (!q) return <p className="muted">读取中…</p>;
  if (q.mode !== "control_plane") return <p className="muted">{q.note ?? "未配置 Kimi Work 服务：不统计本所用量。"}</p>;
  const ratio = capRatio(q);
  const parsed = capInput.trim() === "" ? null : Number(capInput.replace(/[,，\s]/g, ""));
  const capValid = parsed === null || (Number.isSafeInteger(parsed) && parsed >= 0);
  return (
    <div className="device">
      {msg && <div className="banner">{msg}</div>}
      {ratio !== null && ratio >= 1 && <div className="banner banner-red">本所{periodLabel(q.period)}的用量已达上限：AI 处理暂停，直到调高上限或下月。</div>}
      {q.paused === "pool" && <div className="banner banner-red">本所购买的 AI 额度已用完：AI 处理暂停，请联系中软加量。</div>}
      <div className="panel">
        <div className="device-row">
          <div className="device-k">{periodLabel(q.period)}</div>
          <div>
            <div>
              已用 <strong>{fmtPoints(q.period_used)}</strong> 点
              {q.cap_monthly === null || q.cap_monthly === undefined ? "（未设上限）" : ` / 上限 ${fmtPoints(q.cap_monthly)} 点`}
            </div>
            {ratio !== null && (
              <div className={`usage-meter${ratio >= 1 ? " full" : ratio >= 0.8 ? " high" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} aria-label="本月用量占上限">
                <span style={{ width: `${Math.round(ratio * 100)}%` }} />
              </div>
            )}
            <div className="muted">中软网关已预领、尚未结算 {fmtPoints(q.in_flight)} 点（计入上限判断；网关正常关闭时立即释放，异常退出时最长约 35 分钟后释放——这期间用量条未满也可能暂时领不到额度）。用量按实际结算，到上限即停；单个请求的实际用量超过预估时，最多略超上限。</div>
          </div>
        </div>
        {q.pool_remaining !== undefined && (
          <div className="device-row">
            <div className="device-k">购买余额</div>
            <div>
              剩余 {fmtPoints(q.pool_remaining)} 点（累计购买 {fmtPoints(q.granted_total)} 点）
              {(q.unreconciled_leases ?? 0) > 0 && <div className="muted">有 {q.unreconciled_leases} 笔用量待中软对账（以网关计量记录为准，不会按预留整笔扣费）。</div>}
            </div>
          </div>
        )}
        <div className="device-row">
          <div className="device-k">月度上限</div>
          <div>
            <div className="inline-form">
              <input aria-label="月度上限（点）" inputMode="numeric" placeholder="不设上限" value={capInput} onChange={(e) => setCapInput(e.target.value)} />
              <button className="btn btn-sm" disabled={busy || !capValid} onClick={() => void save(parsed)}>
                保存
              </button>
              {q.cap_monthly !== null && q.cap_monthly !== undefined && (
                <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void save(null)}>
                  取消上限
                </button>
              )}
            </div>
            <div className="muted">{capValid ? "留空表示不设上限。只有管理员设备可以修改；修改记入中软侧操作记录。" : "请填写不小于 0 的整数点数。"}</div>
          </div>
        </div>
      </div>
      {q.by_member && (
        <>
          <div className="section-title">按成员（{periodLabel(q.period)}）</div>
          {q.by_member.length === 0 ? (
            <p className="muted">本月还没有用量。</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>成员</th>
                  <th className="num">点数</th>
                  <th className="num">请求次数</th>
                </tr>
              </thead>
              <tbody>
                {q.by_member.map((m, i) => (
                  <tr key={m.member_id ?? `x${i}`}>
                    <td>{m.name ?? m.member_id ?? "未知席位"}</td>
                    <td className="num">{fmtPoints(m.points)}</td>
                    <td className="num">{fmtPoints(m.requests)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {(q.history ?? []).length > 0 && (
        <>
          <div className="section-title">最近月份</div>
          <table className="data">
            <tbody>
              {[...q.history!].reverse().map((h) => (
                <tr key={h.period}>
                  <td>{periodLabel(h.period)}</td>
                  <td className="num">{fmtPoints(h.used)} 点</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export function CpAuditPanel() {
  const [rows, setRows] = useState<CpAuditRow[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [withheld, setWithheld] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => {
    setBusy(true);
    api
      .cpAudit({ limit: 200 })
      .then((r) => {
        setRows(r.records);
        setFetchError(r.fetch_error);
        setWithheld(!!r.fetched?.withheld);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);
  const exportAll = async () => {
    setMsg("");
    try {
      const r = await api.cpAuditExport();
      if (r) setMsg(`已导出 ${r.count} 条（${r.filename}）：原记录含哈希链，收件人可自行核验。`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (err) return <div className="banner banner-red">{err}</div>;
  return (
    <div className="device">
      <p className="muted">Kimi Work 服务上与本所有关的每个写操作（本所设备与中软运营）：谁、何时、做了什么、结果。本机核对过 Kimi Work 服务的签名与前后相接的哈希链才留存；中软之后改动或删除已给出的记录，本机会告警并保留原记录。记录里没有任何案件内容。</p>
      {fetchError && <div className={`banner ${fetchError.startsWith("cp_audit_") ? "banner-red" : "banner-gray"}`}>{auditFetchErrorText(fetchError)}</div>}
      {withheld && <div className="banner banner-red">中软侧的最高记录序号比给出的多：可能有记录未给出（已记告警）。请联系中软核对。</div>}
      {msg && <div className="banner">{msg}</div>}
      <div className="inline-form">
        <button className="btn btn-sm" disabled={busy} onClick={load}>
          {busy ? "正在取回…" : "取回最新"}
        </button>
        <button className="btn-ghost btn-sm" disabled={busy || !rows?.length} onClick={() => void exportAll()}>
          导出全部
        </button>
      </div>
      {rows === null ? (
        <p className="muted">读取中…</p>
      ) : rows.length === 0 ? (
        <p className="muted">本机还没有留存的记录。</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>时间</th>
              <th>执行者</th>
              <th>操作</th>
              <th>对象</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const res = auditResultLabel(r.result);
              return (
                <tr key={r.seq}>
                  <td className="num">{fmtTime(r.at)}</td>
                  <td>{auditActorLabel(r)}</td>
                  <td>
                    {auditActionLabel(r.action)}
                    {r.detail && <span className="muted">（{auditDetailLabel(r.detail)}）</span>}
                  </td>
                  <td>{auditTargetLabel(r)}</td>
                  <td>
                    <span className={`tag tag-${res.tone}`}>{res.text}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
