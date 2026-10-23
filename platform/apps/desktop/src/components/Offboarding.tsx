/**
 * 设置 → 本机与安全 → 离所交接（v9.3 第 14 批续 B-10）：要离开本所的人，在自己电脑上把负责的事项交接好，再请管理员移出。
 * 只在这台电脑上的事项：导出归档交给律所。同事一起办的事项：交给一位同事做负责人（同事之间同步的管理权一并交出）。
 * 每台电脑只知道自己参与的事项，所以这一步只能本人做；平时收起，点开才查。
 */
import { useState } from "react";
import { api, members, type OffboardingItem } from "../api.ts";
import { memberLabel, offboardArchiveName, offboardingRow, offboardingSummary } from "../lib/offboarding.ts";
import { fmtTime } from "../lib/labels.ts";
import { Select } from "./Select.tsx";

export function Offboarding() {
  const [data, setData] = useState<{ matters: OffboardingItem[]; pending: number; personal?: { writing_prefs: boolean; qa_conversations: number } } | null>(null);
  const [personalNote, setPersonalNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pick, setPick] = useState<Record<string, string>>({});
  const load = () =>
    members
      .offboarding()
      .then((d) => {
        setData(d);
        setErr("");
      })
      .catch((e: Error) => setErr(e.message));
  const act = async (matterId: string, fn: () => Promise<string | null>) => {
    setBusy(matterId);
    try {
      const note = await fn();
      if (note) setNotes((n) => ({ ...n, [matterId]: note }));
      await load();
    } catch (e) {
      setNotes((n) => ({ ...n, [matterId]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  };
  const archive = (it: OffboardingItem) =>
    act(it.matter_id, async () => {
      const r = await api.archiveMatter(it.matter_id, offboardArchiveName(it.matter_id));
      return r ? `已导出：${r.filename}（里面是明文案卷）。请交给律所或接手的同事保管，不要存到个人网盘。` : null;
    });
  const handoff = (it: OffboardingItem, to: string) => act(it.matter_id, async () => (await members.offboardHandoff(it.matter_id, to)).note);
  const clearPersonal = async () => {
    setBusy("personal");
    try {
      setPersonalNote((await members.offboardClearPersonal()).note);
      await load();
    } catch (e) {
      setPersonalNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="device-row">
      <div className="device-k">离所交接</div>
      <div>
        <details onToggle={(e) => (e.target as HTMLDetailsElement).open && !data && void load()}>
          <summary className="muted">要离开本所？离开前在这里把你负责的事项交接好（点开查看）</summary>
          {err && <p className="activate-error">{err}</p>}
          {data && <p>{offboardingSummary(data)}</p>}
          {data && data.matters.length > 0 && (
            <table className="members-table">
              <thead>
                <tr>
                  <th>事项</th>
                  <th>现在</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.matters.map((it) => {
                  const row = offboardingRow(it);
                  const to = pick[it.matter_id] ?? row.candidates[0]?.user_id ?? "";
                  return (
                    <tr key={it.matter_id}>
                      <td>{it.title}</td>
                      <td>
                        {row.action === "none" ? "✓ " : ""}
                        {row.state}
                        {it.archived_at && row.action === "none" && <span className="muted">（{fmtTime(it.archived_at)}）</span>}
                        {notes[it.matter_id] && <div className="muted" role="status">{notes[it.matter_id]}</div>}
                      </td>
                      <td>
                        {row.action === "archive" && (
                          <button className="btn-ghost btn-sm" disabled={busy !== null} onClick={() => void archive(it)}>
                            {busy === it.matter_id ? "正在导出…" : "导出归档"}
                          </button>
                        )}
                        {row.action === "handoff" &&
                          (row.candidates.length === 0 ? (
                            <span className="muted">没有可以接手的负责人：请先在事项里把一位同事设为负责人</span>
                          ) : (
                            <span className="settings-choice">
                              <Select
                                aria-label="交给谁"
                                value={to}
                                onChange={(v) => setPick((p) => ({ ...p, [it.matter_id]: v }))}
                                options={row.candidates.map((c) => ({ value: c.user_id, label: memberLabel({ name: c.name, member_id: c.user_id, is_me: false }) }))}
                              />
                              <button className="btn-ghost btn-sm" disabled={busy !== null || !to} onClick={() => void handoff(it, to)}>
                                {busy === it.matter_id ? "正在交接…" : "交给他"}
                              </button>
                            </span>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {/* 最后一步：按人存在这台电脑上的写作偏好与问答记录（复核 Q4 建议 3）。事项的材料与成果按律所留存规则处理，这里不删 */}
          {data && (() => {
            const p = data.personal;
            const what = [p?.writing_prefs ? "写作偏好（落款、法条引用写法等）" : "", p && p.qa_conversations > 0 ? `${p.qa_conversations} 个问答记录` : ""].filter(Boolean);
            return (
              <p>
                {what.length > 0 ? (
                  <>
                    你的{what.join("和")}还在这台电脑上。交还电脑前请清除：{" "}
                    <button className="btn-ghost btn-sm" disabled={busy !== null} onClick={() => void clearPersonal()}>
                      {busy === "personal" ? "正在清除…" : "清除"}
                    </button>
                    {personalNote && <span className="muted" role="status"> {personalNote}</span>}
                  </>
                ) : (
                  <span className="muted">{personalNote || "这台电脑上没有你的写作偏好和问答记录。"}</span>
                )}
              </p>
            );
          })()}
        </details>
      </div>
    </div>
  );
}
