/**
 * 第 73 批（V47，D-307～D-310，契约 02 §3）：团队共享事项的律师端零件。
 * - ScopeField：新建事项两处表单（完整弹窗、“放进哪个事项？”就地新建）里的“谁能看到：只有我 | 和同事一起办”与选同事；只在团队空间出现。
 * - TeamMark：侧栏、事项列表、输入框事项芯片上的灰色两人记号（带读屏文字，不靠悬停）。
 * - TeamPill：事项头“团队共享 · n 人”胶囊，展开列人，底部“事项成员 →”。
 * - MatterMembersPanel：事项“⋯ → 事项成员”页——负责人加同事、改角色、原位两步移出；非负责人只读。
 * - AddColleaguesDialog：加同事；个人事项“和同事一起办…”同一个弹窗（二次确认写明不可改回）。
 * 文字口径在 lib/team-matters.ts（纯函数，用例 b73-team-matters-ui）；同事电脑能否接收与第 72 批 shareReadyText 同源。
 * 安全约束不变：成员变更只能由负责人的电脑做（内核核验），管理员不代加。
 */
import { useEffect, useId, useRef, useState } from "react";
import { api, matterMembers, team, teamMatters, type Matter, type MatterMembersView, type MatterSync, type TeamRoster } from "../api.ts";
import { nav } from "../App.tsx";
import {
  addResultText,
  avatarOf,
  canManageMembers,
  effectiveKind,
  manageBlockedText,
  teamFaultText,
  colleagueMeta,
  filterColleagues,
  levelOfMatter,
  MATTER_ROLE_OPTIONS,
  matterRoleLabel,
  memberErrorText,
  memberName,
  memberCounts,
  memberRowNote,
  needsShareRefresh,
  ownerHint,
  PICKER_SEARCH_FROM,
  pickableColleagues,
  relayReady,
  relaySyncOf,
  removeQuestion,
  removeResult,
  rosterNote,
  SCOPE_OPTIONS,
  scopeAvailability,
  scopeHint,
  shareMatterLines,
  sortMembers,
  syncNotice,
  teamPillText,
  type CollabScope,
  type MatterMark,
  type ScopeAvailability,
} from "../lib/team-matters.ts";
import { notifyDataChanged } from "../lib/events.ts";
import { Icon } from "./Icons.tsx";
import { ListSkeleton, LoadError } from "./Loading.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";
import { useWorkspace, type WorkspaceState } from "./WorkspaceSwitch.tsx";
import { shareReadyText, type WorkspaceKind } from "../lib/workspace.ts";
import "../styles-team.css";
import "../styles-team-matters.css";

/* ── 数据：同事名单、同事之间同步（同一窗口内共用，60 秒内不重取） ── */

let rosterCache: { at: number; r: TeamRoster } | null = null;
let rosterInflight: Promise<TeamRoster> | null = null;
function fetchRoster(force: boolean): Promise<TeamRoster> {
  if (!force && rosterCache && Date.now() - rosterCache.at < 60_000) return Promise.resolve(rosterCache.r);
  if (rosterInflight) return rosterInflight;
  rosterInflight = teamMatters
    .roster()
    .then((r) => {
      // 调用没成功时不覆盖上一份能用的名单
      if (r.available || !rosterCache?.r.available) rosterCache = { at: Date.now(), r };
      return rosterCache?.r ?? r;
    })
    .finally(() => (rosterInflight = null));
  return rosterInflight;
}
/** 同事名单（team.roster）。enabled 为 false（个人空间、没展开）时不取。 */
export function useRoster(enabled: boolean): TeamRoster | null {
  const [r, setR] = useState<TeamRoster | null>(rosterCache?.r ?? null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetchRoster(false).then((x) => live && setR(x));
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? r : null;
}

/**
 * 工作空间类型（内核终版注意事项 ①）：kernel.status.workspace_kind 起初可能是 null（刚接受邀请切到的团队档案，约 2 分钟内补记）——
 * null 时取一次同事名单推断（lib/team-matters.ts effectiveKind），入口照常给、由内核最终判断并如实显示原因；知道类型时不多取。
 */
export function useTeamKind(): { ws: WorkspaceState; kind: WorkspaceKind | null } {
  const ws = useWorkspace();
  const probe = ws.ready && ws.kind === null;
  const roster = useRoster(probe);
  return { ws, kind: effectiveKind(ws.kind, probe ? roster : null) };
}

/** 同事之间同步的状态（relay.status → true 已开通 / false 没开通 / null 不知道；configured：中软是否已为本所开通服务）。 */
export function useRelayState(enabled: boolean): { ready: boolean | null; configured: boolean | null; sync: MatterSync; refresh: () => void } {
  const [st, setSt] = useState<{ ready: boolean | null; configured: boolean | null; sync: MatterSync; loaded?: boolean }>({ ready: null, configured: null, sync: "unknown" });
  const live = useRef(true);
  const read = () =>
    void api
      .relayStatus()
      .then((s) => live.current && setSt({ ready: relayReady(s), configured: s.blocked === "not_configured" ? false : true, sync: relaySyncOf(s), loaded: true }))
      .catch(() => undefined);
  useEffect(() => {
    live.current = true;
    if (enabled) read();
    return () => {
      live.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  // 第 73 批（实拍补）：“所内还没开通”那句可见时，让内核看一眼规则是否刚放开（每个表单至多一次，不轮询；内核另有 60 秒节流）；放开了就重读这一句
  const asked = useRef(false);
  const refresh = () => {
    // 还没读到状态时不问（读到之前 sync 记的是“不知道”）
    if (asked.current || !st.loaded || !needsShareRefresh(st.sync)) return;
    asked.current = true;
    void teamMatters.refreshShareState().then((r) => r?.refreshed && read());
  };
  return { ready: st.ready, configured: st.configured, sync: st.sync, refresh };
}

/** 这台电脑是否已申请接收、等管理员确认（只在直接登录的电脑上问；旧内核没有时按没申请）。 */
export function useDeviceShareApplied(enabled: boolean): boolean {
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void team.deviceShare.status().then((s) => live && setApplied(s.supported === true && s.state === "pending"));
    return () => {
      live = false;
    };
  }, [enabled]);
  return applied;
}

/* ── 记号 ── */

/** 灰色两人记号 + 读屏文字“团队共享”（D-310：不分组、不靠悬停 title）。 */
export function TeamMark({ className = "" }: { className?: string }) {
  return (
    <span className={`team-mark ${className}`.trim()} title="团队共享">
      <Icon.users />
      <span className="sr-only">团队共享</span>
    </span>
  );
}

/** 负责人已把我移出的事项：灰色“已移出”小标（协调方口径：不再带团队共享记号；看得见的字即读屏文字，不靠悬停）。 */
export function RemovedTag({ className = "" }: { className?: string }) {
  return <span className={`tag tag-gray tag-removed ${className}`.trim()}>已移出</span>;
}

/** 侧栏、输入框事项芯片、事项浮层的记号：团队共享 → 两人记号；已移出 → 灰色小标；其余不出现。 */
export function MatterMarkBadge({ mark }: { mark: MatterMark }) {
  return mark === "shared" ? <TeamMark /> : mark === "removed" ? <RemovedTag /> : null;
}

/* ── 新建事项：谁能看到 ── */

/**
 * “谁能看到”（D-307）。variant：modal = 完整弹窗里的一块（与“怎么处理”同级、不折叠）；place = 首页浮层里的一行。
 * 不能选“和同事一起办”时置灰并说一句原因；原因是这台电脑还没经团队确认时给“去申请 →”（设置 → 团队）。
 */
export function ScopeField({ variant, scope, onScope, picked, onPicked, avail, relay }: {
  variant: "modal" | "place";
  scope: CollabScope;
  onScope: (s: CollabScope) => void;
  picked: string[];
  onPicked: (ids: string[]) => void;
  avail: ScopeAvailability;
  relay: { ready: boolean | null; configured: boolean | null; sync?: MatterSync; refresh?: () => void };
}) {
  const roster = useRoster(avail.show && avail.team);
  const reasonId = useId();
  // 选了一起办、看到“所内还没开通…”时问一次内核（规则刚放开时这句随即换成正常说明）
  const teamShown = avail.show && avail.team && scope === "team";
  useEffect(() => {
    if (teamShown && relay.ready !== true) relay.refresh?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamShown, relay.ready, relay.sync]);
  if (!avail.show) return null;
  const modal = variant === "modal";
  const note = modal ? "authz-note" : "place-hint";
  const effective: CollabScope = avail.team ? scope : "personal";
  return (
    <div className={`${modal ? "authz-field" : "place-field"} scope-field`} role="group" aria-label="谁能看到">
      {modal ? (
        <div className="authz-head">
          <span className="authz-k">谁能看到</span>
        </div>
      ) : (
        <span className="place-k">谁能看到</span>
      )}
      <div className={`seg ${modal ? "authz-seg" : "place-seg"}`} role="radiogroup" aria-label="谁能看到">
        {SCOPE_OPTIONS.map((o) => {
          const off = o.v === "team" && !avail.team;
          return (
            <button
              key={o.v}
              type="button"
              role="radio"
              aria-checked={effective === o.v}
              disabled={off}
              aria-describedby={off ? reasonId : undefined}
              className={`seg-btn${effective === o.v ? " on" : ""}`}
              onClick={() => onScope(o.v)}
            >
              {o.v === "team" && <Icon.users />}
              {o.label}
            </button>
          );
        })}
      </div>
      {!avail.team && avail.reason ? (
        <p className={`${note} scope-reason`} id={reasonId}>
          {avail.reason}
          {avail.apply && (
            <>
              {" "}
              <button type="button" className="btn-link scope-go" onClick={() => nav("/connections/team")}>
                去申请 →
              </button>
            </>
          )}
        </p>
      ) : (
        <p className={note}>{scopeHint(effective, relay.ready, relay.configured, relay.sync ?? null)}</p>
      )}
      {effective === "team" && <ColleaguePicker variant="inline" roster={roster} picked={picked} onPicked={onPicked} />}
    </div>
  );
}

/**
 * 选同事（设计评分第一轮 T2 / 跨页 4：三个入口同一个组件）。
 * - inline（两处新建表单）：收起时一排已选胶囊 +“选同事 / 再选同事”文字链；展开时只显示名单，顶上一行“已选 n 人 · 收起”（不再胶囊与勾选行同时出现）；
 * - dialog（加同事、和同事一起办）：名单常显，顶上一行“已选 n 人”。
 * 名单 6 人及以上出搜索框，最多 6 行高内滚；复选框用产品样式。加进来的人一律“一起办”，要只给看到事项成员里改（三个入口同一说法）。
 */
export function ColleaguePicker({ roster, picked, onPicked, variant, exclude = [], emptyText = "团队里还没有其他同事。" }: {
  roster: TeamRoster | null;
  picked: string[];
  onPicked: (ids: string[]) => void;
  variant: "inline" | "dialog";
  exclude?: string[];
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const all = pickableColleagues(roster, exclude);
  const byId = new Map(all.map((m) => [m.user_id, m]));
  const chosen = picked.map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
  const note = rosterNote(roster);
  const listShown = variant === "dialog" || open;
  return (
    <div className={`cp cp-${variant}`}>
      {note && <p className="cp-note cp-note-bar" role="note">{note}</p>}
      {variant === "inline" && !open && (
        <div className="cp-chips">
          {chosen.map((m) => (
            <span key={m.user_id} className="chip cp-chip">
              <span className="cp-chip-name">{m.name}</span>
              <button type="button" className="chip-x" aria-label={`不加${m.name}`} onClick={() => onPicked(picked.filter((x) => x !== m.user_id))}>
                <Icon.x />
              </button>
            </span>
          ))}
          {(all.length > 0 || !note) && (
            <button type="button" className="btn-link cp-toggle" aria-expanded={false} onClick={() => setOpen(true)}>
              {chosen.length > 0 ? "再选同事" : "选同事"}
            </button>
          )}
          {chosen.length === 0 && all.length > 0 && <span className="cp-empty">可以先不选，建好后在事项里再加</span>}
        </div>
      )}
      {listShown && all.length > 0 && (
        <div className="cp-head">
          <span className="cp-count">已选 {chosen.length} 人</span>
          {variant === "inline" && (
            <button type="button" className="btn-link cp-toggle" aria-expanded onClick={() => setOpen(false)}>
              收起
            </button>
          )}
        </div>
      )}
      {/* 第二轮复评 T14（38）：名单取不到 / 用的是上次的名单——灰底说明条放在名单上方，不夹在“已选 n 人”与名单之间 */}
      {listShown && <ColleagueList list={all} picked={picked} onPicked={onPicked} emptyText={emptyText} />}
      {listShown && all.length > 0 && <p className="cp-foot">加进来的同事默认是“一起办”；要只给看，加进来后在事项成员里改。</p>}
    </div>
  );
}

/** 同事名单：首字头像 + 姓名 + 灰色“角色 · 电脑还不能接收 · 确认后自动收到”；6 人及以上出搜索框；最多 6 行高、内滚。 */
function ColleagueList({ list, picked, onPicked, emptyText }: { list: ReturnType<typeof pickableColleagues>; picked: string[]; onPicked: (ids: string[]) => void; emptyText: string }) {
  const [q, setQ] = useState("");
  const shown = filterColleagues(list, q);
  const toggle = (id: string) => onPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  if (list.length === 0) return <p className="cp-note cp-none">{emptyText}</p>;
  return (
    <div className="cp-list" role="group" aria-label="选同事">
      {list.length >= PICKER_SEARCH_FROM && <input type="search" className="cp-search" placeholder="搜索同事" aria-label="搜索同事" value={q} onChange={(e) => setQ(e.target.value)} />}
      {shown.length === 0 && <p className="cp-note">没有找到“{q}”。</p>}
      <div className="cp-rows">
        {shown.map((m) => (
          <label key={m.user_id} className={`cp-row${picked.includes(m.user_id) ? " is-on" : ""}`}>
            <input type="checkbox" className="kw-check" checked={picked.includes(m.user_id)} onChange={() => toggle(m.user_id)} />
            <span className="tm-avatar tm-avatar-sm" aria-hidden="true">
              {avatarOf(m.name)}
            </span>
            <span className="cp-text">
              <span className="cp-name">{m.name}</span>
              <small>{colleagueMeta(m)}</small>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/* ── 事项头胶囊 ── */

/** 事项头“团队共享 · n 人”（与“保护状态”同一种可展开胶囊）：最多列 6 人，底部“事项成员 →”。 */
export function TeamPill({ view, failed = false, onMembers }: { view: MatterMembersView | null; failed?: boolean; onMembers: () => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const rows = view ? sortMembers(view.members) : [];
  // 设计评分第一轮 T10：人数只数还在团队里的人，已离开的另计
  const counts = memberCounts(rows);
  const t = teamPillText(view ? counts.active : null);
  // 点外面收起（与“⋯”菜单同样的规矩）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  return (
    <details className="protect team-pill" ref={ref}>
      <summary className="pill pill-link" aria-label={t.aria}>
        <Icon.users /> {t.label} <Icon.down />
      </summary>
      <div className="protect-pop team-pop" role="group" aria-label="事项成员">
        {!view && <p className="team-pop-empty">{failed ? "暂时读不到事项成员，稍后再看" : "正在读取事项成员…"}</p>}
        {rows.slice(0, 6).map((m) => {
          const quiet = !m.is_me && !m.departed && (!m.can_receive || m.seat === false);
          return (
            <div key={m.user_id} className={`team-pop-row${m.departed ? " is-off" : ""}`}>
              <span className="tm-avatar tm-avatar-sm" aria-hidden="true">
                {avatarOf(memberName(m))}
              </span>
              <span className="team-pop-who">
                <span className="team-pop-name">
                  {memberName(m)}
                  {m.is_me && <span className="tag tag-this">我</span>}
                </span>
                {quiet && <small>{m.seat === false ? "还没有 AI 使用名额" : shareReadyText({ kind: "peer", confirmed: false, relay: null })}</small>}
              </span>
              {/* 已离开的人右侧只写“已离开”，不同时写角色 */}
              <span className="team-pop-role">{m.departed ? "已离开" : matterRoleLabel(m.matter_role)}</span>
            </div>
          );
        })}
        {rows.length > 6 && <p className="team-pop-more">还有 {rows.length - 6} 人</p>}
        {/* 11c T10：已离开的人已在上面列出（右侧“已离开”），底部不再另说一遍 */}
        <div className="team-pop-foot">
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              if (ref.current) ref.current.open = false;
              onMembers();
            }}
          >
            事项成员 →
          </button>
        </div>
      </div>
    </details>
  );
}

/* ── 事项成员页 ── */

/**
 * “⋯ → 事项成员”（D-308）。负责人：加同事、改角色（一起办 / 只看）、原位两步移出；负责人行不给移出（交接走离所交接）。
 * 非负责人：同一张表只读，表尾写找谁。sync 非 ok 时列表上方一句（不逐行重复）；已结案：不能加人、不能改角色（移出仍可）。
 */
export function MatterMembersPanel({ matter, view, error, onReload, canEnable, initialMsg = null }: {
  matter: Matter;
  view: MatterMembersView | null;
  error: string | null;
  onReload: () => void;
  /** 这台电脑能开通同事之间同步（团队管理员）：所内没开通时给“去开通 →”。 */
  canEnable: boolean;
  /** 刚从“和同事一起办…”过来时的一句结果。 */
  initialMsg?: { text: string; tone: "ok" | "warn" } | null;
}) {
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "warn" } | null>(initialMsg);
  useEffect(() => {
    if (msg?.tone !== "ok") return;
    const t = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [msg]);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<{ id: string; text: string } | null>(null);
  if (!view) return error ? <LoadError what="事项成员" message={error} onRetry={onReload} /> : <ListSkeleton rows={3} label="正在读取事项成员" />;
  const closed = (matter.lifecycle ?? "active") !== "active";
  const owner = view.is_owner;
  // 负责人且这台电脑现在能改（内核 can_manage：经同步服务同步的须是最先同步它的那位；负责人暂时无法确认时不能；结案只读）
  const manage = canManageMembers(view, closed);
  const blockedNote = manageBlockedText(view, closed);
  const rows = sortMembers(view.members);
  const counts = memberCounts(rows);
  const notice = syncNotice(view.sync);
  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    setRowErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg({ text: done, tone: "ok" });
      setAsking(null);
      notifyDataChanged();
      onReload();
    } catch (e) {
      setRowErr({ id, text: memberErrorText(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="mm" aria-labelledby="mm-title">
      <div className="mm-head">
        <h2 id="mm-title" className="h-section mm-title">
          事项成员 <span className="team-count">{counts.active}</span>
        </h2>
        {manage && (
          <button type="button" className="btn-ghost btn-sm mm-add" onClick={() => setAdding(true)}>
            <Icon.plus /> 加同事
          </button>
        )}
      </div>
      <p className="mm-lead">
        <Icon.lock />
        <span>加进来的同事在自己的电脑上也能看到这个事项的材料、任务和成果，内容在你们的电脑之间加密同步。</span>
      </p>
      {notice && (
        <div className="mm-notice" role="note">
          <span>{notice.text}</span>
          {notice.enable && canEnable && (
            <button type="button" className="btn-link" onClick={() => nav("/connections/team")}>
              去开通 →
            </button>
          )}
        </div>
      )}
      {/* 设计评分第一轮（跨页 6）：成功是中性的轻提示（只对勾着色、几秒后消失）；第二轮复评 T14（37）：没加上的人用与其他提示同一个灰底说明条（左侧提醒图标、正文色），留着 */}
      {msg &&
        (msg.tone === "warn" ? (
          <div className="mm-notice mm-notice-warn" role="status">
            <Icon.alert />
            <span>{msg.text}</span>
          </div>
        ) : (
          <p className="lite-toast mm-toast" role="status">
            <Icon.check />
            <span>{msg.text}</span>
          </p>
        ))}
      <ul className="mm-list" aria-label="事项成员">
        {rows.map((m) => {
          const name = memberName(m);
          const note = memberRowNote(m);
          // 已离开团队的人不能再改角色（内核也拒：名单里不是在用）——只留“移出”（实拍发现）
          const editable = manage && !m.is_me && !m.departed && (m.matter_role === "editor" || m.matter_role === "viewer");
          const removable = manage && !m.is_me && m.matter_role !== "owner";
          return (
            <li key={m.user_id} className={`mm-row${m.departed ? " is-off" : ""}${asking === m.user_id ? " is-asking" : ""}`}>
              <div className="mm-main">
                <span className="tm-who mm-who">
                  <span className="tm-avatar" aria-hidden="true">
                    {avatarOf(name)}
                  </span>
                  <span className="tm-who-text">
                    <span className="mm-name">{name}</span>
                    {m.is_me && <span className="tag tag-this">我</span>}
                  </span>
                </span>
                <span className="mm-role">
                  {editable ? (
                    <Select
                      aria-label={`${name}的角色`}
                      className="mm-role-select"
                      value={m.matter_role}
                      disabled={busy !== null}
                      onChange={(v) => v !== m.matter_role && void act(m.user_id, () => matterMembers.setRole(matter.matter_id, m.user_id, v as "editor" | "viewer"), `已把${name}改为“${matterRoleLabel(v)}”。`)}
                      options={MATTER_ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
                    />
                  ) : (
                    // 已离开的人：角色列只写“已离开团队”（设计评分第一轮 T10）
                    <span className={`mm-role-text${m.departed ? " is-off" : ""}`}>{m.departed ? "已离开团队" : matterRoleLabel(m.matter_role)}</span>
                  )}
                </span>
                <span className="mm-acts">
                  {/* 行尾灰色文字按钮（悬停变红），红底只留给确认条；已离开的人写明“从事项移出” */}
                  {removable && asking !== m.user_id && (
                    <button type="button" className="mm-remove" disabled={busy !== null} onClick={() => setAsking(m.user_id)}>
                      {m.departed ? "从事项移出" : "移出"}
                    </button>
                  )}
                </span>
              </div>
              {/* 实拍：长句放在名字下面整行（原来挤在人名那一栏里折成三行） */}
              {/* 11c T10：就地确认条出现时收起行内说明（两句几乎同义） */}
              {note && asking !== m.user_id && (
                <p className="mm-sub">
                  {note.text}
                  {/* 第二轮复评 T13（45）：同事没有名额、看页面的人是团队管理员——直接去分配 */}
                  {note.assign && canEnable && (
                    <button type="button" className="btn-link mm-sub-go" onClick={() => nav("/connections/team")}>
                      去分配 →
                    </button>
                  )}
                </p>
              )}
              {asking === m.user_id && (
                // 原位两步（D-308）：后果写清，确认按钮红色实心，默认焦点在“取消”
                <div className="mm-confirm" role="alertdialog" aria-label={`移出${name}`}>
                  <p>{removeQuestion(name)}</p>
                  <span className="mm-confirm-acts">
                    <button type="button" className="btn-danger-solid btn-sm" disabled={busy !== null} onClick={() => void act(m.user_id, () => matterMembers.remove(matter.matter_id, m.user_id), removeResult(name))}>
                      {busy === m.user_id ? "正在移出…" : "确定移出"}
                    </button>
                    <button type="button" className="btn-ghost btn-sm" autoFocus onClick={() => setAsking(null)}>
                      取消
                    </button>
                  </span>
                </div>
              )}
              {rowErr?.id === m.user_id && (
                <p className="activate-error mm-row-err" role="alert">
                  {rowErr.text}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {!owner && <p className="mm-foot">{ownerHint(rows)}</p>}
      {blockedNote && <p className="mm-foot">{blockedNote}</p>}
      {adding && (
        <AddColleaguesDialog
          mode="add"
          matter={matter}
          existing={view.members.map((x) => x.user_id)}
          sync={view.sync}
          onClose={() => setAdding(false)}
          onDone={(text, tone) => {
            setAdding(false);
            setMsg({ text, tone });
            notifyDataChanged();
            onReload();
          }}
        />
      )}
    </section>
  );
}

/* ── 加同事 / 和同事一起办 ── */

/**
 * mode = add：把同事加进团队共享事项；mode = share：个人事项改为和同事一起办（负责人；二次确认写明不可改回，D-307），同时可选同事（可不选）。
 * 加人逐个进行，一个没加上不影响其余，结果一句话说清（谁下次同步时收到、谁的电脑还要申请、谁没加上及原因）。
 */
export function AddColleaguesDialog({ mode, matter, existing = [], sync = null, onClose, onDone }: {
  mode: "add" | "share";
  matter: Matter;
  existing?: string[];
  sync?: MatterSync | null;
  onClose: () => void;
  onDone: (text: string, tone: "ok" | "warn") => void;
}) {
  const { ws, kind } = useTeamKind();
  const roster = useRoster(true);
  const relay = useRelayState(mode === "share");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const all = pickableColleagues(roster, existing);
  const note = rosterNote(roster);
  const applied = useDeviceShareApplied(mode === "share" && ws.issuer === "account_ca");
  const avail = mode === "share" ? scopeAvailability({ kind, issuer: ws.issuer, level: levelOfMatter(matter), roster, applied }) : { show: true, team: true, reason: null, apply: false };
  const blocked = mode === "share" && ws.ready && !avail.team;
  // 设计评分第一轮 T2：加同事时没有可加的人（名单已取到、同事都在事项里或团队里没别人）——整块换成一句话 +“知道了”
  const nobody = mode === "add" && !!roster && rosterNote(roster) === null && all.length === 0;
  const effSync: MatterSync | null = mode === "share" ? relay.sync : sync;
  // “和同事一起办…”弹窗里显示“所内还没开通…”时问一次内核（同 ScopeField）
  useEffect(() => {
    if (mode === "share" && relay.ready === false) relay.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, relay.ready, relay.sync]);
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      if (mode === "share") await api.updateMatter(matter.matter_id, { collab_scope: "team" });
    } catch (e) {
      // 内核按 code + detail.reason 拒（personal_workspace / workspace_unknown / device_not_confirmed / client_no_cloud 等）：如实显示
      setErr(teamFaultText(e));
      setBusy(false);
      return;
    }
    const added: { name: string; can_receive: boolean; seat: boolean | null }[] = [];
    const failed: { name: string; why: string }[] = [];
    for (const id of picked) {
      const m = all.find((x) => x.user_id === id);
      const name = m?.name ?? "一位同事";
      try {
        // 三个入口同一规则：加进来一律“一起办”，要只给看到事项成员里改
        const r = await matterMembers.add(matter.matter_id, id, "editor");
        added.push({ name: r.name ?? name, can_receive: r.can_receive ?? !!m?.can_receive, seat: m?.seat ?? null });
      } catch (e) {
        failed.push({ name, why: memberErrorText(e) });
      }
    }
    setBusy(false);
    const text = addResultText(added, failed, effSync);
    onDone(mode === "share" ? `已改为团队共享${text ? `，${text}` : "。"}` : text, failed.length > 0 ? "warn" : "ok");
  };
  const n = picked.length;
  return (
    <Modal title={mode === "share" ? `改为团队共享「${matter.title}」` : `把同事加进「${matter.title}」`} onClose={() => !busy && onClose()}>
      <div className="acd">
        {mode === "share" && (
          <ul className="acd-lines">
            {shareMatterLines().map((l, i, a) => (
              <li key={l} className={i === a.length - 1 ? "is-key" : undefined}>
                {l}
              </li>
            ))}
          </ul>
        )}
        {nobody ? (
          <p className="acd-empty">{existing.length > 1 ? "团队里的同事都已在这个事项里。" : "团队里还没有其他同事。"}</p>
        ) : blocked ? (
          <p className="acd-blocked" role="note">
            {avail.reason}
            {avail.apply && (
              <>
                {" "}
                <button type="button" className="btn-link" onClick={() => nav("/connections/team")}>
                  去申请 →
                </button>
              </>
            )}
          </p>
        ) : (
          <>
            {mode === "share" && relay.ready === false && <p className="acd-relay">{scopeHint("team", false, relay.configured)}</p>}
            <div className="acd-k">{mode === "share" ? "同时加哪些同事（可以先不选）" : "选同事"}</div>
            <ColleaguePicker variant="dialog" roster={roster} picked={picked} onPicked={setPicked} exclude={existing} emptyText={existing.length > 1 ? "团队里的同事都已在这个事项里。" : "团队里还没有其他同事。"} />
          </>
        )}
      </div>
      <div className="modal-actions modal-actions-sticky">
        {err && (
          <div className="banner banner-red" role="alert">
            {err}
          </div>
        )}
        {nobody ? (
          <button type="button" className="btn-primary" onClick={onClose}>
            知道了
          </button>
        ) : (
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
            {blocked ? "关闭" : "取消"}
          </button>
        )}
        {!blocked && !nobody && (
          <button type="button" className="btn-primary" aria-busy={busy || undefined} disabled={busy || (mode === "add" && n === 0) || (mode === "share" && !ws.ready)} onClick={() => void submit()}>
            {busy ? "正在处理…" : mode === "share" ? (n > 0 ? `改为团队共享（${n}）` : "改为团队共享") : `加入（${n}）`}
          </button>
        )}
      </div>
    </Modal>
  );
}
