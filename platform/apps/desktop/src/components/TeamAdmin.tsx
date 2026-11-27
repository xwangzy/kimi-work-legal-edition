/**
 * 第 72 批（V46，D-304、D-305，契约 02 §3.2、§3.4）：设置 · 团队里的管理员部分——成员（改角色、分配 / 释放席位、停用、移出）、
 * 邀请成员（姓名 + 角色 → 一次性邀请码，7 天有效、可撤回）、电脑待确认、成员新电脑策略。合伙人只读成员与邀请。
 * 每个危险操作都先说清后果（lib/team-admin.ts），任何操作都不超过两步（点一下 → 确认）。
 * 云端不支持新接口（旧云端，supported:false）时退回原来的成员页（MembersAdmin，按律所电脑邀请与批准）。
 */
import { useEffect, useState } from "react";
import { account, team } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import {
  adminErrorText,
  devicesCell,
  disableLines,
  INVITE_STATUS,
  MEMBER_DEVICE_POLICY,
  memberActions,
  memberStatus,
  releaseSeatLine,
  removeLines,
  ROLE_HINT,
  ROLE_ORDER,
  roleChangeLine,
  seatSummary,
  splitInvites,
  type TeamInviteRow,
  type TeamMemberRow,
} from "../lib/team-admin.ts";
import { WS_ROLE_LABEL, type WorkspaceRole } from "../lib/workspace.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { Icon } from "./Icons.tsx";
import { MembersAdmin, PendingDevices } from "./MembersAdmin.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";

const roleName = (r: string): string => WS_ROLE_LABEL[r as WorkspaceRole] ?? "成员";
const nameOf = (m: Pick<TeamMemberRow, "name" | "email">): string => m.name?.trim() || m.email || "这位成员";

type Ask =
  | { kind: "role"; m: TeamMemberRow; role: WorkspaceRole }
  | { kind: "remove"; m: TeamMemberRow; ack: boolean };

/** 团队管理（管理员可改，合伙人只读）。myAid = 当前工作空间里“我”的账号编号（不能停用 / 移出自己）。 */
export function TeamAdmin({ canEdit, myAid }: { canEdit: boolean; myAid: string | null }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof team.members>> | null>(null);
  const [invites, setInvites] = useState<TeamInviteRow[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone?: "bad" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [inviting, setInviting] = useState(false);
  const load = () => {
    team
      .members()
      .then((d) => {
        setData(d);
        setErr("");
      })
      .catch((e) => setErr(adminErrorText(e)));
    team
      .invites()
      .then((r) => setInvites(r.invites ?? []))
      .catch(() => setInvites([]));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!msg || msg.tone === "bad") return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);
  // 旧云端：没有团队成员接口，退回原来的成员页
  if (data && data.supported === false) return canEdit ? <MembersAdmin /> : null;
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ text: ok });
      setAsk(null);
    } catch (e) {
      setMsg({ text: adminErrorText(e), tone: "bad" });
    } finally {
      setBusy(null);
      load();
    }
  };
  const list = data?.members ?? [];
  const active = list.filter((m) => m.status === "active");
  const off = list.filter((m) => m.status !== "active");
  const seats = seatSummary(data?.seats ?? null);
  const { open, done } = splitInvites(invites);
  const row = (m: TeamMemberRow) => {
    const a = memberActions(m, myAid);
    const st = memberStatus(m);
    const who = nameOf(m);
    const me = m.aid === myAid;
    return (
      <tr key={m.aid} className={m.status === "active" ? undefined : "is-off"}>
        <td>
          <div className="tm-who">
            <span className="tm-avatar" aria-hidden="true">
              {who.slice(0, 1)}
            </span>
            <span className="tm-who-text">
              <b>{who}</b>
              {me && <span className="tag tag-this">我</span>}
              <small>{m.person_phone_masked ?? m.email ?? "未绑定手机号"}</small>
            </span>
          </div>
        </td>
        <td>
          {canEdit && a.role && !me ? (
            <Select
              aria-label={`${who}的角色`}
              value={m.role}
              onChange={(v) => v !== m.role && setAsk({ kind: "role", m, role: v as WorkspaceRole })}
              options={ROLE_ORDER.map((r) => ({ value: r, label: WS_ROLE_LABEL[r] }))}
            />
          ) : (
            roleName(m.role)
          )}
        </td>
        <td>
          <span className={`tm-seat${a.seat === "release" ? " on" : ""}`}>{a.seat === "release" ? "有" : m.status === "active" ? "无" : "—"}</span>
          {canEdit && a.seat === "assign" && (
            <button className="btn-link tm-inline" disabled={busy !== null} onClick={() => void run(`seat-${m.aid}`, () => team.seat(m.aid, true), `已给${who}分配席位`)}>
              分配
            </button>
          )}
          {canEdit && a.seat === "release" && !me && (
            <ConfirmButton label="释放" className="btn-link tm-inline" question={releaseSeatLine(who)} confirmLabel="释放席位" disabled={busy !== null} onConfirm={() => run(`seat-${m.aid}`, () => team.seat(m.aid, false), `已释放${who}的席位`)} />
          )}
        </td>
        <td className="tm-num">{devicesCell(m.devices_summary)}</td>
        <td>
          <span className={`tm-status tm-status-${st.tone}`}>
            <span className="sdot" aria-hidden="true" />
            {st.text}
          </span>
        </td>
        <td className="tm-acts">
          {canEdit && a.disable && (
            <ConfirmButton label="停用" className="btn-ghost btn-sm" question={disableLines(who).join("")} confirmLabel="停用" disabled={busy !== null} onConfirm={() => run(`dis-${m.aid}`, () => team.disable(m.aid), `已停用${who}`)} />
          )}
          {canEdit && a.remove && (
            <button className="btn-ghost btn-danger btn-sm" disabled={busy !== null} onClick={() => setAsk({ kind: "remove", m, ack: false })}>
              移出团队…
            </button>
          )}
          {canEdit && a.enable && (
            <button className="btn-ghost btn-sm" disabled={busy !== null} onClick={() => void run(`en-${m.aid}`, () => team.enable(m.aid), `已重新启用${who}`)}>
              重新启用
            </button>
          )}
          {m.disabled_by === "platform" && <span className="muted">请联系中软客服</span>}
        </td>
      </tr>
    );
  };
  return (
    <section className="panel device-section team-admin" aria-labelledby="sec-members">
      <div className="team-sec-head">
        <div>
          <h2 className="section-h h-section" id="sec-members">
            成员<span className="team-count">{active.length}</span>
          </h2>
          {seats && <div className="team-sub">{seats}</div>}
        </div>
        {canEdit && (
          <button className="btn-primary btn-sm" onClick={() => setInviting(true)}>
            {Icon.plus()} 邀请成员
          </button>
        )}
      </div>
      <p className="team-privacy" role="note">
        {Icon.lock()}
        <span>事项内容只在成员各自的电脑上，管理员看不到。这里只管谁能用、能用几台电脑。</span>
      </p>
      {err && !data && <p className="activate-error">{err}</p>}
      {msg && (
        <p className={msg.tone === "bad" ? "activate-error" : "team-ok"} role="status">
          {msg.text}
        </p>
      )}
      {list.length > 0 && (
        <div className="tm-table-wrap">
          <table className="members-table tm-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>角色</th>
                <th>席位</th>
                <th>电脑</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>{active.map(row)}</tbody>
          </table>
        </div>
      )}
      {off.length > 0 && (
        <details className="quiet-details tm-off">
          <summary>已停用或移出的成员（{off.length}）</summary>
          <div className="tm-table-wrap">
            <table className="members-table tm-table">
              <tbody>{off.map(row)}</tbody>
            </table>
          </div>
        </details>
      )}

      <div className="team-sub-sec">
        <h3 className="team-h3">邀请</h3>
        {open.length === 0 ? (
          <p className="muted team-empty">{canEdit ? "没有未使用的邀请。点上面的“邀请成员”生成邀请码。" : "没有未使用的邀请。"}</p>
        ) : (
          <ul className="tm-invites">
            {open.map((x) => (
              <li key={x.id}>
                <span className="tm-inv-main">
                  <b>{x.name}</b>
                  <span className="tag">{roleName(x.role)}</span>
                </span>
                <span className="muted">{fmtTime(x.expires_at)} 前有效</span>
                {canEdit && <ConfirmButton label="撤回" className="btn-ghost btn-sm" question={`撤回给${x.name}的邀请？撤回后这串邀请码不能再用。`} confirmLabel="撤回" onConfirm={() => run(`inv-${x.id}`, () => team.revokeInvite(x.id), "已撤回")} />}
              </li>
            ))}
          </ul>
        )}
        {done.length > 0 && (
          <details className="quiet-details">
            <summary>已处理的邀请（{done.length}）</summary>
            <ul className="tm-invites is-done">
              {done.slice(0, 20).map((x) => (
                <li key={x.id}>
                  <span className="tm-inv-main">
                    <b>{x.name}</b>
                    <span className="tag">{roleName(x.role)}</span>
                  </span>
                  <span className="muted">
                    {INVITE_STATUS[x.status] ?? x.status}
                    {x.accepted_at ? ` · ${fmtTime(x.accepted_at)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {canEdit && (
        <>
          <div className="team-sub-sec">
            <h3 className="team-h3">电脑待确认</h3>
            <PendingDevices />
          </div>
          <div className="team-sub-sec">
            <h3 className="team-h3">成员新电脑</h3>
            <MemberDevicePolicy onDone={(t) => setMsg({ text: t })} />
          </div>
        </>
      )}

      {inviting && <InviteDialog onClose={() => setInviting(false)} onCreated={load} />}
      {ask?.kind === "role" && (
        <Modal title="修改角色" onClose={() => setAsk(null)}>
          <p className="confirm-dialog-q">{roleChangeLine(nameOf(ask.m), ask.role)}</p>
          <div className="modal-actions">
            <button className="btn-ghost btn-sm" autoFocus onClick={() => setAsk(null)}>
              取消
            </button>
            <button className="btn-primary btn-sm" disabled={busy !== null} onClick={() => void run(`role-${ask.m.aid}`, () => team.role(ask.m.aid, ask.role), `已把${nameOf(ask.m)}改为${WS_ROLE_LABEL[ask.role]}`)}>
              {busy ? "正在修改…" : `改为${WS_ROLE_LABEL[ask.role]}`}
            </button>
          </div>
        </Modal>
      )}
      {ask?.kind === "remove" && (
        <Modal title={`把${nameOf(ask.m)}移出团队？`} onClose={() => setAsk(null)}>
          <ul className="team-lines">
            {removeLines(nameOf(ask.m)).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <label className="team-ack">
            <input type="checkbox" checked={ask.ack} onChange={(e) => setAsk({ ...ask, ack: e.target.checked })} /> {nameOf(ask.m)}已交接完，或团队决定不再等
          </label>
          <div className="modal-actions">
            <button className="btn-ghost btn-sm" autoFocus onClick={() => setAsk(null)}>
              取消
            </button>
            <button className="btn-danger-solid btn-sm" disabled={!ask.ack || busy !== null} onClick={() => void run(`rm-${ask.m.aid}`, () => team.remove(ask.m.aid), `已把${nameOf(ask.m)}移出团队`)}>
              {busy ? "正在移出…" : "移出团队"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** 邀请成员：姓名 + 角色 → 一次性邀请码（明文只显示这一次；7 天有效、只能用一次、可撤回）。 */
function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("lawyer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [issued, setIssued] = useState<{ code: string; name: string; expires_at: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await team.invite(name.trim(), role);
      if (r.supported === false || !r.code) throw new Error("云端暂时不支持发团队邀请：请稍后重试，或联系中软客服");
      setIssued({ code: r.code, name: r.invite?.name ?? name.trim(), expires_at: r.invite?.expires_at ?? null });
      onCreated();
    } catch (e) {
      setErr(adminErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={issued ? `给${issued.name}的邀请码` : "邀请成员"} onClose={onClose}>
      {issued ? (
        <div className="invite-issued">
          <div className="invite-code" aria-label="邀请码">
            {issued.code}
          </div>
          <button
            className="btn-ghost btn-sm"
            onClick={() =>
              void navigator.clipboard?.writeText(issued.code).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {Icon.copy()} {copied ? "已复制" : "复制邀请码"}
          </button>
          <ul className="team-lines">
            <li>只显示这一次{issued.expires_at ? `，${fmtTime(issued.expires_at)} 前有效（7 天）` : "，7 天内有效"}，只能用一次；不用了可以在“邀请”里撤回。</li>
            <li>已注册的同事：在 Kimi Work 的“设置 · 账号 · 加入团队”里输入这个码。</li>
            <li>还没注册的同事：注册时填这个码，注册完就直接进入团队。</li>
          </ul>
          <div className="modal-actions">
            <button className="btn-primary btn-sm" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      ) : (
        <form
          className="invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="field">
            <span>姓名</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：张律师" maxLength={40} autoFocus />
          </label>
          <div className="field">
            <span>角色</span>
            <div className="role-pick" role="radiogroup" aria-label="角色">
              {ROLE_ORDER.map((r) => (
                <button type="button" key={r} role="radio" aria-checked={role === r} className={`role-opt${role === r ? " on" : ""}`} onClick={() => setRole(r)}>
                  <b>{WS_ROLE_LABEL[r]}</b>
                  <small>{ROLE_HINT[r]}</small>
                </button>
              ))}
            </div>
          </div>
          <p className="muted">邀请时不占席位；对方加入后再按需分配。对方的事项内容只在他自己的电脑上，你看不到。</p>
          {err && (
            <p className="activate-error" role="alert">
              {err}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn-primary btn-sm" disabled={!name.trim() || busy}>
              {busy ? "正在生成…" : "生成邀请码"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** 成员新电脑策略（D-304）：缺省“直接登录”；可改“须管理员确认”（写清后果，二次确认）。当前值取 /v1/auth/me 的 workspace.member_device_policy。 */
function MemberDevicePolicy({ onDone }: { onDone: (t: string) => void }) {
  const [policy, setPolicy] = useState<"auto" | "approve" | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    account
      .me()
      .then((j: any) => setPolicy(j?.workspace?.member_device_policy === "approve" ? "approve" : "auto"))
      .catch(() => setPolicy("auto"));
  }, []);
  const set = async (p: "auto" | "approve") => {
    setBusy(true);
    setErr("");
    try {
      const r = await team.memberDevicePolicy(p);
      if (r.supported === false) throw new Error("云端暂时不支持改这项设置");
      setPolicy(r.policy ?? p);
      setAsking(false);
      onDone(p === "approve" ? "已改为：成员新电脑须管理员确认" : "已改为：成员新电脑直接登录");
    } catch (e) {
      setErr(adminErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!policy) return <p className="muted team-empty">正在读取…</p>;
  return (
    <div className="team-policy">
      <div className="seg" role="radiogroup" aria-label="成员新电脑">
        {(["auto", "approve"] as const).map((k) => (
          <button key={k} role="radio" aria-checked={policy === k} className={`seg-btn${policy === k ? " on" : ""}`} disabled={busy} onClick={() => (k === policy ? undefined : k === "approve" ? setAsking(true) : void set("auto"))}>
            {MEMBER_DEVICE_POLICY[k].label}
          </button>
        ))}
      </div>
      <p className="setting-hint">{MEMBER_DEVICE_POLICY[policy].hint}</p>
      {err && <p className="activate-error">{err}</p>}
      {asking && (
        <Modal title="改为须管理员确认？" onClose={() => setAsking(false)}>
          <p className="confirm-dialog-q">{MEMBER_DEVICE_POLICY.approve.hint}</p>
          <p className="muted">适合对设备管控有更严要求的团队。改回“直接登录”随时可以。</p>
          <div className="modal-actions">
            <button className="btn-ghost btn-sm" autoFocus onClick={() => setAsking(false)}>
              取消
            </button>
            <button className="btn-primary btn-sm" disabled={busy} onClick={() => void set("approve")}>
              {busy ? "正在保存…" : "改为须管理员确认"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
