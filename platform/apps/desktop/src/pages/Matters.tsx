/** 事项列表（第 03 篇 §4.1：个人/团队事项；事项头常显数据模式、密级、依据状态）。 */
import { useEffect, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { authorizationLine } from "../components/Consent.tsx";
import { basisComplete } from "../components/MatterHeader.tsx";
import { NewMatterDialog } from "../components/NewMatter.tsx";
import { ListSkeleton, LoadError } from "../components/Loading.tsx";
import { Icon } from "../components/Icons.tsx";
import "../styles-matter.css";
import { fmtRelative, fmtTime, LEVEL_LABELS, matterProgress } from "../lib/labels.ts";
import { stanceLabel } from "../lib/labels.ts";

export function MattersPage() {
  const [matters, setMatters] = useState<Matter[] | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  // 取数三态（第 51 批）：载入中给骨架、失败给重试，不把“没读到”显示成“没有事项”
  const load = () => {
    setErr("");
    api.listMatters().then((r) => setMatters(r.matters)).catch((e) => setErr(e.message));
  };
  useEffect(load, []);
  // 示例事项置顶（Y4 §5 D-6）
  const list = (matters ?? []).filter((m) => !q || [m.title, m.client_name, m.counterparty].some((x) => x?.includes(q))).sort((a, b) => Number(!!b.is_sample) - Number(!!a.is_sample));
  return (
    <main className="main">
      <div className="main-wide">
        <div className="page-head mt-head">
          <h1 className="page-title">
            事项
            {matters && matters.length > 0 && <span className="mt-count">{matters.length}</span>}
          </h1>
          <label className="dl-search mt-search">
            <span className="dl-search-icon" aria-hidden="true"><Icon.search /></span>
            <input type="search" aria-label="搜索事项" placeholder="搜索事项、客户、相对方" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <button className="btn-primary" onClick={() => setCreating(true)}>新建事项</button>
        </div>
        {err && !matters && <LoadError what="事项列表" message={err} onRetry={load} />}
        {err && matters && <div className="banner banner-red">{err}</div>}
        {matters && list.length === 0 && <p className="mt-empty muted">{q ? `没有找到“${q}”。` : "还没有事项。点右上角“新建事项”开始。"}</p>}
        {/* 第 55 批：表格改成列表行——事项名是主角（下面一行小字写客户与相对方），右侧依次是我方立场、进展、最近活动；
            进展只在有事时出现（等你确认的橙、进行中的蓝、待签发的灰）。密级、依据、协作等系统属性仍收在悬停说明里（v9.2 §4.4；Y4 M-1）。 */}
        {list.length > 0 && (
          <div className="mt-list" role="list" aria-label="事项">
            {list.map((m) => {
              const attrs = [
                `保护：${m.data_level ? (LEVEL_LABELS[m.data_level] ?? m.data_level) : "—"}`,
                `客户授权：${authorizationLine({ ...m, basis_complete: m.basis_complete ?? basisComplete(m.basis) })}`,
                `协作：${m.collab_scope === "team" ? "团队" : "个人"}`,
                `创建：${fmtTime(m.created_at)}`,
              ].join("\n");
              const prog = matterProgress(m.activity);
              const parties = [m.client_name ? `客户 ${m.client_name}` : "", m.counterparty ? `相对方 ${m.counterparty}` : ""].filter(Boolean).join(" · ");
              return (
                <button key={m.matter_id} role="listitem" className="mt-row" title={attrs} onClick={() => nav(`/matter/${m.matter_id}`)}>
                  <span className="mt-icon" aria-hidden="true"><Icon.folder /></span>
                  <span className="mt-main">
                    <span className="mt-title">
                      <span className="mt-name">{m.title}</span>
                      {m.is_sample && <span className="tag tag-trial">示例</span>}
                      {m.lifecycle === "closed" && <span className="tag tag-gray">已结案</span>}
                      {m.legal_hold && <span className="tag tag-warn">保全</span>}
                    </span>
                    <span className="mt-sub">{parties || "还没有填客户与相对方"}</span>
                  </span>
                  <span className="mt-stance">{stanceLabel(m.stance)}</span>
                  <span className="mt-prog">{prog.map((p) => <span key={p.text} className={`pill pill-${p.tone}`}>{p.text}</span>)}</span>
                  <span className="mt-when">{fmtRelative(m.activity?.last_at ?? m.created_at)}</span>
                  <span className="mt-go" aria-hidden="true"><Icon.right /></span>
                </button>
              );
            })}
          </div>
        )}
        {!matters && !err && <ListSkeleton rows={6} label="正在载入事项" />}
      </div>
      {creating && (
        <NewMatterDialog
          onClose={() => setCreating(false)}
          onCreated={(m) => {
            setCreating(false);
            nav(`/matter/${m.matter_id}`);
          }}
        />
      )}
    </main>
  );
}
