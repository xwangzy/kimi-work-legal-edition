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

  return (
    <div className="pu" id="sec-usage">
      <header className="pu-plan">
        <div className="pu-plan-main">
          <span className="pu-plan-badge">{plan?.label?.replace(/版$/, "") ?? "套餐"}</span>
          <div className="pu-plan-text">
            <div className="pu-plan-name">{plan?.label ?? "当前套餐"}</div>
            <div className="pu-plan-note">
              {plan?.note ?? `权益额度按${q.period?.kind === "week" ? "周" : "月"}刷新`}
              {range ? ` · 本期 ${range}` : ""}
            </div>
          </div>
        </div>
        <ul className="pu-perks" aria-label="套餐权益">
          <li>{per}额度按真实用量计算，用多少算多少</li>
          {(plan?.burst ?? (burst ? { hours: burst.hours, pct: burst.pct } : null)) && (
            <li>
              任意 {(plan?.burst ?? burst)!.hours} 小时内至多用{per}额度的 {(plan?.burst ?? burst)!.pct}%
            </li>
          )}
          {plan?.models && plan.models.length > 0 && <li>可用模型：{plan.models.join("、")}</li>}
        </ul>
        <p className="pu-upgrade">需要更多额度或升级套餐：联系你的客户经理或客服（暂不支持在客户端里购买）。</p>
      </header>

      {pausedLine && (
        <div className={`banner ${v.paused === "burst" ? "banner-orange" : "banner-red"}`} role="alert">
          {pausedLine}
        </div>
      )}

      <section className="pu-card" aria-label="用量进度">
        <div className="pu-card-h">用量进度</div>
        <div className="pu-row">
          <div className="pu-total">
            <span className="pu-total-k">{per}已用</span>
            <span className={`pu-total-v tone-${tone}`}>{fmtPct(v.used)}</span>
          </div>
          <span className="pu-reset">{shortDay(q.period?.resets_at) ? `${bjAt(q.period?.resets_at)} 重置` : ""}</span>
        </div>
        {/* 按模型分段的进度条（Kimi“总使用量”同款）：每段 = 已用比例 × 该模型占比 */}
        <div className={`pu-meter tone-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, v.used) * 100)} aria-label={`${per}已用`}>
          {models.length > 0 ? (
            models.slice(0, 4).map((m, i) => <span key={m.alias} className={`pu-seg ${SEG_TONES[i]}`} style={{ width: `${Math.min(1, v.used) * m.share * 100}%` }} />)
          ) : (
            <span className="pu-seg seg-a" style={{ width: `${Math.min(1, v.used) * 100}%` }} />
          )}
          {v.inFlight > 0 && <span className="pu-seg seg-flight" style={{ width: `${Math.min(1 - Math.min(1, v.used), v.inFlight) * 100}%` }} title="进行中的任务预留，结束后按实际用量结算" />}
        </div>
        <div className="pu-legend">
          {models.slice(0, 4).map((m, i) => (
            <span key={m.alias} className="pu-legend-item">
              <i className={`pu-dot ${SEG_TONES[i]}`} aria-hidden="true" />
              {name(m)}
            </span>
          ))}
          {v.inFlight > 0.005 && (
            <span className="pu-legend-item">
              <i className="pu-dot seg-flight" aria-hidden="true" />
              进行中预留 {fmtPct(v.inFlight)}
            </span>
          )}
          <span className="pu-left">
            <i className="pu-dot seg-free" aria-hidden="true" />
            可用 {fmtPct(v.available)}
          </span>
        </div>
        {burst && (() => {
          // 5 小时一栏只用窗口自己的分母：窗口上限 = 本期额度的 pct%
          const w = burstView(burst, v);
          const wt = w.used >= 1 ? "full" : w.used >= 0.8 ? "high" : "ok";
          return (
            <div className="pu-burst">
              <div className="pu-row">
                <span className="pu-burst-k">{burst.hours} 小时用量</span>
                <span className="pu-reset">{burst.resets_at ? `${bjAt(burst.resets_at)} 后重置` : ""}</span>
              </div>
              <div className="pu-row pu-burst-v">
                <span>已用 {fmtPct(w.used)}</span>
                <span className="muted">这 {burst.hours} 小时还可用 {fmtPct(w.available)} · 上限为{per}额度的 {burst.pct}%</span>
              </div>
              <div className={`pu-meter pu-meter-sm tone-${wt}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, w.used) * 100)} aria-label={`${burst.hours} 小时用量`}>
                <span className="pu-seg seg-a" style={{ width: `${Math.min(1, w.used) * 100}%` }} />
                {w.inFlight > 0 && <span className="pu-seg seg-flight" style={{ width: `${w.inFlight * 100}%` }} />}
              </div>
            </div>
          );
        })()}
      </section>

      {models.length > 0 && (
        <section className="pu-card" aria-label="按模型">
          <div className="pu-card-h">按模型</div>
          <ul className="pu-models">
            {models.map((m, i) => (
              <li key={m.alias}>
                <i className={`pu-dot ${SEG_TONES[Math.min(i, 3)]}`} aria-hidden="true" />
                <span className="pu-model-name">{name(m)}</span>
                <span className="pu-model-share">{fmtPct(m.share)}</span>
                <span className="pu-model-n muted">{fmtCount(m.requests)} 次</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="pu-card" aria-label="使用明细">
        <div className="pu-card-h">
          使用明细
          <span className="pu-card-sub">{per}共 {recent.length} 条已载入，不含提问与文书内容</span>
        </div>
        {recent.length === 0 ? (
          <p className="pu-none">{per}还没有 AI 调用。</p>
        ) : (
          <>
            <table className="data pu-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用在</th>
                  <th>模型</th>
                  <th className="num">处理量</th>
                  <th className="num">计入额度</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td>{fmtTime(r.at)}</td>
                    <td>{r.kind === "qa" ? "问答" : "任务"}</td>
                    <td>{r.label ?? (r.alias ? modelLabel(r.alias) : "—")}</td>
                    <td className="num" title={`输入 ${fmtCount(r.tokens_in)}（其中缓存 ${fmtCount(r.tokens_cached)}）· 输出 ${fmtCount(r.tokens_out)}`}>
                      {fmtCount(r.tokens_in + r.tokens_out)}
                    </td>
                    <td className="num">{recordChargeText(r).replace("占本人额度 ", "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pu-more-row">
              {recent.length > 8 && (
                <button className="btn-link pu-more" onClick={() => setAll((x) => !x)}>
                  {all ? "收起" : `展开 ${recent.length} 条`}
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
      </section>
      <p className="pu-foot">用量按 AI 服务实际返回的处理量计算；中途中断或没有取得用量的调用不计入。</p>
    </div>
  );
}
