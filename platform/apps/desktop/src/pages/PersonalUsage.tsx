/**
 * 设置 · 套餐与用量（第 66 批 V40 P0-5 起；第 68 批系统性重构，对照 Kimi 会员与 Kimi Code 的用量页：一个大百分比 + 一根条 + 重置时间，
 * 另起一行短周期频率限制；克制、留白）。只讲当前登录的这个人：我用了多少、还剩多少、哪天重置、用在哪。
 * 不展示本所、团队或其他成员的用量；团队用量与上限在云端控制台（管理员在页底看到一句提示）。
 * 数据：控制面 /v1/quota 的 personal 块与 /v1/quota/usage 翻页（逐请求账本），口径见 lib/personal-usage.ts；不显示金额，不引入点数。
 *
 * 版式（自上而下三块）：
 *   用量卡  本月用量 · 统计周期 · 套餐名 → 一句状态（仅在停用、放缓、将用完时）→ 大数字“已用” → 进度条（带“今天”刻度）→ 剩余与重置
 *           → 5 小时频率限制一行（仅单席位：窗口就是本人的）
 *   明细    标题 + 本期调用次数与模型构成 → 按日分组的表（时间 · 用在 · 模型 · 计入额度）→ 显示更多
 *   套餐    当前套餐、可用模型、更多额度（与其他设置页同一种设置行）
 */
import { useEffect, useMemo, useState } from "react";
import { api, type QuotaStatus } from "../api.ts";
import { fmtCount, fmtPct, modelLabel, periodRange } from "../lib/firm-usage.ts";
import { bjClock, bjDayTime, burstView, dayGroups, limitedNote, ownModels, periodElapsed, personalView, planNoteText, resetCountdown, rowCharge, rowScale, usageStatus, usageTone, type UsageRow } from "../lib/personal-usage.ts";
export { personalView };
import { ListSkeleton, LoadError } from "../components/Loading.tsx";
import { SettingRow } from "../components/SettingRow.tsx";
import "../styles-usage.css";

/** 首屏显示几条明细；“显示更多”每次再放出多少条。 */
const FIRST = 10;
const STEP = 20;
const MIX_TONES = ["mix-a", "mix-b", "mix-c", "mix-d"] as const;

const pctParts = (r: number) => {
  const s = fmtPct(r);
  return s.endsWith("%") ? s.slice(0, -1) : s;
};

export function PersonalUsage({ admin = false }: { admin?: boolean }) {
  const [q, setQ] = useState<QuotaStatus | null>(null);
  const [err, setErr] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  // 更早的明细（/v1/quota/usage 翻页，内核 quota.usage_page）：nextBefore undefined = 还没翻过，null = 没有更早的了
  const [older, setOlder] = useState<UsageRow[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null | undefined>(undefined);
  const [paging, setPaging] = useState(false);
  const [pageErr, setPageErr] = useState("");
  const [visible, setVisible] = useState(FIRST);
  const load = () => {
    setErr("");
    api
      .quotaStatus()
      .then((r) => {
        setQ(r);
        setNowMs(Date.now());
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  const rows = useMemo<UsageRow[]>(() => {
    const base: UsageRow[] = q?.own_recent ?? [];
    const seen = new Set(base.map((r) => `${r.at}|${r.tokens_in}|${r.tokens_out}`));
    return [...base, ...older.filter((r) => !seen.has(`${r.at}|${r.tokens_in}|${r.tokens_out}`))];
  }, [q, older]);

  if (err) return <LoadError what="用量" message={err} onRetry={load} />;
  if (!q) return <ListSkeleton rows={3} label="正在载入用量" />;
  if (q.mode !== "control_plane" || !q.firm)
    return (
      <div className="pu" id="sec-usage">
        <div className="pu-empty">
          <b>暂时看不到用量</b>
          <span>{q.edition === "trial" ? "试用版不统计用量。" : (q.note ?? "还没有连接 Kimi Work 服务。登录后，这里显示你本期的用量与重置时间。")}</span>
        </div>
      </div>
    );

  const v = personalView(q);
  const per = q.period?.kind === "week" ? "本周" : "本月";
  const tone = usageTone(v);
  const range = periodRange(q.period);
  const resetAt = bjDayTime(q.period?.resets_at);
  const countdown = resetCountdown(q.period?.resets_at, nowMs);
  const elapsed = periodElapsed(q.period, nowMs);
  const burst = q.burst ?? null;
  const status = usageStatus(q, v, resetAt, bjClock(burst?.resets_at));
  const note = limitedNote(v);
  const blocked = Math.max(0, v.available - v.left);
  const usedW = Math.min(1, v.used);
  const flightW = Math.min(1 - usedW, v.inFlight);
  const models = ownModels(q, v);
  const calls = models.reduce((n, m) => n + m.requests, 0);
  const scale = rowScale(q);
  const ledger = q.own_recent !== undefined;
  const shown = rows.slice(0, visible);
  const groups = dayGroups(shown, nowMs);
  const canFetch = ledger && nextBefore !== null;
  const plan = q.plan;
  const planNote = planNoteText(plan?.note);

  const more = async () => {
    if (rows.length > visible) {
      setVisible((n) => n + STEP);
      return;
    }
    setPaging(true);
    setPageErr("");
    try {
      const before = nextBefore ?? (rows.length > 0 ? rows[rows.length - 1]!.at : null);
      const r = await api.quotaUsagePage({ ...(before ? { before } : {}), limit: 50 });
      setOlder((cur) => [...cur, ...r.rows]);
      setNextBefore(r.next_before ?? null);
      setVisible((n) => n + STEP);
    } catch (e) {
      setPageErr((e as Error).message);
    } finally {
      setPaging(false);
    }
  };

  return (
    <div className="pu" id="sec-usage">
      <section className={`pu-card tone-${tone}`} aria-labelledby="pu-card-h">
        <header className="pu-card-head">
          <h2 className="pu-eyebrow" id="pu-card-h">
            {per}用量
          </h2>
          {range && <span className="pu-range">{range}</span>}
          {plan?.label && (
            <span className="pu-plan-chip" title="当前套餐">
              {plan.label}
            </span>
          )}
        </header>

        {status && (
          <p className={`pu-status pu-status-${status.tone}`} role={status.tone === "stop" ? "alert" : "status"}>
            <i aria-hidden="true" />
            {status.text}
          </p>
        )}

        <div className="pu-figure">
          <span className="pu-num">
            {pctParts(v.used)}
            <span className="pu-num-unit">%</span>
          </span>
          <span className="pu-num-k">已用</span>
        </div>

        <div className="pu-gauge">
          <div className="pu-track" role="meter" aria-label={`${per}已用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedW * 100)} aria-valuetext={`已用 ${fmtPct(v.used)}，剩余 ${fmtPct(v.left)}`}>
            <span className="pu-fill" style={{ width: `${usedW * 100}%` }} />
            {flightW > 0 && <span className="pu-flight" style={{ width: `${(usedW + flightW) * 100}%` }} title="进行中的任务先预留一部分，结束后按实际用量结算，多的退回" />}
            {blocked > 0.005 && <span className="pu-blocked" style={{ width: `${blocked * 100}%` }} title={note ?? "暂不可用"} />}
          </div>
          {elapsed !== null && elapsed > 0.02 && elapsed < 0.98 && (
            <span className="pu-today" style={{ left: `${elapsed * 100}%` }} title={`${per}时间已过 ${fmtPct(elapsed)}`} aria-hidden="true">
              <em>今天</em>
            </span>
          )}
        </div>

        <div className="pu-gauge-foot">
          <span className="pu-left">
            剩余 <b>{fmtPct(v.left)}</b>
            {v.inFlight > 0.005 && <span className="pu-aside">进行中预留 {fmtPct(v.inFlight)}</span>}
            {note && <span className="pu-aside">{note}</span>}
          </span>
          {resetAt && (
            <span className="pu-reset">
              {resetAt} 重置{countdown && <span className="pu-countdown">{countdown}</span>}
            </span>
          )}
        </div>

        {/* 5 小时频率限制：窗口是全所共用的，单席位时就是本人的才显示；多人律所被窗口卡住时只在上面的状态句里说 */}
        {burst && v.solo && (() => {
          const w = burstView(burst, v);
          const wt = w.used >= 1 || v.paused === "burst" ? "full" : w.used >= 0.8 ? "high" : "ok";
          return (
            <div className={`pu-window tone-${wt}`}>
              <div className="pu-window-k">
                <span>{burst.hours} 小时频率限制</span>
                <span className="pu-window-sub">
                  任意 {burst.hours} 小时至多用{per}额度的 {burst.pct}%
                </span>
              </div>
              <div className="pu-track pu-track-sm" role="meter" aria-label={`最近 ${burst.hours} 小时用量`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, w.used) * 100)}>
                <span className="pu-fill" style={{ width: `${Math.min(1, w.used) * 100}%` }} />
                {w.inFlight > 0 && <span className="pu-flight" style={{ width: `${Math.min(1, Math.min(1, w.used) + w.inFlight) * 100}%` }} />}
              </div>
              <div className="pu-window-v">
                <b>{fmtPct(w.used)}</b>
                <span>{burst.resets_at ? `${bjClock(burst.resets_at)} 起逐步恢复` : w.used > 0 ? "滚动计算" : `最近 ${burst.hours} 小时未用`}</span>
              </div>
            </div>
          );
        })()}
      </section>

      <section className="pu-log" aria-labelledby="pu-log-h">
        <div className="pu-sec-head">
          <h2 className="pu-h" id="pu-log-h">
            使用明细
          </h2>
          {calls > 0 && (
            <span className="pu-sec-sub">
              {per} {fmtCount(calls)} 次 AI 调用{models.length === 1 ? `，全部用 ${models[0]!.label}` : ""}
            </span>
          )}
        </div>

        {models.length > 1 && (
          <div className="pu-mix" aria-label={`${per}按模型`}>
            <div className="pu-mix-bar" aria-hidden="true">
              {models.slice(0, 4).map((m, i) => (
                <span key={m.alias} className={MIX_TONES[i]} style={{ flexGrow: m.share }} />
              ))}
            </div>
            <ul className="pu-mix-legend">
              {models.slice(0, 4).map((m, i) => (
                <li key={m.alias}>
                  <i className={MIX_TONES[i]} aria-hidden="true" />
                  <span className="pu-mix-name">{m.label}</span>
                  <span className="pu-mix-v">{fmtPct(m.share)}</span>
                  <span className="pu-mix-n">{fmtCount(m.requests)} 次</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!ledger ? (
          <p className="pu-quiet">当前服务版本还不提供使用明细。</p>
        ) : rows.length === 0 ? (
          <p className="pu-quiet">{per}还没有 AI 调用。</p>
        ) : (
          <table className="pu-table">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">用在</th>
                <th scope="col">模型</th>
                <th scope="col" className="num">
                  计入额度
                </th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key}>
                <tr className="pu-day">
                  <th colSpan={4} scope="rowgroup">
                    {g.label}
                    {g.earlier && <span className="pu-day-tag">上期</span>}
                  </th>
                </tr>
                {g.rows.map((r, i) => {
                  const c = rowCharge(r, scale);
                  return (
                    <tr key={`${r.at}-${i}`} className={c.counted ? "" : "is-free"}>
                      <td className="pu-t">{bjClock(r.at) || "—"}</td>
                      <td>{r.kind === "qa" ? "问答" : "任务"}</td>
                      <td>{r.label ?? (r.alias ? modelLabel(r.alias) : "—")}</td>
                      <td className="num pu-charge" title={`读入 ${fmtCount(r.tokens_in)}（其中重复利用 ${fmtCount(r.tokens_cached)}）· 写出 ${fmtCount(r.tokens_out)}`}>
                        {c.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        )}

        {ledger && (rows.length > visible || canFetch || pageErr) && (
          <div className="pu-more-row">
            {(rows.length > visible || canFetch) && (
              <button className="btn-ghost btn-sm" disabled={paging} onClick={() => void more()}>
                {paging ? "正在载入…" : rows.length === 0 ? "查看更早的记录" : "显示更多"}
              </button>
            )}
            {pageErr && <span className="pu-quiet">没有载入：{pageErr}</span>}
          </div>
        )}
        {ledger && nextBefore === null && rows.length <= visible && <p className="pu-quiet">{rows.length === 0 ? "近 180 天没有更早的记录。" : "以上是近 180 天的全部记录。"}</p>}
        <p className="pu-fine">只记用量，不含提问与文书内容。按 AI 服务实际返回的处理量计入；中途中断或没取得用量的调用不计入。</p>
      </section>

      <section className="pu-plan" aria-labelledby="pu-plan-h">
        <h2 className="pu-h" id="pu-plan-h">
          套餐
        </h2>
        <SettingRow label="当前套餐">
          <span>
            <b>{plan?.label ?? "—"}</b>
            {planNote && <span className="pu-plan-note">{planNote}</span>}
          </span>
        </SettingRow>
        {plan?.models && plan.models.length > 0 && <SettingRow label="可用模型">{plan.models.join("、")}</SettingRow>}
        <SettingRow label="需要更多额度">请联系客户经理或客服。</SettingRow>
        {admin && <SettingRow label="团队用量与上限">请在云端控制台管理（按成员用量、律所上限、个人额度）。</SettingRow>}
      </section>
    </div>
  );
}
