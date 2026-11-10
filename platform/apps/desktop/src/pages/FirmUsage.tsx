/**
 * 管理 → 用量与上限（第 9 批 S3；第 40 批取消点数、改百分比）、中软侧操作记录（第 9 批 S14）、Kimi 账号（第 40 批）。
 * 用量：本所本月已用占本月额度的百分比（与 Kimi 会员额度同一表达，下月 1 日重置）、律所设的月度上限（百分比，到达即暂停 AI 处理）、
 * 按成员明细（占个人份额、占全所、绑定的 Kimi 账号）；上限只有管理员设备能改（内核与控制面各自核验）。
 * 操作记录：中软云端对本所做过的每个写操作（谁、何时、做了什么、结果）；本机验过控制面签名与哈希链后留存，云端改写已给出的历史即告警。
 */
import { useEffect, useRef, useState } from "react";
import { api, type CpAuditRow, type KimiAccountStatus, type QuotaStatus } from "../api.ts";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { fmtTime } from "../lib/labels.ts";
import { auditActionLabel, auditActorLabel, auditDetailLabel, auditFetchErrorText, auditResultLabel, auditTargetLabel, fmtCount, fmtPct, kimiAccountLabel, periodLabel, resetLabel, usageTone } from "../lib/firm-usage.ts";

/** 月度上限的常用档位（本月总额度的百分比）。 */
const CAP_PRESETS = [60, 70, 80, 90] as const;

/** 用量条：已用（实心）+ 在途（浅色）+ 上限刻度。 */
function UsageBar(props: { ratio: number; inFlight?: number; capPct?: number | null; tone: "ok" | "high" | "full"; label: string; size?: "lg" | "sm" }) {
  const used = Math.min(1, Math.max(0, props.ratio));
  const flight = Math.min(1 - used, Math.max(0, props.inFlight ?? 0));
  return (
    <div className={`usage-meter${props.size === "sm" ? " sm" : " lg"}${props.tone === "full" ? " full" : props.tone === "high" ? " high" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={props.label}>
      <span style={{ width: `${used * 100}%` }} />
      {flight > 0 && <i className="usage-flight" style={{ left: `${used * 100}%`, width: `${flight * 100}%` }} />}
      {props.capPct ? <b className="usage-cap" style={{ left: `${Math.min(100, props.capPct)}%` }} title={`上限 ${props.capPct}%`} /> : null}
    </div>
  );
}

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
        setCapInput(r.cap_pct ? String(r.cap_pct) : "");
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);
  const save = async (cap: number | null) => {
    setBusy(true);
    setMsg("");
    try {
      await api.quotaSetCap(cap);
      setMsg(cap === null ? "已取消月度上限：用到本月额度的 100% 才暂停" : `月度上限已设为本月额度的 ${cap}%（几分钟内生效，已发出的请求照常完成）`);
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
  const tone = usageTone(q);
  const parsed = capInput.trim() === "" ? null : Number(capInput.replace(/[%％\s]/g, ""));
  const capValid = parsed === null || (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100);
  const history = [...(q.history ?? [])].slice(-11);
  return (
    <div className="device usage-panel">
      {msg && <div className="banner">{msg}</div>}
      {q.paused === "allowance" && <div className="banner banner-red">本所{periodLabel(q.period)}的 AI 额度已用完（100%）：AI 处理暂停，请联系中软加量，或等{resetLabel(q.resets_at)}。</div>}
      {q.paused === "cap" && <div className="banner banner-red">本所{periodLabel(q.period)}的用量已到律所设的上限（{q.cap_pct}%）：AI 处理暂停，直到调高上限或下月。</div>}
      <div className="usage-hero">
        <div className="usage-hero-main">
          <div className="usage-hero-k">{periodLabel(q.period)} · 本所已用</div>
          <div className={`usage-hero-v tone-${tone}`}>{fmtPct(q.used_ratio)}</div>
          <UsageBar ratio={q.used_ratio ?? 0} inFlight={q.in_flight_ratio ?? 0} capPct={q.cap_pct ?? null} tone={tone} label="本月用量占本月额度" />
          <div className="muted">
            {q.plan ? `${q.plan.label}套餐 · ${fmtCount(q.seats)} 个席位` : "套餐"}
            {q.boost_pct ? ` · 本月加量 +${q.boost_pct}%` : ""} · {resetLabel(q.resets_at)}
          </div>
        </div>
        <div className="usage-hero-side">
          <div>
            <div className="usage-hero-k">月度上限</div>
            <div className="usage-hero-s">{q.cap_pct ? `${q.cap_pct}%` : "不设"}</div>
          </div>
          <div>
            <div className="usage-hero-k">你本人</div>
            <div className="usage-hero-s">{q.own && q.own.requests > 0 ? fmtPct(q.own.used_ratio) : "0%"}</div>
            <div className="muted">个人份额</div>
          </div>
        </div>
      </div>
      <p className="lead-note">
        本月额度 = 人数 × 套餐额度 + 本月加量。个人份额只用来看谁用得多，不单独限额。
        浅色部分是正在进行、还没结算的任务。到上限会停，个别任务可能略超。
      </p>
      {(q.unreconciled_leases ?? 0) > 0 && <p className="muted">有 {q.unreconciled_leases} 笔用量还在核算，不会多扣。</p>}

      <div className="section-title">月度上限</div>
      <div className="cap-picker" role="group" aria-label="月度上限">
        <button className={`chip${!q.cap_pct ? " on" : ""}`} disabled={busy} onClick={() => void save(null)}>
          不设上限
        </button>
        {CAP_PRESETS.map((p) => (
          <button key={p} className={`chip${q.cap_pct === p ? " on" : ""}`} disabled={busy} onClick={() => void save(p)}>
            {p}%
          </button>
        ))}
        <span className="inline-form">
          <input aria-label="自定义上限（百分比）" inputMode="numeric" placeholder="自定义" value={capInput} onChange={(e) => setCapInput(e.target.value)} />
          <span className="muted">%</span>
          <button className="btn-ghost btn-sm" disabled={busy || !capValid || parsed === null || parsed === q.cap_pct} onClick={() => void save(parsed)}>
            保存
          </button>
        </span>
      </div>
      <div className="muted">{capValid ? "到上限即暂停本所的 AI 处理（本机功能照常）。只有管理员设备可以修改；修改记入中软侧操作记录。" : "请填写 1–100 的整数。"}</div>

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
                  <th>Kimi 账号</th>
                  <th>占个人份额</th>
                  <th className="num">占全所</th>
                  <th className="num">请求次数</th>
                </tr>
              </thead>
              <tbody>
                {q.by_member.map((m, i) => (
                  <tr key={m.member_id ?? `x${i}`}>
                    <td>{m.name ?? m.member_id ?? "未知席位"}</td>
                    <td className={m.kimi ? "" : "muted"}>{kimiAccountLabel(m.kimi)}</td>
                    <td>
                      <div className="member-usage">
                        <UsageBar size="sm" ratio={m.used_ratio} tone={m.used_ratio >= 1 ? "full" : m.used_ratio >= 0.8 ? "high" : "ok"} label={`${m.name ?? "成员"}占个人份额`} />
                        <span className="num">{fmtPct(m.used_ratio)}</span>
                      </div>
                    </td>
                    <td className="num">{fmtPct(m.firm_ratio)}</td>
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
          <div className="section-title">本月加量</div>
          <ul className="plain-list">
            {q.boosts!.map((b) => (
              <li key={b.at}>
                {fmtTime(b.at)} · 本月额度 +{b.pct}%
              </li>
            ))}
          </ul>
        </>
      )}
      {history.length > 0 && (
        <>
          <div className="section-title">最近月份</div>
          <div className="usage-history" role="img" aria-label="最近月份用量占当月额度">
            {history.map((h) => (
              <div key={h.period} className="usage-history-col" title={`${periodLabel(h.period)}：${h.used_ratio === null ? "旧版计量" : fmtPct(h.used_ratio)}${h.boost_pct ? `（加量 +${h.boost_pct}%）` : ""}`}>
                <div className="usage-history-track">
                  <span className={h.used_ratio !== null && h.used_ratio >= 1 ? "full" : ""} style={{ height: `${Math.min(100, (h.used_ratio ?? 0) * 100)}%` }} />
                </div>
                <div className="usage-history-v">{h.used_ratio === null ? "—" : fmtPct(h.used_ratio)}</div>
                <div className="muted">{Number(h.period.slice(5))} 月</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Kimi 账号（第 40 批）：本人用 Kimi 账号登录并绑定席位。授权走 Kimi 官方授权页，由 Kimi Work 服务代办：
 * 本机只显示验证码与授权页地址、轮询结果，不经手 Kimi 令牌。客户端按既定安全规则不替律师打开外部浏览器（主进程门禁），
 * 所以给出地址与“复制链接”，律师在自己的浏览器里打开。律所要求用 Kimi 账号登录时，没绑定前 AI 处理不可用。
 */
export function KimiAccountRow() {
  const [st, setSt] = useState<KimiAccountStatus | null>(null);
  const [flow, setFlow] = useState<{ flow_id: string; user_code: string; url: string; interval: number; expires: number } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  const load = () => {
    api.kimiStatus().then(setSt).catch((e) => setMsg((e as Error).message));
  };
  useEffect(() => {
    load();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);
  const poll = (f: NonNullable<typeof flow>, waitMs: number) => {
    timer.current = window.setTimeout(async () => {
      if (Date.now() > f.expires) {
        setFlow(null);
        setMsg("验证码已过期，请重新登录。");
        return;
      }
      try {
        const r = await api.kimiLoginPoll(f.flow_id);
        if (r.status === "bound") {
          setFlow(null);
          setMsg("已绑定 Kimi 账号。");
          load();
        } else if (r.status === "denied") {
          setFlow(null);
          setMsg("你在 Kimi 授权页上拒绝了授权。");
        } else if (r.status === "expired") {
          setFlow(null);
          setMsg("验证码已过期，请重新登录。");
        } else poll(f, (r.status === "slow_down" ? f.interval + 5 : f.interval) * 1000);
      } catch (e) {
        setFlow(null);
        setMsg((e as Error).message);
      }
    }, waitMs);
  };
  const start = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.kimiLoginStart();
      const f = { flow_id: r.flow_id, user_code: r.user_code, url: r.verification_uri_complete, interval: r.interval, expires: Date.parse(r.expires_at) || Date.now() + 600_000 };
      setFlow(f);
      poll(f, f.interval * 1000);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setFlow(null);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg("已复制链接：粘贴到浏览器地址栏打开。");
    } catch {
      setMsg("没能复制：请选中上面的地址手动复制。");
    }
  };
  const unbind = async () => {
    setBusy(true);
    try {
      await api.kimiUnbind();
      setMsg("已解绑。");
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!st) return <div className="muted">{msg || "读取中…"}</div>;
  if (st.mode !== "control_plane" || !st.enabled) return <div className="muted">本所的 Kimi Work 服务没有开通 Kimi 账号登录。</div>;
  return (
    <div className="kimi-account">
      {st.account ? (
        <div className="kimi-account-on">
          <span className="kimi-avatar" aria-hidden="true">
            {st.account.nickname.slice(0, 1)}
          </span>
          <div>
            <div>{kimiAccountLabel(st.account)}</div>
            <div className="muted">
              {st.account.level ? `${st.account.level} · ` : ""}
              {st.account.bound_at ? `${fmtTime(st.account.bound_at)} 绑定` : "已绑定"} · 本人的 AI 用量计入这个账号名下
            </div>
          </div>
          <ConfirmButton label="解绑" question="解除本人的 Kimi 账号绑定？本所要求用 Kimi 账号登录时，解绑后 AI 处理会暂停，直到重新登录。" disabled={busy} onConfirm={unbind} />
        </div>
      ) : flow ? (
        <div className="kimi-login-flow">
          <div>
            在浏览器里打开下面的 Kimi 授权页，登录后核对验证码 <code className="kimi-code">{flow.user_code}</code> 并确认授权
          </div>
          <div className="kimi-url">
            <span className="mono">{flow.url}</span>
            <button className="btn-ghost btn-sm" onClick={() => void copy(flow.url)}>
              复制链接
            </button>
          </div>
          <div className="muted">等待授权…（10 分钟内有效；授权后这里自动显示账号）</div>
          <button className="btn-ghost btn-sm" onClick={cancel}>
            取消
          </button>
        </div>
      ) : (
        <div className="inline-form">
          <button className="btn-ghost btn-sm kimi-login-btn" disabled={busy} onClick={() => void start()}>
            用 Kimi 账号登录
          </button>
          <span className="muted">{st.required ? "本所要求用 Kimi 账号登录：登录前 AI 处理不可用。" : "登录后，本人的 AI 用量按 Kimi 账号统计。"}</span>
        </div>
      )}
      {msg && <div className="muted">{msg}</div>}
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
