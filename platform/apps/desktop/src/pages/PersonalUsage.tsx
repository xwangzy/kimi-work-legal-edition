/**
 * 设置 · 套餐与用量（第 66 批 V40 起；第 68 批改成只讲本人；第 69 批 V43 重新设计）。
 * 律师打开这页想知道四件事：还能用多少、什么时候恢复、照这个节奏够不够、用在了哪。版式按这四问自上而下排，不展示本所、团队或其他成员的用量
 * （团队用量与上限在云端控制台，管理员在套餐块看到一句提示）。
 *
 *   概览   两道同心环（外：额度已用 + 进行中预留；内：本期时间已过）+ 三个读数：剩余 · 距重置 · 节奏（期末推算）→ 5 小时频率限制一行（仅单席位）
 *   每日   本期每天一根柱（同一分母），今天高亮、虚线 = 每天用多少恰好期末用完；悬停读当天
 *   用在哪 任务 / 问答（相加 = 已用）、按模型          套餐  当前套餐、可用模型、更多额度
 *   最近记录 按日分组（组头带当日合计），首屏 6 条，再往前从云端账本翻页
 *
 * 数据只来自云端真实计量：/v1/quota 的 personal（used / in_flight / remaining / daily / by_kind）、own_models、own_recent，以及 /v1/quota/usage 翻页；
 * 口径与旧云端回退见 lib/personal-usage.ts。旧云端没有 daily / by_kind 时对应的图整块不显示，不拿最近 20 条明细去拼。不显示金额，不引入点数。
 */
import { useEffect, useMemo, useState } from "react";
import { api, type QuotaStatus } from "../api.ts";
import { fmtCount, fmtLeft, fmtPct, modelLabel, periodRange } from "../lib/firm-usage.ts";
import { bjClock, bjDayTime, burstView, collapseFree, dailySeries, dayGroups, kindSplit, limitedNote, ownModels, paceView, personalView, planNoteText, resetIn, rowScale, usageStatus, usageTone, type UsageRow } from "../lib/personal-usage.ts";
export { personalView };
import { ListSkeleton, LoadError } from "../components/Loading.tsx";
import { DailyBars, UsageRing } from "../components/UsageCharts.tsx";
import { dayLabel } from "../lib/account.ts";
import "../styles-usage.css";

/** 最近记录首屏几条；“显示更多”每次再放出多少条。 */
const FIRST = 6;
const STEP = 20;

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
          <span className="pu-empty-ring" aria-hidden="true" />
          <div>
            <b>暂时看不到用量</b>
            <span>{q.edition === "trial" ? "试用版不统计用量。" : (q.note ?? "还没有连接 Kimi Work 服务。登录后，这里显示你本期的用量、每天用了多少与重置时间。")}</span>
            {/* 第四轮（独立评审 R3-3）：异常状态给出能做的事 */}
            {q.edition !== "trial" && (
              <span className="pu-empty-actions">
                <button type="button" className="btn-ghost btn-sm" onClick={load}>
                  重试
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => (window.location.hash = "#/connections/general")}>
                  检测连接
                </button>
              </span>
            )}
          </div>
        </div>
      </div>
    );

  const v = personalView(q);
  const per = q.period?.kind === "week" ? "本周" : "本月";
  const tone = usageTone(v);
  const range = periodRange(q.period);
  const resetAt = bjDayTime(q.period?.resets_at);
  const until = resetIn(q.period?.resets_at, nowMs);
  const burst = q.burst ?? null;
  const status = usageStatus(q, v, resetAt, bjClock(burst?.resets_at));
  const note = limitedNote(v);
  const pace = paceView(q, v, nowMs);
  const series = dailySeries(q, nowMs);
  const kinds = kindSplit(q);
  const models = ownModels(q, v);
  const calls = kinds ? kinds.task.requests + kinds.qa.requests : models.reduce((n, m) => n + m.requests, 0);
  const scale = rowScale(q);
  const ledger = q.own_recent !== undefined;
  // 先把相邻的“未计入”重试并成一行，再按条数截首屏，免得一串重试占满首屏
  const items = collapseFree(rows, scale);
  const groups = dayGroups(items.slice(0, visible), nowMs);
  const dayTotals = new Map((q.personal?.daily ?? []).map((d) => [d.day, d]));
  const canFetch = ledger && nextBefore !== null;
  const plan = q.plan;
  const planNote = planNoteText(plan?.note);
  const validUntil = plan?.valid_until ? dayLabel(plan.valid_until, nowMs) : "";
  const usedSum = kinds ? kinds.task.ratio + kinds.qa.ratio : 0;
  // 第五轮（独立评审 R4-1）：只用过一类、一个模型时不单独成卡（每日用量卡头已写明“任务调用 / 问答”），套餐卡占满一行横排
  const whereShown = (!!kinds && kinds.task.requests > 0 && kinds.qa.requests > 0) || models.length > 1;

  const more = async () => {
    if (items.length > visible) {
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
      {/* ── 概览：还能用多少、什么时候恢复、节奏够不够 ── */}
      <section className={`pu-hero tone-${tone}`} aria-labelledby="pu-hero-h">
        <header className="pu-head">
          <h2 className="pu-eyebrow" id="pu-hero-h">
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

        <div className="pu-hero-body">
          <UsageRing used={v.used} inFlight={v.inFlight} elapsed={pace?.elapsed ?? null} center={pctParts(v.used)} label={`${per}已用 ${fmtPct(v.used)}${pace ? `，${per}时间已过 ${fmtPct(pace.elapsed)}` : ""}`} />
          <dl className="pu-facts">
            <div className="pu-fact">
              <dt>剩余</dt>
              <dd className="pu-fact-v">{fmtLeft(v.left)}</dd>
              <dd className="pu-fact-sub">{v.inFlight > 0.005 ? `另有 ${fmtPct(v.inFlight)} 为进行中的任务预留` : (note ?? (v.left <= 0 && v.capped ? "新任务暂不能发起" : v.paused === "burst" ? "月度余量；眼下受频率限制放缓" : "可用于新任务与问答"))}</dd>
            </div>
            <div className="pu-fact">
              <dt>重置</dt>
              <dd className="pu-fact-v">
                {until ? (
                  <>
                    {until.n}
                    <small>{until.unit}</small>
                  </>
                ) : (
                  "—"
                )}
              </dd>
              <dd className="pu-fact-sub">{resetAt || "每期开始时重置"}</dd>
            </div>
            {pace && (
              <div className={`pu-fact pace-${pace.tone}`}>
                <dt>节奏</dt>
                <dd className="pu-fact-v">
                  <i className="pu-pace-dot" aria-hidden="true" />
                  {pace.label}
                </dd>
                <dd className="pu-fact-sub">{pace.text}</dd>
              </div>
            )}
          </dl>
          {pace && (
            <p className="pu-ring-cap" aria-hidden="true">
              <i className="sw-time" />
              刻度：{per}时间已过 {fmtPct(pace.elapsed)}
            </p>
          )}
        </div>

        {/* 5 小时频率限制：窗口是全所共用的，单席位时就是本人的才显示；多人律所被窗口卡住时只在上面的状态句里说 */}
        {/* 第五轮：本期额度已用完时 5 小时一行没有意义（新任务本来就发不起），不显示 */}
        {burst && v.solo && !(v.capped && v.left <= 0) && (() => {
          const w = burstView(burst, v);
          const wt = w.used >= 1 || v.paused === "burst" ? "full" : w.used >= 0.8 ? "high" : "ok";
          return (
            <div className={`pu-window tone-${wt}`}>
              <span className="pu-window-k">
                {burst.hours} 小时频率限制
                <em>任意 {burst.hours} 小时至多用{per}额度的 {burst.pct}%</em>
              </span>
              <div className="pu-track" role="meter" aria-label={`最近 ${burst.hours} 小时用量`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, w.used) * 100)}>
                <span className="pu-fill" style={{ width: `${Math.min(1, w.used) * 100}%` }} />
                {w.inFlight > 0 && <span className="pu-flight" style={{ width: `${Math.min(1, Math.min(1, w.used) + w.inFlight) * 100}%` }} />}
              </div>
              <span className="pu-window-v">
                {/* 第三轮（独立评审 R2-1）：这一项的百分比以“5 小时上限”为分母（不是月度额度），写明，免得与上面的数字混 */}
                <b>{fmtPct(w.used)}</b>
                <span className="pu-window-of">占上限</span>
                {burst.resets_at ? `${bjClock(burst.resets_at)} 起逐步恢复` : w.used > 0 ? "滚动计算" : `最近 ${burst.hours} 小时未用`}
              </span>
            </div>
          );
        })()}
      </section>

      {/* ── 每天用了多少（旧云端没有按日聚合时整块不显示） ── */}
      {series && (
        <section className={`pu-card pu-daily${series.active < 3 ? " sparse" : ""}`} aria-labelledby="pu-daily-h">
          <header className="pu-sec-head">
            <h2 className="pu-h" id="pu-daily-h">
              每日用量
            </h2>
          </header>
          <DailyBars
            bars={series.bars}
            even={series.even}
            top={series.top}
            evenNote={`虚线：每天用 ${fmtPct(series.even)}，${per === "本周" ? "周末" : "月底"}恰好用完${per}额度`}
            emptyNote={series.active > 0 ? null : `${per}还没有调用`}
          />
        </section>
      )}

      <div className={`pu-split${whereShown ? "" : " single"}`}>
        {/* ── 用在哪 ── 第四轮：旧云端没有用途拆分、又只用过一个模型时没有可说的，整卡不显示（不留一张空卡） */}
        {whereShown && (
        <section className="pu-card pu-where" aria-labelledby="pu-where-h">
          <header className="pu-sec-head">
            <h2 className="pu-h" id="pu-where-h">
              用在哪
            </h2>
            {calls > 0 && <span className="pu-sec-sub">{fmtCount(calls)} 次调用</span>}
          </header>
          {v.used <= 0 && calls === 0 ? (
            <p className="pu-quiet">{per}还没有用量。用过之后，这里按任务与问答、按模型分开列出各计入多少。</p>
          ) : (
            <>
              {/* 第四轮（独立评审 R3-2）：只用过一类时一句话说完（不画只有一段的条、不列“0 次 0%”的零值行） */}
              {kinds && usedSum > 0 && (kinds.task.requests === 0 || kinds.qa.requests === 0) && (
                <p className="pu-kind-one">
                  全部用在<b>{kinds.qa.requests === 0 ? "任务" : "问答"}</b>：{fmtCount(kinds.qa.requests === 0 ? kinds.task.requests : kinds.qa.requests)} 次调用，计入 <b>{fmtPct(usedSum)}</b>
                </p>
              )}
              {kinds && usedSum > 0 && kinds.task.requests > 0 && kinds.qa.requests > 0 && (
                <div className="pu-kind">
                  <div className="pu-kind-bar" aria-hidden="true">
                    {kinds.task.ratio > 0 && <span className="k-task" style={{ flexGrow: kinds.task.ratio / usedSum }} />}
                    {kinds.qa.ratio > 0 && <span className="k-qa" style={{ flexGrow: kinds.qa.ratio / usedSum }} />}
                  </div>
                  <ul className="pu-rows">
                    <li>
                      <i className="k-task" aria-hidden="true" />
                      <span className="pu-row-name">任务</span>
                      <span className="pu-row-n">{fmtCount(kinds.task.requests)} 次</span>
                      <b>{fmtPct(kinds.task.ratio)}</b>
                    </li>
                    <li>
                      <i className="k-qa" aria-hidden="true" />
                      <span className="pu-row-name">问答</span>
                      <span className="pu-row-n">{fmtCount(kinds.qa.requests)} 次</span>
                      <b>{fmtPct(kinds.qa.ratio)}</b>
                    </li>
                  </ul>
                </div>
              )}
              {/* 第三轮：只用过一个模型时“按模型”只是把总数再说一遍，不显示（可用模型在套餐卡里） */}
              {models.length > 1 && (
                <div className="pu-models">
                  <span className="pu-k">按模型{models.some((m) => m.ratio === null) ? "（占处理量）" : ""}</span>
                  <ul className="pu-rows">
                    {models.slice(0, 4).map((m) => {
                      const base = m.ratio ?? m.share;
                      const w = m.ratio !== null ? (v.used > 0 ? m.ratio / v.used : 0) : m.share;
                      return (
                        <li key={m.alias}>
                          <span className="pu-row-name">{m.label}</span>
                          <span className="pu-row-bar" aria-hidden="true">
                            <i style={{ width: `${Math.min(100, Math.max(2, w * 100))}%` }} />
                          </span>
                          <span className="pu-row-n">{fmtCount(m.requests)} 次</span>
                          <b>{fmtPct(base)}</b>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
        )}

        {/* ── 套餐 ── */}
        <section className="pu-card pu-plan" aria-labelledby="pu-plan-h">
          <header className="pu-sec-head">
            <h2 className="pu-h" id="pu-plan-h">
              套餐
            </h2>
          </header>
          <div className="pu-plan-name">
            <span className="pu-k pu-plan-k">当前套餐</span>
            <b>{plan?.label ?? "—"}</b>
            {/* 第三轮（独立评审 R2）：试用到期日——云端 plan.valid_until（律所订阅有效期；试用即试用结束），旧云端没有就不写 */}
            {validUntil && <span className="pu-plan-until">{plan?.id === "trial" ? "试用至" : "有效期至"} {validUntil}</span>}
            {/* 第六轮：试用已写“试用至 X 月 X 日”时，不再重复“自助注册试用 14 天……”这句说明 */}
            {planNote && !(validUntil && plan?.id === "trial") && <span>{planNote}</span>}
          </div>
          {plan?.models && plan.models.length > 0 && (
            <div className="pu-plan-models">
              <span className="pu-k">可用模型</span>
              <ul>
                {plan.models.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="pu-plan-more">
            <span className="pu-k">需要更多额度</span>
            <span>请联系客户经理或客服</span>
          </p>
          {/* 一人工作室的管理员就是本人：没有团队可管，不再提示 */}
          {admin && !v.solo && <p className="pu-plan-admin">团队用量与上限请在云端控制台管理（按成员用量、律所上限、个人额度）。</p>}
        </section>
      </div>

      {/* ── 最近记录 ── */}
      <section className="pu-log" aria-labelledby="pu-log-h">
        <header className="pu-sec-head">
          <h2 className="pu-h" id="pu-log-h">
            最近记录
          </h2>
          <span className="pu-sec-sub">只记用量，不含提问与文书内容</span>
        </header>

        {!ledger ? (
          <p className="pu-quiet">当前服务版本还不提供使用明细。</p>
        ) : rows.length === 0 ? (
          <p className="pu-quiet">{per}还没有 AI 调用。</p>
        ) : (
          <div className="pu-days">
            {groups.map((g) => {
              const tot = dayTotals.get(g.key);
              return (
                <div className="pu-day" key={g.key} role="group" aria-label={g.label}>
                  <div className="pu-day-head">
                    <span className="pu-day-name">
                      {g.label}
                      {g.earlier && <span className="pu-day-tag">上期</span>}
                    </span>
                    {tot && !g.earlier && (
                      <span className="pu-day-sum">
                        {fmtCount(tot.requests)} 次 · 计入 <b>{fmtPct(tot.ratio)}</b>
                      </span>
                    )}
                  </div>
                  <ul className="pu-day-rows">
                    {g.rows.map(({ row: r, n, charge: c }, i) => (
                      <li key={`${r.at}-${i}`} className={c.counted ? "" : "is-free"}>
                        <span className="pu-t">{bjClock(r.at) || "—"}</span>
                        <span className={`pu-kind-tag kind-${r.kind}`}>{r.kind === "qa" ? "问答" : "任务"}</span>
                        <span className="pu-model">
                          {r.label ?? (r.alias ? modelLabel(r.alias) : "—")}
                          {n > 1 && <span className="pu-runs">{c.counted ? `${n} 次调用` : `连续 ${n} 次（自动重试）`}</span>}
                        </span>
                        <span className="pu-charge" title={n > 1 ? (c.counted ? `同一分钟内 ${n} 次调用，合计计入` : `连续 ${n} 次，都没有计入额度`) : `读入 ${fmtCount(r.tokens_in)}（其中重复利用 ${fmtCount(r.tokens_cached)}）· 写出 ${fmtCount(r.tokens_out)}`}>
                          {c.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {ledger && (items.length > visible || canFetch || pageErr) && (
          <div className="pu-more-row">
            {(items.length > visible || canFetch) && (
              <button className="btn-ghost btn-sm" disabled={paging} onClick={() => void more()}>
                {paging ? "正在载入…" : rows.length === 0 ? "查看更早的记录" : "显示更多"}
              </button>
            )}
            {pageErr && <span className="pu-quiet">没有载入：{pageErr}</span>}
          </div>
        )}
        {ledger && nextBefore === null && items.length <= visible && <p className="pu-quiet">{rows.length === 0 ? "近 180 天没有更早的记录。" : "以上是近 180 天的全部记录。"}</p>}
        <p className="pu-fine">按 AI 服务实际返回的处理量计入；中途中断或没取得用量的调用不计入。除“5 小时频率限制”按该时段上限计，其余百分比都以你{per}的额度为分母。</p>
      </section>
    </div>
  );
}
