/**
 * 同时登录的电脑已达上限（第 68 批 D-295 起；第 69 批 D-297“选一台移除”；第 71 批 V45 D-298 重做为“选一台让它退出登录”）。
 *
 * 每个账号能**同时登录**的电脑数由云端设定，客户端不另设限制、也不做判定。满了时这里整卡显示：
 * - 列出这个账号的电脑：名字或类型、最近使用、状态（登录中 / 已退出登录 / 这台电脑）；只有登录中的电脑占名额；
 * - 默认动作是**让它退出登录**（可逆）：那台电脑上的事项和成果都还在，之后在那台电脑上重新登录即可；默认预选登录中最久没用的一台；
 * - “移除”是次要动作（电脑丢了、转手或不再使用）：吊销后那台电脑不能再用这个账号；登记数到了封顶（limit_kind = registered）时只能移除；
 * - 都用刚完成的这次登录（10 分钟内、一次性票据），不必再输一次密码或再收一次验证码；不自动替换（D-297/D-298 的理由见研究目录 04）。
 * 云端不支持让出（旧云端）时退回只能移除；连移除也不支持（网页会话等）时只列出，说明去哪里处理。
 * 开通页（新电脑）、重新登录页（这台已登记的电脑、换账号）共用。
 *
 * 第 72 批（D-303）重做信息架构：页头一句结论“已在 N 台电脑登录”+ 一句怎么办；账号身份（姓名 · 打码手机号）缩成页头下一行小字；
 * 设备卡：名称一行 + 状态，元信息一行“8 分钟前用过 · 0.10.0”（不截断、不堆登记时间）；整卡可点，选中用描边 + 勾；
 * 主按钮短而确定“退出所选电脑并继续”（电脑名只在列表里出现一次）；按钮上方一行后果；“改为移除”是唯一的次要链接。
 */
import { useMemo, useState } from "react";
import { defaultRemovalPick, defaultSignoutPick, deviceChoiceLine, deviceMetaShort, deviceState, thisDeviceLine, type AccountDevice } from "../lib/account.ts";
import { Icon } from "./Icons.tsx";

type Mode = "signout" | "remove";

export function DeviceLimitList(p: {
  devices: AccountDevice[];
  canUnbind: boolean;
  canSignout?: boolean;
  limit?: number | null;
  limitKind?: "signed_in" | "registered" | null;
  thisDevice?: string | null;
  who?: string | null;
  onUnbind: (deviceId: string) => Promise<void>;
  onSignout?: (deviceId: string) => Promise<void>;
  onBack: () => void;
}) {
  const thisDevice = p.thisDevice ?? null;
  const registeredCap = p.limitKind === "registered";
  const signoutOk = p.canSignout === true && !!p.onSignout && !registeredCap && defaultSignoutPick(p.devices, thisDevice) !== null;
  const [mode, setMode] = useState<Mode>(signoutOk ? "signout" : "remove");
  const removable = useMemo(() => p.devices.filter((d) => d.device_id !== thisDevice && deviceState(d) !== "revoked"), [p.devices, thisDevice]);
  const firstPick = (m: Mode) => (m === "signout" ? defaultSignoutPick(p.devices, thisDevice) : p.canUnbind ? defaultRemovalPick(removable) : null);
  const [pick, setPick] = useState<string | null>(() => firstPick(mode));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const now = useMemo(() => Date.now(), []);
  const n = typeof p.limit === "number" && p.limit > 0 ? p.limit : p.devices.filter((d) => deviceState(d) === "signed_in").length || p.devices.length;

  const who = (p.who ?? "").trim();
  const actionable = mode === "signout" ? signoutOk : p.canUnbind;
  // 这一行能不能选：让出时只有登录中的别的电脑（只有它们占名额）；移除时除这台以外未移除的都可以
  const selectable = (d: AccountDevice) => d.device_id !== thisDevice && (mode === "signout" ? deviceState(d) === "signed_in" : deviceState(d) !== "revoked");
  const switchMode = (m: Mode) => {
    setMode(m);
    setPick(firstPick(m));
    setErr("");
  };
  const submit = async () => {
    // 只有一台可选时就是它（不显示单选）
    const target = single?.device_id ?? pick;
    if (!target || busy) return;
    setBusy(true);
    setErr("");
    try {
      if (mode === "signout") await p.onSignout!(target);
      else await p.onUnbind(target);
    } catch (e) {
      setErr((e as Error).message || (mode === "signout" ? "没有让它退出登录，请稍后重试" : "没有移除成功，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };
  // 第 71 批（V45）：旧云端（can_signout=false）只能移除——标题与说明按移除的口径写，不再说“让它退出登录”
  const removeOnly = !signoutOk;
  // 只有一台可选时不要单选：整行作为“将要退出登录 / 移除的那台”展示，按钮写出它的名字
  const choices = actionable ? p.devices.filter((d) => deviceState(d) !== "revoked" && selectable(d)) : [];
  const single = choices.length === 1 ? choices[0]! : null;
  const chosen = single ?? p.devices.find((d) => d.device_id === pick) ?? null;
  // 第 72 批（D-303）：标题是一句结论，说明只说怎么办；账号身份不再加粗插进正文，缩成标题下一行小字
  const title = registeredCap ? "登记的电脑已达上限" : mode === "signout" ? `已在 ${n} 台电脑登录` : removeOnly ? `已有 ${n} 台电脑` : "移除一台电脑";
  // 第二轮（设计评分 C5）：说出上限是多少；只有一台可选时说“退出那台”
  const lead = registeredCap
    ? "移除一台不再使用的电脑，就能在这台电脑继续。"
    : mode === "signout"
      ? `你的账号最多同时在 ${n} 台电脑登录。${single ? "退出那台" : "退出其中一台"}，就能在这台电脑继续。`
      : removeOnly
        ? "移除一台不再使用的电脑，就能在这台电脑继续。"
        : "电脑丢了、转手或不再使用时才需要移除。";
  const consequence =
    mode === "signout"
      ? "那台电脑上的事项和成果都还在，重新登录即可。"
      : chosen?.session === "active" || (chosen && deviceState(chosen) === "signed_in")
        ? "那台电脑正在使用：移除后，那台电脑上的这个账号立即停用，不能撤销；资料仍加密留在那台电脑上。"
        : "移除后，那台电脑上的这个账号随即停用，不能撤销；资料仍加密留在那台电脑上。";
  // 主按钮固定短文案（D-303）：不拼电脑名，长度不随名字变、不折行；选中的那台就在列表里
  const submitText = busy ? (mode === "signout" ? "正在退出那台电脑…" : "正在移除…") : mode === "signout" ? "退出所选电脑并继续" : "移除所选电脑并继续";
  // 这台电脑排在最前（标明“你在这里”），其余按云端给的顺序
  const rows = p.devices.filter((d) => deviceState(d) !== "revoked").sort((x, y) => Number(y.device_id === thisDevice) - Number(x.device_id === thisDevice));
  return (
    <div className="auth-devlimit" data-auth-step="device-limit" data-mode={mode}>
      <div className="auth-title-row">
        <h1 className="auth-title">{title}</h1>
        <button type="button" className="btn-link" onClick={mode === "remove" && signoutOk ? () => switchMode("signout") : p.onBack} disabled={busy}>
          返回
        </button>
      </div>
      {who && <p className="auth-who">{who}</p>}
      <p className="auth-lead">{lead}</p>
      <div className="auth-devices" role={actionable && !single ? "radiogroup" : "list"} aria-label="这个账号的电脑">
        {rows.map((d) => {
          const l = deviceChoiceLine(d, now);
          const st = deviceState(d);
          const isThis = d.device_id === thisDevice;
          const can = actionable && selectable(d);
          const on = pick === d.device_id;
          // 第 72 批：列出的大都是登录中的电脑，不再每行挂“登录中”；只标例外（这台电脑、已退出登录），登录中用一个小绿点
          const badge = isThis ? <span className="auth-device-tag is-this">这台电脑</span> : st === "signed_in" ? <span className="auth-device-dot" title="登录中" aria-label="登录中" /> : <span className="auth-device-tag">已退出登录</span>;
          const body = (
            <>
              <span className="auth-device-icon" aria-hidden="true">
                <Icon.monitor />
              </span>
              <span className="auth-device-text">
                {/* 第二轮（C5）：这台电脑直接叫“这台电脑”，不与要退出 / 移除的那台同名；其余每台带“多久前用过 · 哪天登记”，同型号也能区分 */}
                <b>
                  {isThis ? "这台电脑" : l.title}
                  {isThis ? null : badge}
                </b>
                <span>{isThis ? thisDeviceLine(d, now) : deviceMetaShort(d, now)}</span>
              </span>
              {actionable && can && (
                <span className={`auth-device-check${on || (single && single.device_id === d.device_id) ? " on" : ""}`} aria-hidden="true">
                  <Icon.check />
                </span>
              )}
            </>
          );
          const cls = `auth-device-row${isThis ? " is-this" : ""}${single && single.device_id === d.device_id ? ` is-target${mode === "remove" ? " is-danger" : ""}` : ""}${!single && on ? " on" : ""}${can ? "" : " off"}`;
          // 这台电脑：不可选，也不画成禁用的按钮（禁用按钮整体变淡，像“坏了”）——虚线框的普通行，写“你正在这台电脑上登录”
          return actionable && !single && !isThis ? (
            <button key={d.device_id} type="button" role="radio" aria-checked={on} aria-disabled={!can} className={cls} onClick={() => can && setPick(d.device_id)} disabled={busy || !can}>
              {body}
            </button>
          ) : (
            <div key={d.device_id} role={actionable && !single ? "presentation" : "listitem"} className={cls}>
              {body}
            </div>
          );
        })}
      </div>
      {err && (
        <p className="activate-error" role="alert">
          {err}
        </p>
      )}
      {actionable ? (
        <>
          {/* 后果放在按钮上方，做决定前读到（第 69 批第二轮独立评审）；移除不可逆，用琥珀色风险提示（第 71 批，独立评分区域 9-2） */}
          {mode === "signout" ? (
            <p className="auth-fine auth-consequence">{consequence}</p>
          ) : (
            <p className="auth-warn" role="note">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3.5 2.8 19.5h18.4z" />
                <path d="M12 10v4.2M12 17h.01" />
              </svg>
              <span>{consequence}</span>
            </p>
          )}
          <button type="button" className={mode === "signout" ? "btn-primary activate-submit" : "btn-danger-solid activate-submit"} disabled={!(single?.device_id ?? pick) || busy} onClick={() => void submit()}>
            {submitText}
          </button>
          {mode === "signout" && p.canUnbind && removable.length > 0 && (
            <button type="button" className="btn-link auth-alt-link" onClick={() => switchMode("remove")} disabled={busy}>
              电脑丢了或不用了？改为移除
            </button>
          )}
        </>
      ) : (
        <p className="auth-fine">请在那台电脑上退出登录，或在“设置 → 账号”、云端控制台“我的电脑”里处理一台，再回来登录。</p>
      )}
    </div>
  );
}

