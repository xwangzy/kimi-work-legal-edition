/**
 * 期限提醒（第 10 批 S9；v9 #51、K7）：收到的提醒 + 我设的提醒 + 设提醒表单。
 * 到时由本机提醒；配置了中软通知服务时，电脑关机也会送到本人的其他设备与事项成员——中软只知道提醒时间与接收设备，内容在本机加密。
 */
import { useEffect, useState } from "react";
import { api, onKernelEvent, type Matter, type ReminderInboxItem, type ReminderInput, type ReminderItem } from "../api.ts";
import { nav } from "../App.tsx";
import { Modal } from "../components/Modal.tsx";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { notifyDataChanged } from "../lib/events.ts";
import { audienceText, cloudStateText, defaultForm, dueText, dueTone, REMINDER_KINDS, reminderKindLabel, scheduleLine } from "../lib/reminders.ts";

const DAYS_CHOICES = [0, 1, 2, 3, 5, 7, 10, 14, 30];

type ListData = Awaited<ReturnType<typeof api.reminders>>;

export function RemindersPage({ newForMatter }: { newForMatter?: string }) {
  const [data, setData] = useState<ListData | null>(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<{ reminder?: ReminderItem; matterId?: string } | null>(newForMatter ? { matterId: newForMatter } : null);
  const load = () =>
    api
      .reminders()
      .then((r) => {
        setData(r);
        setErr("");
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    void load();
    return onKernelEvent((m) => (m?.type === "reminder.due" ? void load() : undefined));
  }, []);
  useEffect(() => {
    if (newForMatter) setEditing({ matterId: newForMatter });
  }, [newForMatter]);
  const markRead = async (items: ReminderInboxItem[] | "all") => {
    await api.remindersMarkRead(items === "all" ? "all" : items.map((i) => ({ reminder_id: i.reminder_id, version: i.version }))).catch(() => {});
    notifyDataChanged();
    void load();
  };
  const unread = data?.inbox.filter((i) => !i.read_at) ?? [];
  const read = data?.inbox.filter((i) => !!i.read_at).slice(0, 20) ?? [];
  return (
    <main className="main">
      <div className="main-wide">
        <div className="page-head">
          <h1 className="page-title">期限提醒</h1>
          <button className="btn-primary" onClick={() => setEditing({})}>
            设提醒
          </button>
        </div>
        {err && <div className="banner banner-red">{err}</div>}
        {data && (
          <p className="muted">
            {data.cloud.configured
              ? "到时在这台电脑上提醒；电脑关机时，由中软通知服务送到你的其他设备（选了“事项成员”的也送到他们的设备）。中软只知道提醒时间和接收设备，期限类型、事项和备注在这台电脑上加密，中软看不到。"
              : "到时在这台电脑上提醒。没有连接中软通知服务：电脑关机或应用没开时不会提醒。"}
            {data.cloud.configured && data.cloud.last && !data.cloud.last.ok && " 刚才没能连上中软通知服务，联网后自动重试。"}
          </p>
        )}

        <div className="page-head reminder-section-head">
          <div className="section-title">收到的提醒{unread.length > 0 ? `（${unread.length} 条未读）` : ""}</div>
          {unread.length > 1 && (
            <button className="btn-link" onClick={() => void markRead("all")}>
              全部标为已读
            </button>
          )}
        </div>
        {data && data.inbox.length === 0 && <p className="muted">还没有到时的提醒。</p>}
        <div className="reminder-list">
          {[...unread, ...read].map((i) => (
            <InboxRow key={`${i.reminder_id}:${i.version}`} item={i} onRead={() => void markRead([i])} />
          ))}
        </div>

        <div className="section-title">我设的提醒</div>
        {data && data.reminders.length === 0 && <p className="muted">还没有设提醒。可以在这里设，也可以在事项页的“设提醒”里设。</p>}
        {data && data.reminders.length > 0 && (
          <table className="data reminder-table">
            <thead>
              <tr>
                <th>期限</th>
                <th>事项</th>
                <th>提醒</th>
                <th>电脑关机时</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.reminders.map((r) => {
                const cs = cloudStateText(r.cloud_state, data.cloud.configured);
                return (
                  <tr key={r.reminder_id}>
                    <td>
                      <div>
                        {reminderKindLabel(r.kind)} · {r.due_date}
                      </div>
                      <span className={`pill ${dueTone(r.due_date) === "red" ? "pill-red" : dueTone(r.due_date) === "orange" ? "pill-orange" : "pill-gray"}`}>{dueText(r.due_date)}</span>
                      {r.note && <div className="muted reminder-note">{r.note}</div>}
                    </td>
                    <td>
                      <button className="btn-link" onClick={() => nav(`/matter/${r.matter_id}`)}>
                        {r.matter_title}
                      </button>
                    </td>
                    <td>
                      <div>{scheduleLine(r)}</div>
                      <div className="muted">{audienceText(r.audience, r.collab_scope === "team")}</div>
                    </td>
                    <td className={cs.tone === "warn" ? "reminder-warn" : "muted"}>{cs.text}</td>
                    <td className="reminder-actions">
                      <button className="btn-ghost" onClick={() => setEditing({ reminder: r })}>
                        修改
                      </button>
                      <ConfirmButton
                        label="撤销"
                        question="撤销后这条提醒不再响；交给中软通知服务的也一并删除。"
                        confirmLabel="撤销提醒"
                        onConfirm={async () => {
                          await api.reminderCancel(r.reminder_id);
                          await api.remindersSync().catch(() => {});
                          void load();
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <ReminderForm
          reminder={editing.reminder}
          matterId={editing.matterId}
          onClose={() => {
            setEditing(null);
            if (newForMatter) nav("/reminders");
          }}
          onSaved={() => {
            setEditing(null);
            if (newForMatter) nav("/reminders");
            // 先完成一次巡检再刷新（联调：否则刚保存的那条总显示“正在交给中软通知服务…”）
            void api.remindersSync().catch(() => {}).finally(() => void load());
          }}
        />
      )}
    </main>
  );
}

function InboxRow({ item, onRead }: { item: ReminderInboxItem; onRead: () => void }) {
  const tone = dueTone(item.due_date);
  return (
    <div className={`panel reminder-card${item.read_at ? " read" : ""}`}>
      <div className="reminder-card-main">
        <div>
          <strong>{reminderKindLabel(item.kind)}</strong> · {item.due_date}{" "}
          <span className={`pill ${tone === "red" ? "pill-red" : tone === "orange" ? "pill-orange" : "pill-gray"}`}>{dueText(item.due_date)}</span>
        </div>
        <div className="muted">
          {item.matter_title ? (
            <button className="btn-link" onClick={() => nav(`/matter/${item.matter_id}`)}>
              {item.matter_title}
            </button>
          ) : (
            "（这台电脑上没有这个事项）"
          )}
          {!item.from_me && ` · ${item.from_name ?? "事项成员"}设的提醒`}
        </div>
        {item.note && <div className="reminder-note">{item.note}</div>}
      </div>
      {!item.read_at && (
        <button className="btn-ghost" onClick={onRead}>
          知道了
        </button>
      )}
    </div>
  );
}

function ReminderForm({ reminder, matterId, onClose, onSaved }: { reminder?: ReminderItem | undefined; matterId?: string | undefined; onClose: () => void; onSaved: () => void }) {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [f, setF] = useState<ReminderInput & { matter_id: string }>(() =>
    reminder
      ? { matter_id: reminder.matter_id, kind: reminder.kind, due_date: reminder.due_date, days_before: reminder.days_before, remind_time: reminder.remind_time, note: reminder.note, audience: reminder.audience }
      : { matter_id: matterId ?? "", ...defaultForm() },
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api
      .listMatters()
      .then((r) => {
        const active = r.matters.filter((m) => (m.lifecycle ?? "active") === "active");
        setMatters(active);
        setF((x) => (x.matter_id ? x : { ...x, matter_id: active[0]?.matter_id ?? "" }));
      })
      .catch(() => {});
  }, []);
  const matter = matters.find((m) => m.matter_id === f.matter_id);
  const team = matter?.collab_scope === "team";
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const input = { ...f, audience: team ? f.audience : "me" } as const;
      if (reminder) await api.reminderUpdate(reminder.reminder_id, input);
      else await api.reminderCreate(input);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const noteLen = [...f.note].length;
  return (
    <Modal title={reminder ? "修改提醒" : "设提醒"} onClose={onClose}>
      <div className="form-grid">
        <label className="field field-wide">
          <span>事项</span>
          <select value={f.matter_id} disabled={!!reminder} onChange={(e) => setF({ ...f, matter_id: e.target.value })}>
            {matters.length === 0 && <option value="">（没有进行中的事项）</option>}
            {matters.map((m) => (
              <option key={m.matter_id} value={m.matter_id}>
                {m.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>期限类型</span>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {REMINDER_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>期限日</span>
          <input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} />
        </label>
        <label className="field">
          <span>提前几天提醒</span>
          <select value={f.days_before} onChange={(e) => setF({ ...f, days_before: Number(e.target.value) })}>
            {DAYS_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d === 0 ? "当天" : `提前 ${d} 天`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>几点提醒</span>
          <input type="time" value={f.remind_time} onChange={(e) => setF({ ...f, remind_time: e.target.value })} />
        </label>
        <label className="field field-wide">
          <span>备注（可不填，{noteLen}/200 字）</span>
          <textarea rows={2} maxLength={200} value={f.note} placeholder="例如：带齐证据原件；提交补充证据目录" onChange={(e) => setF({ ...f, note: e.target.value })} />
        </label>
        <div className="field field-wide" role="radiogroup" aria-label="提醒谁">
          <span>提醒谁</span>
          <label className="consent-opt">
            <input type="radio" name="aud" checked={f.audience === "me" || !team} onChange={() => setF({ ...f, audience: "me" })} /> 只提醒我
          </label>
          <label className={`consent-opt${team ? "" : " disabled"}`}>
            <input type="radio" name="aud" disabled={!team} checked={team && f.audience === "team"} onChange={() => setF({ ...f, audience: "team" })} /> 提醒事项全体成员
            {!team && <span className="muted">（个人事项只有你一人）</span>}
          </label>
        </div>
      </div>
      <p className="muted">期限日由你核对填写，系统不推算法定期间、不顺延节假日。</p>
      {err && <div className="banner banner-red">{err}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn-primary" disabled={busy || !f.matter_id || !f.due_date} onClick={() => void save()}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </Modal>
  );
}
