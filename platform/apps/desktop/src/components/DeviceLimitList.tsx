/**
 * 电脑数已满（第 68 批，V42，D-295）：每个账号能同时登录的电脑数由云端设定；满了时列出这个账号已登记的电脑，
 * 云端支持时可就地移除一台（凭刚完成的这次登录，云端核对 10 分钟内、会话还没绑任何电脑），移除后直接继续，不必再收一次验证码。
 * 开通页（待激活）与重新登录页（换账号）共用。
 */
import { useState } from "react";
import { dayLabel, deviceLine, type AccountDevice } from "../lib/account.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";

export function DeviceLimitList(p: { devices: AccountDevice[]; canUnbind: boolean; onUnbind: (deviceId: string) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  if (p.devices.length === 0) return null;
  return (
    <div className="auth-devlimit">
      <div className="section-title">这个账号已登记的电脑</div>
      <ul className="auth-devices">
        {p.devices.map((d) => {
          const l = deviceLine(d);
          return (
            <li key={d.device_id} className="auth-device-row">
              <span className="auth-device-text">
                <b>{l.title}</b>
                <span className="muted">{l.meta || `${dayLabel(d.registered_at)}登记`}</span>
              </span>
              {p.canUnbind && (
                <ConfirmButton
                  label={busy === d.device_id ? "正在移除…" : "移除"}
                  question="移除后那台电脑上这个账号会退出登录，AI 停用；那台电脑上的本机资料不会删除，之后在那台电脑上重新登录即可再用。"
                  confirmLabel="移除并继续"
                  disabled={busy !== null}
                  onConfirm={async () => {
                    setBusy(d.device_id);
                    setErr("");
                    try {
                      await p.onUnbind(d.device_id);
                    } catch (e) {
                      setErr((e as Error).message || "没有移除成功，请稍后重试");
                    } finally {
                      setBusy(null);
                    }
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      <p className="muted auth-devlimit-hint">
        {p.canUnbind ? "移除一台不再使用的电脑后，这台电脑会自动继续登录。" : "移除旧电脑：在那台电脑上打开“设置 → 账号”，或在云端控制台“我的电脑”里移除。"}
      </p>
    </div>
  );
}
