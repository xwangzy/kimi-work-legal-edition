/**
 * 设置 → 管理 → 成员（第 13 批开通与成员入组；只有管理员能用，控制面同样核对）。
 * 邀请：填姓名与角色 → 生成一次性邀请码（只显示这一次）→ 经微信或当面交给同事。
 * 批准：同事在新装的客户端输入邀请码后，这里出现待批准申请；请对方念出他屏幕上的 12 位数字，与这里一致再批准。
 */
import { useEffect, useState } from "react";
import { members, type RosterMember } from "../api.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { fmtTime } from "../lib/labels.ts";
import { memberLabel, memberStatusText, removalLines } from "../lib/offboarding.ts";
import { Select } from "./Select.tsx";

const ROLES: [string, string][] = [
  ["lawyer", "律师"],
  ["partner", "合伙人"],
  ["assistant", "助理"],
  ["admin", "管理员"],
];
const ROLE_LABEL = Object.fromEntries(ROLES);
const STATUS_LABEL: Record<string, string> = { open: "未使用", claimed: "对方已输入，等你批准", consumed: "已加入", revoked: "已作废", expired: "已过期" };

export function MembersAdmin() {
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("lawyer");
  const [issued, setIssued] = useState<{ code: string; name: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () =>
    members
      .list()
      .then((d) => {
        setData(d);
        setErr("");
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, []);
  const invite = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await members.invite(name.trim(), role);
      setIssued({ code: r.code, name: r.member?.name ?? name.trim(), expires_at: r.expires_at });
      setName("");
      void load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg("");
    try {
      await fn();
      setMsg(ok);
      void load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (err && !data) {
    return (
      <div className="panel">
        <p className="muted">{err}</p>
      </div>
    );
  }
  const requests: any[] = data?.join_requests ?? [];
  const invitations: any[] = data?.invitations ?? [];
  return (
    <div className="device">
      <div className="panel">
        <div className="section-title">邀请同事</div>
        <p className="muted">对方在新装的 Kimi Work 里输入邀请码；你在下面核对他屏幕上的数字后批准，他就能开始使用。</p>
        <form
          className="settings-choice"
          onSubmit={(e) => {
            e.preventDefault();
            void invite();
          }}
        >
          <label className="field">
            <span>姓名</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：张律师" maxLength={40} />
          </label>
          <label className="field">
            <span>角色</span>
            <Select aria-label="角色" value={role} onChange={setRole} options={ROLES.map(([k, l]) => ({ value: k, label: l }))} />
          </label>
          <button type="submit" className="btn-primary" disabled={!name.trim() || busy}>
            {busy ? "正在生成…" : "生成邀请码"}
          </button>
        </form>
        {issued && (
          <div className="card" role="status">
            <div>
              给 {issued.name} 的邀请码（只显示这一次）：
            </div>
            <div className="members-code">{issued.code}</div>
            <div className="card-actions">
              <button className="btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText(issued.code).then(() => setMsg("已复制"))}>
                复制
              </button>
            </div>
            <p className="muted">{fmtTime(issued.expires_at)} 前有效，只能用一次。请发给对方：他在自己的电脑上安装 Kimi Work 后输入这个码，然后会打电话把屏幕上的核对码读给你，你在“等你批准”里核对后批准。</p>
          </div>
        )}
        {msg && <p className="muted">{msg}</p>}
      </div>

      <div className="panel">
        <div className="section-title">等你批准{requests.length > 0 ? `（${requests.length}）` : ""}</div>
        {requests.length === 0 ? (
          <p className="muted">没有等待批准的同事。</p>
        ) : (
          <table className="members-table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>角色</th>
                <th>申请时间</th>
                <th>核对码（请对方念出，一致再批准）</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.name ?? "（不是在这台电脑上邀请的）"}</td>
                  <td>{ROLE_LABEL[r.role] ?? r.role}</td>
                  <td>{fmtTime(r.requested_at)}</td>
                  <td className="members-check">{r.check_code}</td>
                  <td>
                    {r.local_invite && r.verified === false ? (
                      <span className="activate-error">这份申请在传送中被改动过，不要批准；请拒绝并重新发邀请，同时告知 Kimi Work 客服</span>
                    ) : r.local_invite ? (
                      <span className="settings-choice">
                        <ConfirmButton label="批准" danger={false} className="btn-primary btn-sm" question={`请先电话或当面联系${r.name ?? "对方"}，请他读出屏幕上的核对码，与这里逐位对照。号码一致吗？`} confirmLabel="已核对一致，批准" onConfirm={() => act(() => members.approve(r.id), `已批准${r.name ? ` ${r.name}` : ""}`)} />
                        <ConfirmButton label="拒绝" question={`拒绝${r.name ? ` ${r.name} ` : ""}的申请？他需要新的邀请码才能再次申请。`} confirmLabel="拒绝" onConfirm={() => act(() => members.reject(r.id), "已拒绝")} />
                      </span>
                    ) : (
                      <span className="muted">请在发出邀请的电脑上处理</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {requests.length > 0 && <p className="muted">批准前，请先电话或当面联系对方，请他读出自己屏幕上的核对码，与这里逐位对照。号码对不上？不要批准，点“拒绝”，并联系 Kimi Work 客服。</p>}
      </div>

      <MemberRoster />

      <div className="panel">
        <div className="section-title">发出的邀请</div>
        {invitations.length === 0 ? (
          <p className="muted">还没有发出邀请。</p>
        ) : (
          <table className="members-table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>角色</th>
                <th>状态</th>
                <th>有效期至</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invitations.map((x) => (
                <tr key={x.activation_id}>
                  <td>{x.name ?? "—"}</td>
                  <td>{ROLE_LABEL[x.role] ?? x.role}</td>
                  <td>{STATUS_LABEL[x.status] ?? x.status}</td>
                  <td>{fmtTime(x.expires_at)}</td>
                  <td>{(x.status === "open" || x.status === "claimed") && <ConfirmButton label="作废" question="作废后这串邀请码不能再用。" onConfirm={() => act(() => members.revokeInvitation(x.activation_id), "已作废")} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data?.firm_check_code && <p className="muted">本所核对码：{data.firm_check_code}（同事加入后，他的“设置 · 本机与安全”里应显示同一串数字）</p>}
      </div>
    </div>
  );
}

/**
 * 成员（B-10）：按中软签名的设备目录列出本所成员与他们的电脑。管理员可以停用某一台电脑（丢失、换机），或把人移出律所
 * （停用他的全部电脑、释放席位）。移出前提醒对方先在自己电脑上做“离所交接”——这台电脑看不到他自己的事项。
 */
function MemberRoster() {
  const [data, setData] = useState<{ members: RosterMember[]; can_remove: boolean } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [asking, setAsking] = useState<{ member: RosterMember; lines: string[]; ack: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    members
      .roster()
      .then((d) => {
        setData(d);
        setErr("");
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
  }, []);
  const ask = async (m: RosterMember) => {
    setMsg("");
    try {
      const p = await members.removalPreview(m.member_id);
      setAsking({ member: m, lines: removalLines({ ...p, name: memberLabel(m) }), ack: false });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const run = async (fn: () => Promise<{ note: string }>) => {
    setBusy(true);
    setMsg("");
    try {
      setMsg((await fn()).note);
      setAsking(null);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };
  if (err && !data) return null;
  const list = data?.members ?? [];
  const active = list.filter((m) => m.status === "active");
  const removed = list.filter((m) => m.status === "removed");
  const row = (m: RosterMember) => {
    const devices = m.devices.filter((d) => d.status === "active");
    return (
      <tr key={m.member_id}>
        <td>{memberLabel(m)}</td>
        <td>{ROLE_LABEL[m.role] ?? m.role}</td>
        <td>{fmtTime(m.joined_at)}</td>
        <td>
          {devices.length === 0 ? "—" : `${devices.length} 台`}
          {devices.length > 0 && (
            <details className="muted">
              <summary>电脑</summary>
              {devices.map((d) => (
                <div key={d.device_id}>
                  {fmtTime(d.created_at)} 加入{d.this_device ? "（这台）" : ""}{" "}
                  {!d.this_device && (
                    <ConfirmButton
                      label="停用这台电脑"
                      className="btn-ghost btn-danger btn-sm"
                      question={`停用后，${m.is_me ? "你的" : `${memberLabel(m)} 的`}这台电脑不能再同步、用 AI、签发或导出（上面已有的内容无法远程删除）；换新电脑需要重新申请加入。`}
                      confirmLabel="停用"
                      disabled={busy}
                      onConfirm={() => run(() => members.revokeDevice(d.device_id))}
                    />
                  )}
                </div>
              ))}
            </details>
          )}
        </td>
        <td>{memberStatusText(m)}</td>
        <td>
          {data?.can_remove && !m.is_me && m.status !== "removed" && (
            <button className="btn-ghost btn-danger btn-sm" disabled={busy} onClick={() => void ask(m)}>
              移出律所…
            </button>
          )}
          {data?.can_remove && m.status === "removed" && m.removal && !m.removal.seat_released && (
            <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => members.remove(m.member_id))}>
              现在再试一次
            </button>
          )}
        </td>
      </tr>
    );
  };
  return (
    <div className="panel">
      <div className="section-title">成员（{active.length}）</div>
      {list.length === 0 ? (
        <p className="muted">还没有取到本所的成员名单（连上中软后自动更新）。</p>
      ) : (
        <table className="members-table">
          <thead>
            <tr>
              <th>姓名</th>
              <th>角色</th>
              <th>加入时间</th>
              <th>在用电脑</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {active.map(row)}
            {removed.map(row)}
          </tbody>
        </table>
      )}
      {asking && (
        <div className="card" role="alertdialog" aria-label={`移出 ${memberLabel(asking.member)}`}>
          <div className="section-title">移出 {memberLabel(asking.member)}？</div>
          {asking.lines.map((l, i) => (
            <p key={i} className={i === 0 ? "" : "muted"}>
              {l}
            </p>
          ))}
          <label>
            <input type="checkbox" checked={asking.ack} onChange={(e) => setAsking({ ...asking, ack: e.target.checked })} /> {memberLabel(asking.member)} 已交接完，或律所决定不再等
          </label>
          <div className="card-actions">
            <button className="btn-ghost btn-danger" disabled={!asking.ack || busy} onClick={() => void run(() => members.remove(asking.member.member_id))}>
              {busy ? "正在移出…" : "移出律所"}
            </button>
            <button className="btn-ghost" onClick={() => setAsking(null)}>
              取消
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p className="muted" role="status">
          {msg}
        </p>
      )}
      {!data?.can_remove && list.length > 0 && <p className="muted">移出成员要在开通律所的那台电脑上操作（和批准新成员是同一台）；停用某一台电脑可以在任一管理员或合伙人的电脑上做。</p>}
    </div>
  );
}
