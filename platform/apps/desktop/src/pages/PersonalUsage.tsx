/**
 * 套餐与用量（第 66 批 V40 P0-5，对照 Kimi“设置 · 我的订阅”）：面向个人律师，只讲“我的套餐、我用了多少、什么时候重置、用在哪”。
 * 不出现“本所”“成员”“律所上限”这类企业概念（多人律所的管理视图在云端控制台）；不显示金额、不引入点数，比例全部来自云端
 * 按真实调用记录算出的值（/v1/quota：personal 块优先，旧云端回退到 own / firm）。
 * 版式：套餐头（名称、刷新规则、周期）→ 用量进度（本期已用 %、按模型分段的进度条、剩余、重置时间；5 小时窗口）→ 按模型 → 使用明细。
 */
import { useEffect, useState } from "react";
import { api, type QuotaStatus } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import { fmtCount, fmtPct, modelLabel, periodRange, recordChargeText } from "../lib/firm-usage.ts";
import { shortDay } from "../lib/quota-notice.ts";
import { burstView, personalView } from "../lib/personal-usage.ts";
export { personalView };
import { ListSkeleton, LoadError } from "../components/Loading.tsx";
import "../styles-usage.css";

/** 北京时间“M 月 D 日 HH:mm”。 */
function bjAt(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 8 * 3600_000);
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

type OwnModel = { alias: string; label?: string; share: number; requests: number };

const SEG_TONES = ["seg-a", "seg-b", "seg-c", "seg-d"] as const;

export function PersonalUsage() {
  const [q, setQ] = useState<QuotaStatus | null>(null);
  const [err, setErr] = useState("");
  const [all, setAll] = useState(false);
  // 更早的明细（第 66 批：/v1/quota/usage 翻页，内核 quota.usage_page）
  const [more, setMore] = useState<NonNullable<QuotaStatus["own_recent"]>>([]);
  const [nextBefore, setNextBefore] = useState<string | null | undefined>(undefined);
  const [paging, setPaging] = useState(false);
  const [pageErr, setPageErr] = useState("");
  const loadMore = async (before: string | null) => {
    setPaging(true);
    setPageErr("");
    try {
      const r = await api.quotaUsagePage({ ...(before ? { before } : {}), limit: 50 });
      // 翻页行只给比例（不给金额与单位）：按“占本人额度”的口径显示
      setMore((cur) => [...cur, ...r.rows.map((x) => ({ ...x, charge: x.charge_ratio > 0 ? 1 : 0, unit: "cny" as const, value_cny: null }))]);
      setNextBefore(r.next_before ?? null);
      setAll(true);
    } catch (e) {
      setPageErr((e as Error).message);
    } finally {
      setPaging(false);
    }
  };
  const load = () => {
    setErr("");
    api
      .quotaStatus()
      .then(setQ)
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);
  if (err) return <LoadError what="用量" message={err} onRetry={load} />;
  if (!q) return <ListSkeleton rows={3} label="正在载入用量" />;
  if (q.mode !== "control_plane" || !q.firm) return <div className="pu-empty">{q.edition === "trial" ? "试用版不统计用量。" : (q.note ?? "还没有连接 Kimi Work 服务，暂时看不到用量。")}</div>;

  const v = personalView(q);
  const plan = q.plan;
  const per = q.period?.kind === "week" ? "本周" : "本月";
  // 月度条只看月度：5 小时频率放缓不把整月染红（那一栏自己显示）
  const tone = v.paused === "allowance" || v.paused === "cap" || v.used >= 1 ? "full" : v.used >= 0.8 ? "high" : "ok";
  // 按模型：新云端给本人 own_models；旧云端单人工作室的 models 就是本人的
  const models: OwnModel[] = (q.own_models ?? q.models ?? []).filter((m) => m.share > 0).sort((a, b) => b.share - a.share);
  const name = (m: { alias: string; label?: string | null }) => m.label ?? modelLabel(m.alias);
  const burst = q.burst ?? null;
  const base = q.own_recent ?? [];
  // 翻页取到的从最早一条之后接上（去掉与前 20 条重复的）
  const seen = new Set(base.map((r) => `${r.at}|${r.tokens_in}|${r.tokens_out}`));
  const recent = [...base, ...more.filter((r) => !seen.has(`${r.at}|${r.tokens_in}|${r.tokens_out}`))];
  const shown = all ? recent : recent.slice(0, 8);
  const range = periodRange(q.period);
  const pausedLine =
    v.paused === "allowance" || (v.paused === null && v.used >= 1)
      ? `${per}额度已用完，新任务暂不能发起；${shortDay(q.period?.resets_at) ? `${shortDay(q.period?.resets_at)} 重置后恢复` : "下期重置后恢复"}。`
      : v.paused === "cap"
        ? `${per}用量已到设定的上限，新任务暂不能发起。`
        : v.paused === "burst"
          ? `最近 ${burst?.hours ?? 5} 小时用得太快，AI 处理暂时放缓${burst?.resets_at ? `，${bjAt(burst.resets_at)} 起恢复` : ""}。`
          : null;

  const resetAt = shortDay(q.period?.resets_at) ? bjAt(q.period?.resets_at) : "";
  // 第 67 批第二轮（独立评审 R1-4）：三项加起来就是 100%——已用 + 进行中预留 + 可用（v.available = 1 − 已用 − 预留）
  const remaining = v.available;
  // 套餐说明里的金额（“84 元额度（按价目计）”）不给律师看：只讲百分比，不出现金额与点数
  const planNote = (plan?.note ?? "").replace(/[，,]?\s*[\d.]+\s*元额度（按价目计）/g, "").replace(/^[，,]\s*/, "");
  const perks = [
    `${per}额度按真实用量计算`,
    ...((plan?.burst ?? (burst ? { hours: burst.hours, pct: burst.pct } : null)) ? [`任意 ${(plan?.burst ?? burst)!.hours} 小时至多用${per}额度的 ${(plan?.burst ?? burst)!.pct}%`] : []),
    ...(plan?.models && plan.models.length > 0 ? [`可用模型 ${plan.models.join("、")}`] : []),
  ];

  // 第 67 批（V41 工作线 C）：一个视觉焦点（本期已用 %）+ 一根条 + 一句状态；按模型并进图例；5 小时一行；明细不再套卡片。
  return (
    <div className="pu pu2" id="sec-usage">
      <header className="pu-head">
        <div className="pu-head-main">
          <div className="pu-plan-line">
            <span className="pu-plan-name">{plan?.label ?? "当前套餐"}</span>
            {range && <span className="pu-period">本期 {range}</span>}
          </div>
          {planNote && <div className="pu-plan-note">{planNote}</div>}
        </div>
        <span className="pu-contact" title="暂不支持在客户端里购买">需要更多额度：联系客户经理或客服</span>
      </header>

      <section className="pu-hero" aria-label="用量">
        {pausedLine && (
          <div className={`pu-status pu-status-${v.paused === "burst" ? "warn" : "stop"}`} role="alert">
            <i aria-hidden="true" />
            {pausedLine}
          </div>
        )}
        <div className="pu-hero-top">
          <div className="pu-big">
            <span className="pu-big-k">{per}已用</span>
            <span className={`pu-big-v tone-${tone}`}>{fmtPct(v.used)}</span>
          </div>
          <dl className="pu-facts">
            <div>
              <dt>可用</dt>
              <dd>{fmtPct(remaining)}</dd>
            </div>
            {v.inFlight > 0.005 && (
              <div title="进行中的任务先预留一部分额度，结束后按实际用量结算，多的退回">
                <dt>进行中预留</dt>
                <dd>{fmtPct(v.inFlight)}</dd>
              </div>
            )}
            {resetAt && (
              <div>
                <dt>重置</dt>
                <dd>{resetAt}</dd>
              </div>
            )}
          </dl>
        </div>
        {/* 按模型分段的进度条：每段 = 已用比例 × 该模型占比；进行中预留浅色段；其余为可用 */}
        <div className={`pu-meter tone-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, v.used) * 100)} aria-label={`${per}已用`}>
          {models.length > 0 ? (
            models.slice(0, 4).map((m, i) => <span key={m.alias} className={`pu-seg ${SEG_TONES[i]}`} style={{ width: `${Math.min(1, v.used) * m.share * 100}%` }} />)
          ) : (
            <span className="pu-seg seg-a" style={{ width: `${Math.min(1, v.used) * 100}%` }} />
          )}
          {v.inFlight > 0 && <span className="pu-seg seg-flight" style={{ width: `${Math.min(1 - Math.min(1, v.used), v.inFlight) * 100}%` }} title="进行中的任务预留，结束后按实际用量结算" />}
        </div>
        <div className="pu-legend2" aria-hidden="true">
          <span><i className="pu-dot seg-a" />已用 {fmtPct(v.used)}</span>
          {v.inFlight > 0.005 && <span title="进行中的任务先预留一部分额度，结束后按实际用量结算，多的退回"><i className="pu-dot seg-flight" />进行中预留 {fmtPct(v.inFlight)}</span>}
          <span><i className="pu-dot seg-free" />可用 {fmtPct(remaining)}</span>
        </div>
        {/* 第 67 批第三轮（独立评审 R2）：只有一个模型时不再画与“已用”同色的图例点，写一行灰字 */}
        {models.length === 1 && (
          <p className="pu-models-one" aria-label="按模型">
            按模型：{name(models[0]!)} {fmtPct(models[0]!.share)} · {fmtCount(models[0]!.requests)} 次
          </p>
        )}
        {models.length > 1 && (
          <ul className="pu-models2" aria-label="按模型">
            {models.slice(0, 4).map((m, i) => (
              <li key={m.alias}>
                <i className={`pu-dot ${SEG_TONES[i]}`} aria-hidden="true" />
                <span className="pu-m-name">{name(m)}</span>
                <span className="pu-m-share">{fmtPct(m.share)}</span>
                <span className="pu-m-n">{fmtCount(m.requests)} 次</span>
              </li>
            ))}
          </ul>
        )}
        {burst && (() => {
          // 5 小时一行只用窗口自己的分母：窗口上限 = 本期额度的 pct%
          const w = burstView(burst, v);
          const wt = w.used >= 1 ? "full" : w.used >= 0.8 ? "high" : "ok";
          return (
            <div className="pu-burst2">
              <div className="pu-burst2-k">
                <span>{burst.hours} 小时用量</span>
                <span className="pu-burst2-sub" title={`窗口上限为${per}额度的 ${burst.pct}%`}>上限为{per}额度的 {burst.pct}%</span>
              </div>
              <div className={`pu-meter pu-meter-sm tone-${wt}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, w.used) * 100)} aria-label={`${burst.hours} 小时用量`}>
                <span className="pu-seg seg-a" style={{ width: `${Math.min(1, w.used) * 100}%` }} />
                {w.inFlight > 0 && <span className="pu-seg seg-flight" style={{ width: `${w.inFlight * 100}%` }} />}
              </div>
              <div className="pu-burst2-v">
                <span className={`tone-${wt}`}>已用 {fmtPct(w.used)}{w.inFlight > 0.005 ? ` · 预留 ${fmtPct(w.inFlight)}` : ""} · 还可用 {fmtPct(w.available)}</span>
                <span className="muted">{burst.resets_at ? `${bjAt(burst.resets_at)} 重置` : "滚动计算"}</span>
              </div>
            </div>
          );
        })()}
        <ul className="pu-perks2" aria-label="套餐权益">
          {perks.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </section>

      <section className="pu-log" aria-label="使用明细">
        <div className="pu-log-h">
          <span className="pu-log-title">使用明细</span>
          <span className="pu-log-sub">已载入 {recent.length} 条 · 只记用量，不含提问与文书内容</span>
        </div>
        {recent.length === 0 ? (
          <p className="pu-none">{per}还没有 AI 调用。</p>
        ) : (
          <>
            <table className="pu-table2">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用在</th>
                  <th>模型</th>
                  <th className="num">计入额度</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td className="pu-t">{bjAt(r.at) || fmtTime(r.at)}</td>
                    <td>{r.kind === "qa" ? "问答" : "任务"}</td>
                    <td>{r.label ?? (r.alias ? modelLabel(r.alias) : "—")}</td>
                    <td className="num pu-charge" title={`处理量：读入 ${fmtCount(r.tokens_in)}（其中重复利用 ${fmtCount(r.tokens_cached)}）· 写出 ${fmtCount(r.tokens_out)}`}>{recordChargeText(r).replace("占本人额度 ", "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pu-more-row">
              {recent.length > 8 && (
                <button className="btn-link pu-more" onClick={() => setAll((x) => !x)}>
                  {all ? "收起" : `展开全部 ${recent.length} 条`}
                </button>
              )}
              {nextBefore !== null && (
                <button className="btn-link pu-more" disabled={paging} onClick={() => void loadMore(nextBefore ?? (recent.length > 0 ? recent[recent.length - 1]!.at : null))}>
                  {paging ? "正在载入…" : "载入更早的记录"}
                </button>
              )}
              {pageErr && <span className="pu-none">没有载入：{pageErr}</span>}
            </div>
          </>
        )}
        <p className="pu-foot">用量按 AI 服务实际返回的处理量计算；中途中断或没有取得用量的调用不计入。</p>
      </section>
    </div>
  );
}
