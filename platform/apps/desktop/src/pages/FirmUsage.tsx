/**
 * 用量与上限（第 9 批 S3；第 40 批改百分比；第 44 批 v2：一把尺子、按 Kimi 的额度呈现）、中软侧操作记录（第 9 批 S14）。
 * 用量：大号百分比 + 进度条 + 剩余 + 统计周期与重置时间；有 5 小时频率窗口时第二条进度；超过 80% 换提醒样式。
 * “我的用量”写明分母来源（个人上限 / 套餐每人额度）；按模型分布。管理员与合伙人另看用量数、按成员明细；上限只有管理员设备能改。
 * 单位只有 tokens 与元（中软给的单位名原样显示），不出现点数一类的说法。
 * 操作记录：中软云端对本所做过的每个写操作（谁、何时、做了什么、结果）；本机验过控制面签名与哈希链后留存，云端改写已给出的历史即告警。
 * 律师层文案门禁只查到 CpAuditPanel 之前（用量面板律师也看得到）。
 */
import { useEffect, useState } from "react";
import { api, type CpAuditRow, type QuotaStatus } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import { atLabel, recordChargeText, auditActionLabel, auditActorLabel, auditDetailLabel, auditFetchErrorText, auditResultLabel, auditTargetLabel, fmtAmount, fmtCount, fmtPct, legacyNote, modelLabel, ownDenominatorText, pausedText, periodLabel, periodRange, ratioTone, remainingLine, resetLabel, usageTone, warnText } from "../lib/firm-usage.ts";

/** 月度上限的常用档位（本期总额度的百分比）。 */
const CAP_PRESETS = [60, 70, 80, 90] as const;

/** 用量条：已用（实心）+ 在途（浅色）+ 上限刻度。 */
function UsageBar(props: { ratio: number; inFlight?: number; capPct?: number | null; tone: "ok" | "high" | "full"; label: string; size?: "lg" | "sm" | "md" }) {
  const used = Math.min(1, Math.max(0, props.ratio));
  const flight = Math.min(1 - used, Math.max(0, props.inFlight ?? 0));
  return (
    <div className={`usage-meter ${props.size ?? "lg"}${props.tone === "full" ? " full" : props.tone === "high" ? " high" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={props.label}>
      <span style={{ width: `${used * 100}%` }} />
      {flight > 0 && <i className="usage-flight" style={{ left: `${used * 100}%`, width: `${flight * 100}%` }} />}
      {props.capPct ? <b className="usage-cap" style={{ left: `${Math.min(100, props.capPct)}%` }} title={`上限 ${props.capPct}%`} /> : null}
    </div>
  );
}

/** admin：管理员（可改上限、看按成员）；律师在“设置 · 套餐与用量”看到的是同一面板去掉管理部分（第 47 批从“账号与团队”移出）。 */
export function UsagePanel({ admin = false }: { admin?: boolean }) {
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
        setCapInput(r.firm?.cap_pct ? String(r.firm.cap_pct) : "");
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);
  const save = async (cap: number | null) => {
    setBusy(true);
    setMsg("");
    try {
      await api.quotaSetCap(cap);
      setMsg(cap === null ? "已取消上限：用到本期额度的 100% 才暂停" : `上限已设为本期额度的 ${cap}%（几分钟内生效，已发出的请求照常完成）`);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (err) return <div className="banner banner-red">{err}</div>;
  if (!q) return <p className="muted">读取中…</p>;
  if (q.mode !== "control_plane" || !q.firm) return <p className="muted">{q.note ?? "未连接 Kimi Work 服务：不统计本所用量。"}</p>;
  const f = q.firm;
  const tone = usageTone(f);
  const paused = pausedText(q);
  const warn = warnText(q);
  const legacy = legacyNote(q);
  const parsed = capInput.trim() === "" ? null : Number(capInput.replace(/[%％\s]/g, ""));
  const capValid = parsed === null || (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100);
  const history = [...(q.history ?? [])].slice(-11);
  const models = q.models ?? [];
  const own = q.own ?? null;
  const range = periodRange(q.period);
  return (
    <div className="device usage-panel">
      {msg && <div className="banner">{msg}</div>}
      {paused && (
        <div className="banner banner-red" role="alert">
          {paused}
        </div>
      )}
      {!paused && warn && (
        <div className="banner banner-orange" role="status">
          {warn}
        </div>
      )}
      <section className={`usage-card${tone !== "ok" ? ` tone-${tone}` : ""}`} aria-label="本所额度">
        <div className="usage-card-head">
          <span className="usage-card-title">本所额度{q.plan ? ` · ${q.plan.label}` : ""}</span>
          <span className="muted">
            {periodLabel(q.period)}
            {range ? `（${range}）` : ""}
          </span>
        </div>
        <div className="usage-big">
          <span className={`usage-hero-v tone-${tone}`}>{fmtPct(f.used_ratio)}</span>
          <span className="muted">已用</span>
          {f.used !== null && f.total !== null && (
            <span className="usage-big-sub">
              {fmtAmount(f.used, q.unit, q.unit_label)} / {fmtAmount(f.total, q.unit, q.unit_label)}
            </span>
          )}
        </div>
        <UsageBar ratio={f.used_ratio} inFlight={f.in_flight_ratio} capPct={f.cap_pct} tone={tone} label="本期用量占本期额度" />
        <div className="usage-foot">
          <span>{remainingLine(q)}</span>
          <span className="muted">{resetLabel(q.period?.resets_at)}</span>
        </div>
        <div className="muted usage-meta">
          {f.cap_pct ? `律所上限 ${f.cap_pct}%` : "未设律所上限"}
          {f.boost_pct ? ` · 本期加量 +${f.boost_pct}%` : ""}
          {f.in_flight_ratio > 0 ? ` · 进行中 ${fmtPct(f.in_flight_ratio)}（浅色部分）` : ""}
        </div>
        {legacy && <div className="muted usage-meta">{legacy}</div>}
        {q.burst && (
          <div className="usage-window">
            <div className="usage-foot">
              <span>{q.burst.hours} 小时频率限制</span>
              <span className={`num tone-${ratioTone(q.burst.used_ratio)}`}>{fmtPct(q.burst.used_ratio)}</span>
            </div>
            <UsageBar size="md" ratio={q.burst.used_ratio} tone={ratioTone(q.burst.used_ratio)} label={`最近 ${q.burst.hours} 小时用量占频率限制`} />
            <div className="muted usage-meta">
              任意 {q.burst.hours} 小时内最多用本期额度的 {q.burst.pct}%{q.burst.resets_at ? ` · ${atLabel(q.burst.resets_at)} 起逐步恢复` : ""}
            </div>
          </div>
        )}
      </section>

      <section className="usage-card" aria-label="我的用量">
        <div className="usage-card-head">
          <span className="usage-card-title">我的用量</span>
          {own && <span className="muted">分母：{ownDenominatorText(own)}</span>}
        </div>
        {own ? (
          <>
            <div className="usage-big">
              <span className={`usage-hero-s tone-${ratioTone(own.used_ratio)}`}>{fmtPct(own.used_ratio)}</span>
              <span className="usage-big-sub">
                {fmtAmount(own.used, q.unit, q.unit_label)} / {fmtAmount(own.total, q.unit, q.unit_label)}
              </span>
            </div>
            <UsageBar size="md" ratio={own.used_ratio} tone={own.enforced ? ratioTone(own.used_ratio) : "ok"} label="本人用量占分母" />
            <div className="muted usage-meta">
              {fmtCount(own.requests)} 次 AI 调用
              {q.unit === "tokens" && own.value_cny !== null && own.value_cny > 0 ? ` · 约合 ${fmtAmount(own.value_cny, "cny")}` : ""}
              {own.estimated_rows > 0 ? ` · 其中 ${own.estimated_rows} 次 AI 服务没给出用量、按已收到的内容估算` : ""}
              {own.enforced ? " · 用满即暂停你本人的 AI 处理" : " · 只用来看用量，不单独限制"}
            </div>
          </>
        ) : (
          <p className="muted">这台电脑还没有登录账号，看不到本人用量。</p>
        )}
      </section>

      {/* 使用明细（第 47 批，对照 Kimi“我的额度”下的最近使用明细）：本人本期最近 20 条，来自控制面账本（真实 usage），不含请求内容 */}
      {q.own_recent && (
        <>
          <div className="section-title">我的使用明细（最近 20 条）</div>
          {q.own_recent.length === 0 ? (
            <p className="muted">本期还没有你的 AI 调用。</p>
          ) : (
            <table className="data usage-records">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用在</th>
                  <th>模型</th>
                  <th className="num">输入（其中缓存）</th>
                  <th className="num">输出</th>
                  <th className="num">计入额度</th>
                </tr>
              </thead>
              <tbody>
                {q.own_recent.map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td title={fmtTime(r.at)}>{fmtTime(r.at)}</td>
                    <td>{r.kind === "qa" ? "问答" : "任务"}</td>
                    <td>{r.label ?? (r.alias ? modelLabel(r.alias) : "—")}</td>
                    <td className="num">
                      {fmtCount(r.tokens_in)}
                      {r.tokens_cached > 0 ? `（${fmtCount(r.tokens_cached)}）` : ""}
                    </td>
                    <td className="num">{fmtCount(r.tokens_out)}</td>
                    <td className="num">{recordChargeText(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <div className="section-title">按模型（{periodLabel(q.period)}）</div>
      {models.length === 0 ? (
        <p className="muted">本期还没有用量。发起第一个任务后，这里按模型显示用量占比。</p>
      ) : (
        <ul className="usage-models">
          {models.map((m) => (
            <li key={m.alias}>
              <span className="usage-model-name">{(m.label ?? modelLabel(m.alias))}</span>
              <UsageBar size="sm" ratio={m.share} tone="ok" label={`${(m.label ?? modelLabel(m.alias))}占本所用量`} />
              <span className="num">{fmtPct(m.share)}</span>
              <span className="muted num">
                {fmtAmount(m.used, q.unit, q.unit_label)} · {fmtCount(m.requests)} 次
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="lead-note">
        本期额度 = 人数 × 套餐每人额度 + 本期加量。浅色部分是正在进行、还没结算的任务；到上限会停，个别任务可能略超。
        {(q.unreconciled_leases ?? 0) > 0 ? ` 有 ${q.unreconciled_leases} 笔用量还在核算，不会多扣。` : ""}
      </p>

      {admin && (
        <>
          <div className="section-title">律所上限</div>
          <div className="cap-picker" role="group" aria-label="律所上限">
            <button className={`chip${!f.cap_pct ? " on" : ""}`} disabled={busy} onClick={() => void save(null)}>
              不设上限
            </button>
            {CAP_PRESETS.map((p) => (
              <button key={p} className={`chip${f.cap_pct === p ? " on" : ""}`} disabled={busy} onClick={() => void save(p)}>
                {p}%
              </button>
            ))}
            <span className="inline-form">
              <input aria-label="自定义上限（百分比）" inputMode="numeric" placeholder="自定义" value={capInput} onChange={(e) => setCapInput(e.target.value)} />
              <span className="muted">%</span>
              <button className="btn-ghost btn-sm" disabled={busy || !capValid || parsed === null || parsed === f.cap_pct} onClick={() => void save(parsed)}>
                保存
              </button>
            </span>
          </div>
          <div className="muted">{capValid ? "到上限即暂停本所的 AI 处理（本机功能照常）。只有管理员电脑可以修改；修改记入中软侧操作记录。" : "请填写 1–100 的整数。"}</div>
        </>
      )}

      {admin && q.by_member && (
        <>
          <div className="section-title">按成员（{periodLabel(q.period)}）</div>
          {q.by_member.length === 0 ? (
            <p className="muted">本期还没有用量。</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>成员</th>
                  <th>占本所额度</th>
                  <th className="num">用量</th>
                  <th className="num">调用次数</th>
                </tr>
              </thead>
              <tbody>
                {q.by_member.map((m, i) => (
                  <tr key={m.uid ?? `x${i}`}>
                    <td>{m.name ?? "未登记的成员"}</td>
                    <td>
                      <div className="member-usage">
                        <UsageBar size="sm" ratio={m.used_ratio_of_firm} tone="ok" label={`${m.name ?? "成员"}占本所额度`} />
                        <span className="num">{fmtPct(m.used_ratio_of_firm)}</span>
                      </div>
                    </td>
                    <td className="num">{fmtAmount(m.used, q.unit, q.unit_label)}</td>
                    <td className="num">{fmtCount(m.requests)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {(q.boosts ?? []).length > 0 && (
        <>
          <div className="section-title">本期加量</div>
          <ul className="plain-list">
            {q.boosts!.map((b) => (
              <li key={b.at}>
                {fmtTime(b.at)} · 本期额度 +{b.pct}%
              </li>
            ))}
          </ul>
        </>
      )}
      {history.length > 0 && (
        <>
          <div className="section-title">最近几期</div>
          <div className="usage-history" role="img" aria-label="最近几期用量占当期额度">
            {history.map((h) => (
              <div key={h.period} className="usage-history-col" title={`${periodLabel(h.period)}：${h.used_ratio === null ? "—" : fmtPct(h.used_ratio)}${h.legacy ? "（含旧计量口径）" : ""}`}>
                <div className="usage-history-track">
                  <span className={h.used_ratio !== null && h.used_ratio >= 1 ? "full" : ""} style={{ height: `${Math.min(100, (h.used_ratio ?? 0) * 100)}%` }} />
                </div>
                <div className="usage-history-v">{h.used_ratio === null ? "—" : fmtPct(h.used_ratio)}</div>
                <div className="muted">{/^\d{4}-\d{2}$/.test(h.period) ? `${Number(h.period.slice(5))} 月` : h.period.slice(5)}</div>
              </div>
            ))}
          </div>
          {history.some((h) => h.legacy) && <p className="muted">标“含旧计量口径”的几期按当时的计量折成比例，与现在的比例可以对比，但不是同一单位的数。</p>}
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
      <p className="lead-note">本所规则、成员、电脑的每一次改动（含中软运营人员的操作）：谁、何时、做了什么。记录不能被事后篡改，不含任何案件内容。</p>
      {fetchError && <div className={`banner ${fetchError.startsWith("cp_audit_") ? "banner-red" : "banner-gray"}`}>{auditFetchErrorText(fetchError)}</div>}
      {withheld && <div className="banner banner-red">中软那边的记录可能没给全，请联系中软核对。</div>}
      {msg && <div className="banner">{msg}</div>}
      <div className="inline-form">
        <button className="btn-ghost btn-sm" disabled={busy} onClick={load}>
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
