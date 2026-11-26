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

/** 第 62 批：注册时的码——注册邀请码 12 位、开通码 20 位、成员邀请码 36 位（只数字母与数字）。 */
export function registerCodeLengthOk(code: string): boolean {
  return [12, 20, 36].includes(code.replace(/[^0-9A-Za-z]/g, "").length);
}

/** 中国大陆手机号的粗查（可带 +86、空格与连字符；真正的核对在中软）。 */
export function phoneLooksValid(v: string): boolean {
  return /^(?:\+?86)?1[3-9]\d{9}$/.test(v.replace(/[\s-]/g, ""));
}

/** 短信验证码：纯数字、位数与云端公布的一致（缺省 6 位）。 */
export function smsCodeLooksValid(v: string, len = 6): boolean {
  return new RegExp(`^\\d{${len}}$`).test(v.trim());
}

/** 内核 account.registration_meta 的结果（第 62 批；旧云端 legacy = true）。 */
export interface RegistrationMeta {
  legacy: boolean;
  mode?: "open" | "code" | "closed" | null;
  invite_required?: boolean;
  require_phone?: boolean;
  sms_available?: boolean;
  phone_reset?: boolean;
  sms?: { code_length: number; resend_seconds: number; ttl_minutes: number };
  /** 第 63 批：云端开放了手机号验证码登录（旧云端没有这一项，按 false）。 */
  phone_login?: boolean;
  /** 第 63 批：已登录的账号可以绑定 / 更换手机号（旧云端没有这一项，按 false）。 */
  phone_bind?: boolean;
  /** 第 69 批：密码登录可填手机号（旧云端没有这一项，只认邮箱）。 */
  password_by_phone?: boolean;
}

/** 手机号中间四位遮住（“139 **** 1004”）：界面上回显律师刚输的号码时用。不是 11 位手机号原样返回。纯函数。 */
export function maskPhone(v: string): string {
  const d = v.replace(/\D/g, "");
  return /^1\d{10}$/.test(d) ? `${d.slice(0, 3)} **** ${d.slice(7)}` : v;
}

/** 密码登录的账号一栏（第 69 批）：云端支持时手机号或邮箱都行。纯函数。 */
export function passwordIdOk(v: string, meta: RegistrationMeta | null | undefined): boolean {
  return emailLooksValid(v) || (meta?.password_by_phone === true && !v.includes("@") && phoneLooksValid(v));
}

/**
 * 注册页显示哪些字段（第 62 批，按云端能力字段做特性检测）：取不到策略或旧云端（legacy）→ 照旧流程（不显示手机号，码可勾选填写）；
 * 新云端 → 短信可用才显示手机号（要求时必填，否则选填）；仅凭码注册时码必填、不再用勾选框。纯函数。
 */
export function registrationFields(m: RegistrationMeta | null | undefined): { legacy: boolean; phone: "hidden" | "optional" | "required"; code: "checkbox" | "required"; codeLength: number; resendSeconds: number; phoneReset: boolean } {
  if (!m || m.legacy) return { legacy: true, phone: "hidden", code: "checkbox", codeLength: 6, resendSeconds: 60, phoneReset: false };
  const phone = m.require_phone ? "required" : m.sms_available ? "optional" : "hidden";
  return { legacy: false, phone, code: m.invite_required ? "required" : "checkbox", codeLength: m.sms?.code_length ?? 6, resendSeconds: m.sms?.resend_seconds ?? 60, phoneReset: m.phone_reset === true };
}

/** 短信验证码的用途（第 63 批扩为四种）：注册、找回密码、验证码登录、绑定 / 更换手机号。码与用途绑定，不能混用。 */
export type SmsPurpose = "register" | "reset" | "login" | "bind";

/** 登录方式：手机号 + 短信验证码，或邮箱 + 密码。 */
export type LoginMethod = "phone" | "password";

/** 第 63 批：登录页能用哪些方式。旧云端、取不到策略（legacy）或云端没开验证码登录 → 只有密码登录（与第 62 批相同）。纯函数。 */
export function loginMethods(m: RegistrationMeta | null | undefined): { phone: boolean; password: true } {
  return { phone: !!m && !m.legacy && m.phone_login === true, password: true };
}

/** 本机记住的“上次用过的登录方式”（只记方式，不记手机号、邮箱）。 */
export const LOGIN_METHOD_KEY = "kwl.login.method";

type MethodStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const defaultStore = (): MethodStore | undefined => (globalThis as { localStorage?: MethodStore }).localStorage;

/** 读上次用过的登录方式；没有记录、记录不认识或读不了（隐私模式、存储被禁用）一律按没有记录。 */
export function rememberedLoginMethod(store?: MethodStore | null): LoginMethod | null {
  try {
    const v = (store ?? defaultStore())?.getItem(LOGIN_METHOD_KEY);
    return v === "phone" || v === "password" ? v : null;
  } catch {
    return null;
  }
}

/** 登录成功后记下这次用的方式；存不下就算了（下次按缺省）。 */
export function saveLoginMethod(m: LoginMethod, store?: MethodStore | null): void {
  try {
    (store ?? defaultStore())?.setItem(LOGIN_METHOD_KEY, m);
  } catch {
    // 存不下：下次按缺省方式显示，不影响登录
  }
}

/** 登录框先显示哪种方式：云端没开验证码登录 → 密码；开了 → 上次用过的，没有记录 → 验证码登录。纯函数。 */
export function initialLoginMethod(methods: { phone: boolean }, remembered: LoginMethod | null): LoginMethod {
  if (!methods.phone) return "password";
  return remembered ?? "phone";
}

/** 内核报的失败原因代码（DomainError.detail.reason）。 */
export function errorReason(e: unknown): string | null {
  const r = (e as { detail?: { reason?: unknown } } | null)?.detail?.reason;
  return typeof r === "string" ? r : null;
}

/** 验证码登录时手机号还没有对应的账号（发码或登录时都可能报）。 */
export function phoneNotRegistered(e: unknown): boolean {
  return errorReason(e) === "phone_not_registered";
}

/**
 * 手机号没注册时表单里给哪些动作：开通页（还没激活）可以“用这个手机号注册”或“改用密码登录”；
 * 已激活电脑的重新登录框只能登这台电脑已登记的成员，不能在这里注册新账号，只给“改用密码登录”。纯函数。
 */
export function notRegisteredActions(where: "activate" | "relogin"): ("register" | "password")[] {
  return where === "activate" ? ["register", "password"] : ["password"];
}

/** 账号卡上的手机号一栏：打码后的号码，或“未绑定”。 */
export function phoneLabel(phone: string | null | undefined): string {
  return phone && phone.trim() ? phone.trim() : "未绑定";
}

/**
 * 绑定 / 更换手机号对话框（第 63 批）：账号还没有手机号 → 绑定，不要密码；已有 → 更换，须输入当前密码。
 * done = 成功后的提示（云端开了验证码登录才说“可以用手机号验证码登录”）。纯函数。
 */
export function phoneBindForm(current: string | null | undefined, phoneLogin = false): { change: boolean; title: string; needPassword: boolean; phoneField: string; lead: string; done: string } {
  const change = !!(current && current.trim());
  return change
    ? {
        change,
        title: "更换手机号",
        needPassword: true,
        phoneField: "新手机号",
        lead: `现在绑定的是 ${current!.trim()}。换成新手机号后，原来的号码不能再用来登录或找回密码；为确认是你本人，请输入当前密码。`,
        done: phoneLogin ? "已更换手机号，之后用新手机号验证码登录。" : "已更换手机号。",
      }
    : {
        change,
        title: "绑定手机号",
        // 第 63 批安全审查：首次绑定也要当前密码（云端同样要求）——手机号可以登录、找回密码，属于凭据变更
        needPassword: true,
        phoneField: "手机号",
        lead: phoneLogin ? "绑定后，在登录页可以用手机号和短信验证码登录，不用记密码；邮箱和密码照常可用。为确认是你本人，请输入当前密码。" : "绑定后，这个手机号与你的账号关联；邮箱和密码照常可用。为确认是你本人，请输入当前密码。",
        done: phoneLogin ? "已绑定，之后可以用手机号验证码登录。" : "已绑定手机号。",
      };
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
  // 第 69 批：编号可到 _D999（个人账号自第 66 批、团队成员自第 69 批），原来只认一位数，第 10 台起显示成“第 1 台”
  const m = /_D(\d{1,3})$/.exec(deviceId);
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
  /** 第 69 批（D-297）：云端补的平台（这个账号在那台电脑上最近一次会话报的）与最近使用时刻（会话级，比只到日的 last_seen_on 细）。旧云端没有。 */
  platform?: string | null;
  last_seen_at?: string | null;
}

/** 相对时间：刚刚 / N 分钟前 / 今天 14:20 / 昨天 / 11 月 3 日（北京时间）。纯函数。 */
export function agoLabel(v: string | null | undefined, now = Date.now()): string {
  if (!v) return "";
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : Date.parse(v);
  if (t === null) {
    const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
    const yest = new Date(now + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10);
    return v === today ? "今天" : v === yest ? "昨天" : dayLabel(v, now);
  }
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((now - t) / 60_000);
  if (min < 2) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const day = (x: number) => new Date(x + 8 * 3600_000).toISOString().slice(0, 10);
  const hm = new Date(t + 8 * 3600_000).toISOString().slice(11, 16);
  if (day(t) === day(now)) return `今天 ${hm}`;
  if (day(t) === day(now - 86400_000)) return `昨天 ${hm}`;
  return dayLabel(v, now);
}

/**
 * 电脑数已满时“选一台移除”的一行（第 69 批，D-297）：标题是电脑类型（Mac / Windows，云端没给平台时写“第 n 台电脑”），
 * 说明是“最近使用 … · 版本 …”，正在登录的另标“登录中”（移除会让那台电脑立即退出）。纯函数。
 */
export function deviceChoiceLine(d: AccountDevice, now = Date.now()): { title: string; meta: string; active: boolean } {
  const n = deviceOrdinal(d.device_id);
  // 第三轮（独立评审 R2-2）：同型号的几台都叫“Mac 电脑”时靠编号区分（第几台登记的）
  const kind = d.platform ? `${platformLabel(d.platform)} · 第 ${n} 台` : `第 ${n} 台电脑`;
  const seen = agoLabel(d.last_seen_at ?? d.last_seen_on, now);
  const version = d.client_version && d.client_version !== "legacy" ? d.client_version : null;
  // 第二轮（独立评审）：另写登记日期——两台同型号电脑时，靠“哪天登记的”认出是哪一台
  const reg = d.registered_at ? agoLabel(d.registered_at, now) : "";
  const meta = [seen ? `最近使用 ${seen}` : "", reg ? `${reg}${/\d$/.test(reg) ? " " : ""}登记` : "", version ? `版本 ${version}` : ""].filter(Boolean).join(" · ");
  return { title: kind, meta, active: d.session === "active" };
}

/**
 * 默认预选哪一台（第 69 批，D-297）：最久没用的那台——律师多半就是要换掉它，一次点击即可；但仍由律师确认、可改选，
 * 不替律师自动移除（自动替换会在不知情时让正在用的电脑掉线，也会让盗用者悄悄挤掉真主人的电脑）。纯函数。
 */
export function defaultRemovalPick(devices: readonly AccountDevice[]): string | null {
  if (devices.length === 0) return null;
  const at = (d: AccountDevice) => d.last_seen_at ?? d.last_seen_on ?? d.registered_at ?? "";
  // 先挑不在登录中的；都在登录中时挑最久没用的
  const pool = devices.some((d) => d.session !== "active") ? devices.filter((d) => d.session !== "active") : [...devices];
  return [...pool].sort((x, y) => at(x).localeCompare(at(y)))[0]!.device_id;
}

/** “我的设备”一行：第几台、本机标记、登记日、最近使用、版本、是否登录中。 */
export function deviceLine(d: AccountDevice, now = Date.now()): { title: string; meta: string; state: { text: string; tone: "ok" | "gray" | "bad" } } {
  const n = deviceOrdinal(d.device_id);
  // 第 69 批（D-297）：云端给了平台时写电脑类型（“Mac 电脑”），与电脑数已满时的选择列表同一说法；旧云端仍写第几台
  const title = d.current ? "这台电脑" : d.platform ? platformLabel(d.platform) : `第 ${n} 台电脑`;
  // 第 55 批（真实控制面复评）：①“最近使用”是服务器按 UTC 记的日子，北京时间 0～8 点登记的电脑会显示成“登记 22 日 · 最近使用 21 日”——
  // 不早于登记日（按北京时间的日子比）；②没有上报版本的客户端，服务器记占位值 legacy，不显示给律师看。
  const regDay = d.registered_at && Number.isFinite(Date.parse(d.registered_at)) ? new Date(Date.parse(d.registered_at) + 8 * 3600_000).toISOString().slice(0, 10) : null;
  const seen = d.last_seen_on && regDay && /^\d{4}-\d{2}-\d{2}$/.test(d.last_seen_on) && d.last_seen_on < regDay ? regDay : d.last_seen_on;
  const version = d.client_version && d.client_version !== "legacy" ? d.client_version : null;
  const meta = [`${dayLabel(d.registered_at, now)}登记`, seen ? `最近使用 ${dayLabel(seen, now)}` : "", version ? `版本 ${version}` : ""].filter(Boolean).join(" · ");
  const state = d.revoked_at ? { text: "已移除", tone: "bad" as const } : d.session === "active" ? { text: "已登录", tone: "ok" as const } : { text: "未登录", tone: "gray" as const };
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

/** 登录失效的原因代码 → 一句说明（设置 · 账号一栏用；整窗重新登录页另用 reloginView）。 */
export function loginRequiredText(reason: string | null | undefined): string {
  const why =
    reason === "account_disabled"
      ? "账号已停用，请联系律所管理员或客服"
      : reason === "session_member_mismatch"
        ? "登录状态与这台电脑上打开的账号不一致"
        : reason === "session_required"
          ? "你已退出登录"
          : "登录已失效";
  return `${why}，请重新登录（本机资料照常可用，AI 暂停）`;
}

/**
 * 整窗重新登录页的标题与说明（第 64 批：退出登录、登录失效后不再在工作区顶部嵌横幅）。
 * 标题按原因：主动退出 → “你已退出登录”；账号停用 → 写明联系谁；其余 → “登录已失效”。纯函数。
 * 第 68 批（V42，D-294）：这台电脑不再只许某位成员登录——任何合法账号都可以在这里登录：登录的是刚才那个账号就回到原来的工作空间，
 * 是别的账号就打开那个账号自己的工作空间（这台电脑上第一次登录的，按云端的设备策略登记）。说明里讲清“各账号的资料互不可见”。
 */
export function reloginView(reason: string | null | undefined): { title: string; lead: string } {
  const keep = "这台电脑上的事项、材料和成果都还在；登录后 AI 恢复可用。";
  // 第 69 批（V43）：主动退出时不再解释——律师刚点了退出，标题已说明一切；其余原因各一句，只说律师需要知道的
  void keep;
  if (reason === "account_disabled") return { title: "账号已停用", lead: "请联系律所管理员或客服启用后再登录。本机的事项与成果都还在。" };
  if (reason === "session_member_mismatch") return { title: "请重新登录", lead: "登录状态与这台电脑上打开的账号不一致。" };
  if (reason === "session_required") return { title: "你已退出登录", lead: "" };
  // 第 69 批真实验收：被移除的电脑上同一账号不能再登录（云端吊销是终局的）——不写“重新登录即可”，给出还能做的事
  if (reason === "device_revoked") return { title: "这台电脑已从账号移除", lead: "这个账号不能再在这台电脑上使用，本机资料仍加密保存在这里。可以登录其他账号。" };
  return { title: "登录已过期", lead: "为了账号安全，请重新登录。本机的事项与成果都还在。" };
}

/** 第 68 批：换账号登录后的过渡说明（切换到那个账号自己的工作空间；新账号按云端设备策略登记）。纯函数。 */
export function switchingText(r: { enrolling?: boolean; account?: { name?: string | null; email?: string | null } | null } | null | undefined): string {
  const who = (r?.account?.name || r?.account?.email || "").trim();
  return r?.enrolling ? `正在为${who ? `「${who}」` : "这个账号"}登记这台电脑…` : `正在打开${who ? `「${who}」` : "这个账号"}的工作空间…`;
}

/** kernel.status / account.status 里是否要求重新登录。 */
export function needsLogin(st: { account?: { login_required?: boolean } | null; login_required?: boolean } | null | undefined): boolean {
  return !!(st && (st.account?.login_required || st.login_required));
}

/**
 * 账号新电脑等待批准时的说明（D-186：没有邀请可对，人工核对）。第 46 批：“设置 → 管理”只有律所管理员看得到、批准要用管理员电脑上的律所密钥，
 * 所以非管理员只能请管理员在其电脑上批准；管理员本人保留原说法（在自己已登录的另一台电脑上批准）。
 */
export function waitApprovalLead(o: { firm: string; who: string; viaAccount: boolean; admin?: boolean }): string {
  if (o.viaAccount && o.admin) return `这个账号在「${o.firm}」已有登记的电脑。请在你已登录的另一台电脑（或请律所管理员）打开“设置 → 管理 → 成员”，批准这台电脑，并核对这 12 位数字。`;
  if (o.viaAccount) return `这个账号在「${o.firm}」已有登记的电脑。请律所管理员在其电脑上的“设置 → 管理 → 成员”里批准这台电脑，并与管理员核对这 12 位数字。`;
  return `已向「${o.firm}」申请加入${o.who ? `（${o.who}）` : ""}。请打电话或当面联系管理员，把下面的入组核对码读给他；管理员核对一致后批准，这里会自动进入。`;
}

/** 找回密码的第一步回复 → 下一步说明。channel=email：验证码发到邮箱；admin：没有邮件通道，找管理员或客服要重置码。 */
export function resetNextText(r: { channel?: string; message?: string } | null | undefined): string {
  if (r?.message) return r.message;
  return r?.channel === "email" ? "如果这个邮箱已注册，验证码已发到邮箱（15 分钟内有效）。请把验证码填在下面。" : "请向律所管理员或客服要一个重置码，填在下面。";
}
