/**
 * 设置 → 本机与安全 → 离所同事（复核 R15A-05）：你负责的团队事项里，还有电脑已全部停用的成员（多为离所、也可能在换电脑）。
 * 移出他会换新的事项密钥（界面不讲密钥），他手里的旧电脑拿不到此后的新内容；还在换电脑的同事等新电脑到位后再加回即可。没有这样的成员时不显示。
 */
import { useEffect, useState } from "react";
import { members } from "../api.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { memberLabel } from "../lib/offboarding.ts";

export function DepartedMembers() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof members.departedInMatters>>["items"]>([]);
  const [msg, setMsg] = useState("");
  const load = () =>
    members
      .departedInMatters()
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  useEffect(() => {
    void load();
  }, []);
  if (items.length === 0 && !msg) return null;
  return (
    <div className="device-row">
      <div className="device-k">离所同事</div>
      <div>
        <div className="muted">下面这些同事的电脑都已停用，但还在你负责的事项里。确认他已离所后移出：移出后，他手里的旧电脑拿不到此后的新内容。</div>
        {items.map((x) => (
          <div key={`${x.matter_id}-${x.user_id}`}>
            「{x.title}」· {memberLabel({ name: x.name, member_id: x.user_id, is_me: false })}
            {x.removed_from_firm ? "（已移出律所）" : ""}{" "}
            <ConfirmButton
              label="移出事项"
              className="btn-ghost btn-danger btn-sm"
              question={`确认 ${memberLabel({ name: x.name, member_id: x.user_id, is_me: false })} 已离所？移出后他的旧电脑拿不到此后的新内容；如果他只是在换电脑，等新电脑到位后再把他加回来。`}
              confirmLabel="已离所，移出"
              onConfirm={async () => {
                try {
                  await members.removeDepartedFromMatter(x.matter_id, x.user_id);
                  setMsg("已移出：他的旧电脑拿不到此后的新内容");
                } catch (e) {
                  setMsg((e as Error).message);
                }
                void load();
              }}
            />
          </div>
        ))}
        {msg && (
          <p className="muted" role="status">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
