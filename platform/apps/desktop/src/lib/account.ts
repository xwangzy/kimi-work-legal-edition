/**
 * 账号与设备的显示文字（第 44 批，主文 §2）：登录 / 注册 / 找回密码的即时校验、设备与登录记录的一行说明、登录失效的提示。
 * 纯函数，便于用例覆盖。律师层不出现“令牌、证书、席位、租户”等词：说“账号、这台电脑、本所”。
 */

/** 密码规则（与中软一致：10–128 位、同时含字母与数字、不等于邮箱 @ 前面那段）。 */
export interface PasswordCheck {
  length: boolean;
  letter: boolean;
  digit: boolean;
  notEmail: boolean;
  ok: boolean;
}

export function checkPassword(pw: string, email = ""): PasswordCheck {
  const length = pw.length >= 10 && pw.length <= 128;
  const letter = /[A-Za-z]/.test(pw);
  const digit = /\d/.test(pw);
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  const notEmail = !(local.length > 0 && pw.toLowerCase() === local);
  return { length, letter, digit, notEmail, ok: length && letter && digit && notEmail };
}

/** 密码规则的逐条提示（已满足的打勾）；空密码时不提示“不能等于邮箱”。 */
export function passwordHints(pw: string, email = ""): { text: string; ok: boolean }[] {
  const c = checkPassword(pw, email);
  return [
    { text: pw.length > 128 ? "不超过 128 位" : "至少 10 位", ok: c.length },
    { text: "包含字母", ok: c.letter },
    { text: "包含数字", ok: c.digit },
    ...(pw && !c.notEmail ? [{ text: "不能和邮箱 @ 前面的部分相同", ok: false }] : []),
  ];
}

/** 邮箱格式的粗查（真正的核对在中软）。 */
export function emailLooksValid(e: string): boolean {
  const s = e.trim();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** 姓名 1–40 个字符（去掉首尾空格后）。 */
export function nameLooksValid(n: string): boolean {
  const s = n.trim();
  return s.length >= 1 && [...s].length <= 40;
}

/** 开通码 20 位、邀请码 36 位（只数字母与数字）。 */
export function codeLengthOk(code: string): boolean {
  return [20, 36].includes(code.replace(/[^0-9A-Za-z]/g, "").length);
}

export const ROLE_LABEL: Readonly<Record<string, string>> = { admin: "管理员", firm_admin: "管理员", partner: "合伙人", lawyer: "律师", assistant: "助理" };

export function roleLabel(r: string | null | undefined): string {
  return (r && ROLE_LABEL[r]) || "成员";
}

/** ISO 时间或“YYYY-MM-DD” → “11 月 14 日”（北京时间；今年不写年份）。 */
export function dayLabel(v: string | null | undefined, now = Date.now()): string {
  if (!v) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 8 * 3600_000 : Date.parse(v);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t + 8 * 3600_000);
  const y = new Date(now + 8 * 3600_000).getUTCFullYear();
  return `${d.getUTCFullYear() === y ? "" : `${d.getUTCFullYear()} 年 `}${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

/** 平台代码 → 电脑类型。 */
export function platformLabel(p: string | null | undefined): string {
  return p === "win32" ? "Windows 电脑" : p === "darwin" ? "Mac 电脑" : p === "linux" ? "Linux 电脑" : "电脑";
}

/** 设备编号的简写（第 n 台）：dev_<律所>_<成员> 为第 1 台，…_D<n> 为第 n 台。 */
export function deviceOrdinal(deviceId: string): number {
  const m = /_D(\d)$/.exec(deviceId);
  return m ? Number(m[1]) : 1;
}

export interface AccountDevice {
  device_id: string;
  registered_at: string | null;
  revoked_at?: string | null;
  client_version: string | null;
  last_seen_on: string | null;
  current?: boolean;
  session?: "active" | "none";
}

/** “我的设备”一行：第几台、本机标记、登记日、最近使用、版本、是否登录中。 */
export function deviceLine(d: AccountDevice, now = Date.now()): { title: string; meta: string; state: { text: string; tone: "ok" | "gray" | "bad" } } {
  const n = deviceOrdinal(d.device_id);
  const title = `${d.current ? "这台电脑" : `第 ${n} 台电脑`}`;
  const meta = [`${dayLabel(d.registered_at, now)}登记`, d.last_seen_on ? `最近使用 ${dayLabel(d.last_seen_on, now)}` : "", d.client_version ? `版本 ${d.client_version}` : ""].filter(Boolean).join(" · ");
  const state = d.revoked_at ? { text: "已解绑", tone: "bad" as const } : d.session === "active" ? { text: "已登录", tone: "ok" as const } : { text: "未登录", tone: "gray" as const };
  return { title, meta, state };
}

export interface AccountSession {
  sid: string;
  kind: "desktop" | "web";
  device_id: string | null;
  created_at: string;
  last_seen_at: string | null;
  idle_expires_at: string;
  client?: { version?: string | null; platform?: string | null } | null;
  current?: boolean;
}

/** “登录记录”一行：在哪儿登录、何时登录、最近活动、多久不用会自动退出。 */
export function sessionLine(s: AccountSession, now = Date.now()): { title: string; meta: string } {
  const where = s.kind === "web" ? "网页" : `${platformLabel(s.client?.platform)}${s.device_id ? `（第 ${deviceOrdinal(s.device_id)} 台）` : ""}`;
  const title = s.current ? `${where} · 当前这次登录` : where;
  const meta = [`${dayLabel(s.created_at, now)}登录`, s.last_seen_at ? `最近活动 ${dayLabel(s.last_seen_at, now)}` : "", `不使用到 ${dayLabel(s.idle_expires_at, now)}会自动退出`].filter(Boolean).join(" · ");
  return { title, meta };
}

/** 登录失效的原因代码 → 横幅文字（AI 暂停，本机资料照常可用）。 */
export function loginRequiredText(reason: string | null | undefined): string {
  const why =
    reason === "account_disabled"
      ? "账号已停用，请联系律所管理员或客服"
      : reason === "session_member_mismatch"
        ? "这台电脑登记的是本所另一位成员，请用那位成员的账号登录"
        : reason === "session_required"
          ? "你已退出登录"
          : "登录已失效";
  return `${why}，请重新登录（本机资料照常可用，AI 暂停）`;
}

/** kernel.status / account.status 里是否要求重新登录。 */
export function needsLogin(st: { account?: { login_required?: boolean } | null; login_required?: boolean } | null | undefined): boolean {
  return !!(st && (st.account?.login_required || st.login_required));
}

/** 账号新电脑等待批准时的说明（D-186：没有邀请可对，由已登录的另一台电脑或律所管理员人工核对）。 */
export function waitApprovalLead(o: { firm: string; who: string; viaAccount: boolean }): string {
  if (o.viaAccount) return `这个账号在「${o.firm}」已有登记的电脑。请在你已登录的另一台电脑（或请律所管理员）打开“设置 → 管理 → 成员”，批准这台电脑，并核对这 12 位数字。`;
  return `已向「${o.firm}」申请加入${o.who ? `（${o.who}）` : ""}。请打电话或当面联系管理员，把下面的入组核对码读给他；管理员核对一致后批准，这里会自动进入。`;
}

/** 找回密码的第一步回复 → 下一步说明。channel=email：验证码发到邮箱；admin：没有邮件通道，找管理员或客服要重置码。 */
export function resetNextText(r: { channel?: string; message?: string } | null | undefined): string {
  if (r?.message) return r.message;
  return r?.channel === "email" ? "如果这个邮箱已注册，验证码已发到邮箱（15 分钟内有效）。请把验证码填在下面。" : "请向律所管理员或客服要一个重置码，填在下面。";
}
