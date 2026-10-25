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
import { audienceText, bjToday, cloudStateText, daysUntil, defaultForm, dueText, dueTone, importCandidates, PERIOD_PRESETS, REMINDER_KINDS, reminderKindLabel, rejectReasonText, reminderLine, scheduleLine, dueBuckets, dueDateText, type DueBucketKey, type ImportCandidate } from "../lib/reminders.ts";
import { Select } from "../components/Select.tsx";

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
  // 操作失败要让律师看见（复核 S10B-13：原先撤销与标为已读失败时界面毫无反应）
  const markRead = async (items: ReminderInboxItem[] | "all") => {
    try {
      await api.remindersMarkRead(items === "all" ? "all" : items.map((i) => ({ reminder_id: i.reminder_id, version: i.version })));
    } catch (e) {
      setErr(`没能标为已读：${(e as Error).message}`);
    }
    notifyDataChanged();
    void load();
  };
  /** 先刷新列表，再在后台巡检一次、完成后再刷新（复核 S10B-09：网络不通时界面不停住）。 */
  const refreshThenSync = () => {
    void load();
    void api
      .remindersSync()
      .catch(() => {})
      .finally(() => void load());
  };
  // 从事项导入（v9.4 第 20 批，V9.4 主文 §3.1“期限提醒：从事项关键日期一键导入”）：关键日期与待办期限，逐条勾选后创建
  const [importing, setImporting] = useState<(ImportCandidate & { pick: boolean })[] | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const openImport = async () => {
    try {
      const ms = (await api.listMatters()).matters.filter((m) => (m.lifecycle ?? "active") === "active");
      const todos = new Map<string, { title: string; due_date?: string | null; status: string }[]>();
      for (const m of ms.slice(0, 100)) {
        try {
          todos.set(m.matter_id, (await api.todos(m.matter_id)).open);
        } catch {
          // 读不到某个事项的待办：只导入它的关键日期
        }
      }
      const existing = new Set((data?.reminders ?? []).map((r) => `${r.matter_id}|${r.due_date}|${r.note}`));
      setImporting(importCandidates(ms, todos, existing, bjToday()).map((c) => ({ ...c, pick: true })));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const doImport = async () => {
    if (!importing) return;
    setImportBusy(true);
    let n = 0;
    try {
      for (const c of importing.filter((x) => x.pick)) {
        await api.reminderCreate({ matter_id: c.matter_id, ...defaultForm(), kind: c.kind, due_date: c.due_date, note: c.label });
        n += 1;
      }
      setImporting(null);
      refreshThenSync();
    } catch (e) {
      setErr(`导入了 ${n} 条后出错：${(e as Error).message}`);
    } finally {
      setImportBusy(false);
    }
  };
  const buckets = dueBuckets(data?.reminders ?? []);
  const unread = data?.inbox.filter((i) => !i.read_at) ?? [];
  const read = data?.inbox.filter((i) => !!i.read_at).slice(0, 20) ?? [];
  const retry = (id: string) => void api.reminderRetry(id).then(refreshThenSync, (e) => setErr((e as Error).message));
  const cancel = async (id: string) => {
    try {
      await api.reminderCancel(id);
    } catch (e) {
      setErr(`没能撤销：${(e as Error).message}`);
      return;
    }
    refreshThenSync();
  };
  return (
    <main className="main">
      <div className="main-wide">
        <div className="page-head">
          <h1 className="page-title">期限提醒</h1>
          <div className="page-head-actions">
            <button className="btn-ghost" onClick={() => void openImport()}>
              从事项导入
            </button>
            <button className="btn-primary" onClick={() => setEditing({})}>
              设提醒
            </button>
          </div>
        </div>
        {err && <div className="banner banner-red">{err}</div>}
        {data && (
          <div className="muted reminders-note">
            {/* Z3 #18 / 3.6：按是否连接各写一句，机制说明收进折叠 */}
            <p>{reminderLine(data.cloud.configured)}</p>
            <details>
              <summary>提醒是怎么送到的</summary>
              {data.cloud.configured
                ? "电脑关机时，由提醒服务送到你的其他设备（选了“事项成员”的也送到他们的设备）。服务方只知道提醒时间和接收设备，期限类型、事项和备注在这台电脑上加密，服务方看不到。"
                : "只在这台电脑上提醒：关机或没打开 Kimi Work 时不会提醒。"}
              {/* 复核 S10B-06：提醒只保存在建立它的电脑上 */}
              {" 提醒保存在这台电脑上：换电脑要重新设置；这台电脑停用后，它设的提醒在其他设备上也不再响。"}
            </details>
            {data.cloud.configured && data.cloud.last && !data.cloud.last.ok && <p>发到其他设备的提醒暂时没送出，稍后自动再试；这台电脑照常提醒。</p>}
          </div>
        )}
        {data && data.rejected.length > 0 && (
          <p className="muted">
            另有 {data.rejected.reduce((n, r) => n + r.count, 0)} 条别的设备送来的提醒因核对不通过没有显示（{[...new Set(data.rejected.map((r) => rejectReasonText(r.reason)))].join("；")}）。
          </p>
        )}

        {/* 新到的提醒在最上面；看过的收到页底（第 27 批：没有新提醒时不再在页首占一节写“还没有到时的提醒”） */}
        {unread.length > 0 && (
          <>
            <div className="page-head reminder-section-head">
              <div className="section-title">新提醒（{unread.length}）</div>
              {unread.length > 1 && (
                <button className="btn-link" onClick={() => void markRead("all")}>
                  全部标为已读
                </button>
              )}
            </div>
            <div className="reminder-list">
              {unread.map((i) => (
                <InboxRow key={`${i.reminder_id}:${i.version}`} item={i} onRead={() => void markRead([i])} />
              ))}
            </div>
          </>
        )}

        {/* 按到期日看期限（第 27 批，评审 U2-36）：今天 / 7 天内 / 以后在前，已过期收起——律师按日程看，不按提醒来源看 */}
        <div className="section-title">我设的期限</div>
        {data && data.reminders.length === 0 && (
          <p className="muted">
            还没有设提醒。可以在这里设，也可以{" "}
            <button className="btn-link" onClick={() => void openImport()}>
              从事项的开庭日、待办期限导入
            </button>
            。
          </p>
        )}
        {importing && (
          <Modal title="从事项导入期限" onClose={() => setImporting(null)}>
            {importing.length === 0 ? (
              <p className="muted">事项里没有还没设提醒的未来日期（关键日期或待办期限）。</p>
            ) : (
              <div className="reminder-import">
                {importing.map((c, i) => (
                  <label key={`${c.matter_id}${c.due_date}${c.label}`} className="lifecycle-check">
                    <input type="checkbox" checked={c.pick} onChange={(e) => setImporting(importing.map((x, j) => (j === i ? { ...x, pick: e.target.checked } : x)))} />
                    {c.due_date} · {reminderKindLabel(c.kind)} · {c.label} <span className="muted">（{c.matter_title}{c.source === "todo" ? " · 待办" : ""}）</span>
                  </label>
                ))}
              </div>
            )}
            <p className="muted">按“提前 3 天、上午 9 点、只提醒我”创建，之后可以逐条修改。日期以事项里填的为准，请核对。</p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setImporting(null)}>取消</button>
              <button className="btn-primary" disabled={importBusy || !importing.some((x) => x.pick)} onClick={() => void doImport()}>
                导入 {importing.filter((x) => x.pick).length} 条
              </button>
            </div>
          </Modal>
        )}
        {data && data.reminders.length > 0 && buckets.every((b) => b.key === "past") && <p className="muted">没有还没到期的提醒。</p>}
        {data && buckets.some((b) => b.key !== "past") && (
          <ReminderTable groups={buckets.filter((b) => b.key !== "past")} cloudConfigured={data.cloud.configured} onEdit={(r) => setEditing({ reminder: r })} onRetry={retry} onCancel={cancel} />
        )}
        {data &&
          buckets
            .filter((b) => b.key === "past")
            .map((b) => (
              <details key={b.key} className="reminder-group">
                <summary>已过期（{b.items.length}）</summary>
                <ReminderTable groups={[b]} cloudConfigured={data.cloud.configured} onEdit={(r) => setEditing({ reminder: r })} onRetry={retry} onCancel={cancel} />
              </details>
            ))}

        {read.length > 0 && (
          <details className="reminder-group">
            <summary>看过的提醒（{read.length}）</summary>
            <div className="reminder-list">
              {read.map((i) => (
                <InboxRow key={`${i.reminder_id}:${i.version}`} item={i} onRead={() => void markRead([i])} />
              ))}
            </div>
          </details>
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
            refreshThenSync();
          }}
        />
      )}
    </main>
  );
}

/** 期限表（第 27 批：按到期日分组，一张表、组名作分组行，列与原来相同）。 */
function ReminderTable({ groups, cloudConfigured, onEdit, onRetry, onCancel }: { groups: { key: DueBucketKey; label: string; items: ReminderItem[] }[]; cloudConfigured: boolean; onEdit: (r: ReminderItem) => void; onRetry: (id: string) => void; onCancel: (id: string) => Promise<void> }) {
  // 没连提醒服务时每行“电脑关机时”都是同一句：不成列，页首已说一次（第 27 批，评审 U3-28 / 规则 5）
  const showCloud = cloudConfigured;
  const cols = showCloud ? 5 : 4;
  return (
    <table className="data reminder-table">
      <thead>
        <tr>
          <th>期限</th>
          <th>事项</th>
          <th>提醒</th>
          {showCloud && <th>电脑关机时</th>}
          <th />
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.key}>
          {groups.length > 1 || g.key !== "past" ? (
            <tr className={`reminder-bucket-row bucket-${g.key}`}>
              <td colSpan={cols}>
                {g.label}
                <span className="muted">（{g.items.length}）</span>
              </td>
            </tr>
          ) : null}
          {g.items.map((r) => {
            const cs = cloudStateText(r.cloud_state, cloudConfigured, { targets: r.cloud_targets, audience: r.audience });
            // 已结案的事项、期限已过的提醒只能撤销（复核 S10B-08）
            const editable = r.matter_lifecycle === "active" && daysUntil(r.due_date) >= 0;
            return (
              <tr key={r.reminder_id}>
                <td>
                  <div className="reminder-when" title={r.due_date}>
                    <span className="nowrap">{dueDateText(r.due_date)} · {reminderKindLabel(r.kind)}</span>
                    <span className={`pill ${dueTone(r.due_date) === "red" ? "pill-red" : dueTone(r.due_date) === "orange" ? "pill-orange" : "pill-gray"}`}>{dueText(r.due_date)}</span>
                  </div>
                  {r.note && <div className="muted reminder-note">{r.note}</div>}
                </td>
                <td>
                  <button className="btn-link" onClick={() => nav(`/matter/${r.matter_id}`)}>
                    {r.matter_title}
                  </button>
                </td>
                <td>
                  <div>{scheduleLine(r)}</div>
                  {/* “只提醒我”是缺省，每行都写就成了噪音：只在也提醒事项成员时写（第 27 批，评审 U3-28） */}
                  {r.audience !== "me" && <div className="muted">{audienceText(r.audience, r.collab_scope === "team")}</div>}
                </td>
                {showCloud && (
                  <td className={cs.tone === "warn" ? "reminder-warn" : "muted"}>
                    {cs.text}
                    {r.cloud_state === "failed" && (
                      <button className="btn-link" onClick={() => onRetry(r.reminder_id)}>
                        重试
                      </button>
                    )}
                  </td>
                )}
                <td>
                  {/* 按钮放在格子里的一层 div 上：td 本身不设 flex（原来设了，单元格边框与行错位） */}
                  <div className="reminder-actions">
                    {editable && (
                      <button className="btn-ghost" onClick={() => onEdit(r)}>
                        修改
                      </button>
                    )}
                    <ConfirmButton label="撤销" question="撤销后这条提醒不再响；已发到其他设备的也一并撤回。" confirmLabel="撤销提醒" onConfirm={() => onCancel(r.reminder_id)} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}

function InboxRow({ item, onRead }: { item: ReminderInboxItem; onRead: () => void }) {
  const tone = dueTone(item.due_date);
  return (
    <div className={`panel reminder-card${item.read_at ? " read" : ""}`}>
      <div className="reminder-card-main">
        <div>
          <strong>{reminderKindLabel(item.kind)}</strong> · <span title={item.due_date}>{dueDateText(item.due_date)}</span>{" "}
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
  // 只读成员只能提醒自己（复核 S10B-12）；事项信息没取到时不改动原来的通知对象（不悄悄降级）
  const role = reminder?.my_role ?? matter?.my_role ?? null;
  const team = matter ? matter.collab_scope === "team" && role !== "viewer" : reminder ? reminder.collab_scope === "team" && role !== "viewer" : false;
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const input = { ...f, audience: team || (!matter && reminder) ? f.audience : "me" } as const;
      if (reminder) await api.reminderUpdate(reminder.reminder_id, input);
      else await api.reminderCreate(input);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // 按法定期间推算（v9.4 第 20 批）：起算日 + 常用期间 → 内核 calc.deadline 算出届满日并附过程，律师点“用这个日期”才填入
  const [calc, setCalc] = useState<{ start: string; preset: string; result: Awaited<ReturnType<typeof api.computeDeadline>> | null; err: string }>({ start: "", preset: PERIOD_PRESETS[0]!.id, result: null, err: "" });
  const runCalc = async () => {
    const p = PERIOD_PRESETS.find((x) => x.id === calc.preset)!;
    try {
      const r = await api.computeDeadline(calc.start.trim(), { unit: p.unit, n: p.n });
      setCalc({ ...calc, result: r, err: "" });
    } catch (e) {
      setCalc({ ...calc, result: null, err: (e as Error).message });
    }
  };
  const noteLen = [...f.note].length;
  return (
    <Modal title={reminder ? "修改提醒" : "设提醒"} onClose={onClose}>
      <div className="form-grid">
        <label className="field field-wide">
          <span>事项</span>
          <Select value={f.matter_id} disabled={!!reminder} onChange={(v) => setF({ ...f, matter_id: v })} placeholder={matters.length === 0 ? "（没有进行中的事项）" : "请选择事项"} options={matters.map((m) => ({ value: m.matter_id, label: m.title }))} />
        </label>
        <label className="field">
          <span>期限类型</span>
          <Select value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={REMINDER_KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        </label>
        <label className="field">
          <span>期限日</span>
          <input type="date" min={bjToday()} value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} />
        </label>
        {!reminder && (
          <details className="field field-wide deadline-calc">
            <summary>按法定期间推算期限日</summary>
            <div className="deadline-calc-row">
              <input value={calc.start} onChange={(e) => setCalc({ ...calc, start: e.target.value, result: null })} placeholder="起算日，如 2026-11-03（送达日等）" aria-label="起算日" />
              <Select aria-label="期间" value={calc.preset} onChange={(v) => setCalc({ ...calc, preset: v, result: null })} options={PERIOD_PRESETS.map((p) => ({ value: p.id, label: p.label }))} />
              <button className="btn btn-sm" disabled={!calc.start.trim()} onClick={() => void runCalc()}>推算</button>
            </div>
            {calc.err && <div className="banner banner-red">{calc.err}</div>}
            {calc.result && (
              <div className="deadline-calc-result">
                {calc.result.deadline ? (
                  <p>
                    届满日 <b>{calc.result.deadline}</b>{" "}
                    {calc.result.deadline > bjToday() ? (
                      <button className="btn-link" onClick={() => { const p = PERIOD_PRESETS.find((x) => x.id === calc.preset)!; setF({ ...f, due_date: calc.result!.deadline!, kind: p.kind, note: f.note || p.label.replace(/（.*）/, "") }); }}>
                        用这个日期
                      </button>
                    ) : (
                      <span className="muted">已经过了</span>
                    )}
                  </p>
                ) : (
                  <p>起算日只到月：届满日在 {calc.result.range?.earliest} 至 {calc.result.range?.latest} 之间，查清具体日期后再推算。</p>
                )}
                <ul className="muted">
                  {calc.result.steps.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
                {(calc.result.warnings ?? []).map((w, i) => (
                  <div key={i} className="banner banner-orange">{w}</div>
                ))}
                <p className="muted">期间规则以法律规定为准；不含在途时间、中止与中断。起算事实请你确认。</p>
              </div>
            )}
          </details>
        )}
        <label className="field">
          <span>提前几天提醒</span>
          <Select value={String(f.days_before)} onChange={(v) => setF({ ...f, days_before: Number(v) })} options={DAYS_CHOICES.map((d) => ({ value: String(d), label: d === 0 ? "当天" : `提前 ${d} 天` }))} />
        </label>
        <label className="field">
          <span>几点提醒（北京时间）</span>
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
            {!team && <span className="muted">{role === "viewer" ? "（你在这个事项里是只读成员，只能提醒自己）" : "（个人事项只有你一人）"}</span>}
          </label>
        </div>
      </div>
      {reminder?.fired && <div className="banner banner-orange">这条提醒已经响过：保存后会按新的时间再提醒一次{reminder.audience === "team" ? "（事项成员也会再收到）" : ""}。</div>}
      <p className="muted">期限日由你核对填写；用“按法定期间推算”时，系统按民法典的期间规则算并顺延节假日，过程列在上面。提醒保存在这台电脑上，换电脑需要重新设置。</p>
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
