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
import { api, matterMembers, teamMatters, type Matter, type MatterMembersView, type MatterSync, type TeamRoster } from "../api.ts";
import { nav } from "../App.tsx";
import {
  addResultText,
  avatarOf,
  canManageMembers,
  manageBlockedText,
  colleagueMeta,
  filterColleagues,
  levelOfMatter,
  MATTER_ROLE_OPTIONS,
  matterRoleLabel,
  memberErrorText,
  memberName,
  memberRowNote,
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
  type ScopeAvailability,
} from "../lib/team-matters.ts";
import { notifyDataChanged } from "../lib/events.ts";
import { Icon } from "./Icons.tsx";
import { ListSkeleton, LoadError } from "./Loading.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";
import { useWorkspace } from "./WorkspaceSwitch.tsx";
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

/** 同事之间同步的状态（relay.status → true 已开通 / false 没开通 / null 不知道；configured：中软是否已为本所开通服务）。 */
export function useRelayState(enabled: boolean): { ready: boolean | null; configured: boolean | null; sync: MatterSync } {
  const [st, setSt] = useState<{ ready: boolean | null; configured: boolean | null; sync: MatterSync }>({ ready: null, configured: null, sync: "unknown" });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api
      .relayStatus()
      .then((s) => live && setSt({ ready: relayReady(s), configured: s.blocked === "not_configured" ? false : true, sync: relaySyncOf(s) }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled]);
  return st;
}

/* ── 记号 ── */

/** 灰色两人记号 + 读屏文字“团队共享”（D-310：不分组、不靠悬停 title）。 */
export function TeamMark({ className = "" }: { className?: string }) {
  return (
    <span className={`team-mark ${className}`.trim()}>
      <Icon.users />
      <span className="sr-only">团队共享</span>
    </span>
  );
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
  relay: { ready: boolean | null; configured: boolean | null };
}) {
  const roster = useRoster(avail.show && avail.team);
  const reasonId = useId();
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
        <p className={note}>{scopeHint(effective, relay.ready, relay.configured)}</p>
      )}
      {effective === "team" && <ColleaguePicker roster={roster} picked={picked} onPicked={onPicked} />}
    </div>
  );
}

/** 建事项时选同事：已选的成 chip（带 ×），“选同事”展开同一块里的列表（不另开弹窗）；可留空，建好再加。 */
function ColleaguePicker({ roster, picked, onPicked }: { roster: TeamRoster | null; picked: string[]; onPicked: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const all = pickableColleagues(roster);
  const byId = new Map(all.map((m) => [m.user_id, m]));
  const chosen = picked.map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
  const note = rosterNote(roster);
  return (
    <div className="cp">
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
          <button type="button" className="btn-ghost btn-sm cp-add" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "收起" : <><Icon.plus /> {chosen.length > 0 ? "再选同事" : "选同事"}</>}
          </button>
        )}
        {chosen.length === 0 && !open && all.length > 0 && <span className="cp-empty">可以先不选，建好后在事项里再加</span>}
      </div>
      {note && <p className="cp-note">{note}</p>}
      {open && <ColleagueList list={all} picked={picked} onPicked={onPicked} />}
    </div>
  );
}

/** 同事列表（选同事、加同事共用）：首字头像 + 姓名 + 灰色“角色 · 电脑还不能接收”；超过 8 人出搜索框；最多 6 行高、内滚。 */
function ColleagueList({ list, picked, onPicked, emptyText = "团队里还没有其他同事。" }: { list: ReturnType<typeof pickableColleagues>; picked: string[]; onPicked: (ids: string[]) => void; emptyText?: string }) {
  const [q, setQ] = useState("");
  const shown = filterColleagues(list, q);
  const toggle = (id: string) => onPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return (
    <div className="cp-list" role="group" aria-label="选同事">
      {list.length > PICKER_SEARCH_FROM && <input type="search" className="cp-search" placeholder="搜索同事" aria-label="搜索同事" value={q} onChange={(e) => setQ(e.target.value)} />}
      {list.length === 0 && <p className="cp-note">{emptyText}</p>}
      {list.length > 0 && shown.length === 0 && <p className="cp-note">没有找到“{q}”。</p>}
      <div className="cp-rows">
        {shown.map((m) => (
          <label key={m.user_id} className={`cp-row${picked.includes(m.user_id) ? " is-on" : ""}`}>
            <input type="checkbox" checked={picked.includes(m.user_id)} onChange={() => toggle(m.user_id)} />
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
  const t = teamPillText(view ? view.members.length : null);
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
          const quiet = !m.is_me && !m.departed && !m.can_receive;
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
                {(quiet || m.departed) && <small>{m.departed ? "已离开团队" : "电脑还不能接收"}</small>}
              </span>
              <span className="team-pop-role">{matterRoleLabel(m.matter_role)}</span>
            </div>
          );
        })}
        {rows.length > 6 && <p className="team-pop-more">还有 {rows.length - 6} 人</p>}
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
          事项成员 <span className="team-count">{rows.length}</span>
        </h2>
        {manage && (
          <button type="button" className="btn-ghost btn-sm mm-add" onClick={() => setAdding(true)}>
            <Icon.plus /> 加同事
          </button>
        )}
      </div>
      <p className="mm-lead">
        <Icon.lock />
        <span>加进来的同事在自己的电脑上也能看到这个事项的材料、任务和成果；内容加密后在你们的电脑之间同步，中软打不开。</span>
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
      {msg && (
        <p className={`mm-msg${msg.tone === "warn" ? " is-warn" : ""}`} role="status">
          {msg.tone === "ok" && <Icon.check />}
          <span>{msg.text}</span>
        </p>
      )}
      <ul className="mm-list" aria-label="事项成员">
        {rows.map((m) => {
          const name = memberName(m);
          const note = memberRowNote(m);
          const editable = manage && !m.is_me && (m.matter_role === "editor" || m.matter_role === "viewer");
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
                    {m.departed && <span className="tag tag-gray">已离开团队</span>}
                    {note && !m.departed && <small className="mm-note">{note.text}</small>}
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
                    <span className="mm-role-text">{matterRoleLabel(m.matter_role)}</span>
                  )}
                </span>
                <span className="mm-acts">
                  {removable && asking !== m.user_id && (
                    <button type="button" className="btn-ghost btn-danger btn-sm" disabled={busy !== null} onClick={() => setAsking(m.user_id)}>
                      移出
                    </button>
                  )}
                </span>
              </div>
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
  const ws = useWorkspace();
  const roster = useRoster(true);
  const relay = useRelayState(mode === "share");
  const [picked, setPicked] = useState<string[]>([]);
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const all = pickableColleagues(roster, existing);
  const note = rosterNote(roster);
  const avail = mode === "share" ? scopeAvailability({ kind: ws.kind, issuer: ws.issuer, level: levelOfMatter(matter), roster }) : { show: true, team: true, reason: null, apply: false };
  const blocked = mode === "share" && ws.ready && !avail.team;
  const effSync: MatterSync | null = mode === "share" ? relay.sync : sync;
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      if (mode === "share") await api.updateMatter(matter.matter_id, { collab_scope: "team" });
    } catch (e) {
      setErr(memberErrorText(e));
      setBusy(false);
      return;
    }
    const added: { name: string; can_receive: boolean }[] = [];
    const failed: { name: string; why: string }[] = [];
    for (const id of picked) {
      const m = all.find((x) => x.user_id === id);
      const name = m?.name ?? "一位同事";
      try {
        await matterMembers.add(matter.matter_id, id, role);
        added.push({ name, can_receive: !!m?.can_receive });
      } catch (e) {
        failed.push({ name, why: memberErrorText(e) });
      }
    }
    setBusy(false);
    const text = addResultText(added, failed, effSync);
    onDone(mode === "share" ? `已改为和同事一起办。${text}` : text, failed.length > 0 ? "warn" : "ok");
  };
  const n = picked.length;
  return (
    <Modal title={mode === "share" ? `和同事一起办「${matter.title}」` : `把同事加进「${matter.title}」`} onClose={() => !busy && onClose()}>
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
        {blocked ? (
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
            {note && <p className="cp-note">{note}</p>}
            <ColleagueList list={all} picked={picked} onPicked={setPicked} emptyText={existing.length > 1 ? "团队里的同事都已在这个事项里。" : "团队里还没有其他同事。"} />
            <div className="acd-role">
              <span className="acd-k">加入后是</span>
              <Select aria-label="加入后的角色" value={role} onChange={(v) => setRole(v as "editor" | "viewer")} options={MATTER_ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))} />
            </div>
          </>
        )}
      </div>
      <div className="modal-actions modal-actions-sticky">
        {err && (
          <div className="banner banner-red" role="alert">
            {err}
          </div>
        )}
        <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
          {blocked ? "关闭" : "取消"}
        </button>
        {!blocked && (
          <button type="button" className="btn-primary" aria-busy={busy || undefined} disabled={busy || (mode === "add" && n === 0) || (mode === "share" && !ws.ready)} onClick={() => void submit()}>
            {busy ? "正在处理…" : mode === "share" ? (n > 0 ? `开始一起办（${n}）` : "开始一起办") : `加入（${n}）`}
          </button>
        )}
      </div>
    </Modal>
  );
}
