/**
 * 套餐目录、注册设置与计费口径（第 44 批，主文 §4.3、§4.5；取代第 40 批的“内部计量单位”）。
 *
 * - 额度单位只有两种可核验的：`tokens`（上游 usage 原样，输入 + 输出）与 `cny`（我方价目表售价 × 实际 usage，内部记微元）。
 *   不再有“每千 token 折几个单位”的固定换算。
 * - 套餐写在控制面状态里，运营在控制台改，即对所有租户的本期额度生效；首次启动从配置 `billing` 导入。
 * - 第 40 批的旧目录（`seat_monthly_units` 内部单位）读回为 tokens 套餐：每席位额度 = 旧单位 × 250——这是把已经卖出的
 *   套餐承诺按原口径（`legal/k3` 每千 token 4 个单位）翻译成 token 额度，**不用于换算任何用量**；控制台提示待商务确认。
 */

export type QuotaUnit = "tokens" | "cny";

export interface PlanSpec {
  id: string;
  label: string;
  note: string | null;
  quota_unit: QuotaUnit;
  /** 每席位每期额度：tokens 为整数 token；cny 为元（可带小数）。 */
  seat_quota: number;
  period: "month" | "week";
  /** 滚动频率窗口（与 Kimi 的 5 小时窗口同构）：任意 hours 小时内至多用本期总额度的 pct%；null = 不设。 */
  burst: { hours: number; pct: number } | null;
  seat_price_cny: number | null;
  boost_price_factor: number;
  device_limit: number;
  alert_thresholds: number[];
  /** 每席位额度是否对个人硬性生效（否则个人只按它显示比例，额度全所共用）。 */
  enforce_seat_quota: boolean;
  /** 可用的模型别名；null = 全部启用的。 */
  models: string[] | null;
  /** 来源说明（迁移来的套餐带“待商务确认”）。 */
  origin: "config" | "ops" | "migrated" | "default";
  /** 第 72 批（契约 §1）：适用的工作空间类型；缺省 any。控制台按它过滤，给客户改套餐时校验。 */
  audience?: "personal" | "team" | "any";
}

export interface RegistrationSettings {
  /** 注册方式：open = 开放（不填码即自助开通试用律所）；code = 仅凭码（开通码、成员邀请码或第 62 批的注册邀请码）；closed = 关闭。 */
  registration: "open" | "code" | "closed";
  trial_plan: string;
  trial_days: number;
  trial_seats: number;
  default_device_limit: number;
  /** 第 62 批：注册是否必须验证手机号（短信验证码）。打开前须短信通道可用（server.ts 校验）；之前的状态读回为 false。 */
  phone_required?: boolean;
}

export interface Catalog {
  plans: PlanSpec[];
  default_plan: string;
  settings: RegistrationSettings;
  /**
   * 状态迁移记录（第 62 批起）：键为迁移编号。缺 b62_billing = 第 62 批之前写下的状态（读回时迁移一次）；
   * status：native（第 62 批起新建的状态，无需迁移）、applied（已迁移，带原值可还原）、reverted（已还原，不再自动迁移）。
   */
  migrations?: Record<string, B62MigrationRecord>;
}

/** 第 62 批“额度改按金额”迁移的记录（原值留存，可还原；见 server.ts runB62Migration / revertB62Migration）。 */
export interface B62MigrationRecord {
  status: "native" | "applied" | "reverted";
  at: string;
  /** 折算系数：元 / 百万 token（tokens 额度 × 系数 = 金额额度）。 */
  coefficient_cny_per_mtok?: number;
  price_version_from?: number | null;
  price_version_to?: number | null;
  plans?: { id: string; quota_unit: QuotaUnit; seat_quota: number; note: string | null }[];
  tenants?: { tid: string; plan: string; allowance_override: number | null; legacy_before: unknown; revoked_leases: number; legacy_used_units: number }[];
  accounts?: { aid: string; tid: string; quota_limit: number | null }[];
  reverted_at?: string;
  reverted_by?: string | null;
}

/**
 * tokens 额度 → 金额额度的折算系数（第 62 批，用户拍板“额度按价目加权扣减、月额度按等价金额换算”）：
 * 线上账本 607 行实测（2026-11-24 只读查询）：输入 6,049 万 token（其中缓存命中 5,362 万）、输出 148 万；按 v2 价目
 * （legal/k3：未命中 13、命中 1.3、输出 68 元/百万 token）= (687 万×13 + 5,362 万×1.3 + 148 万×68) / 10⁶ = 89.31 + 69.71 + 100.64
 * = 259.66 元，折合 259.66 ÷ 6,197 万 token = 4.19 元/百万 token；取 4.2（向上取整到一位小数：换算后的额度不少于原额度的等价金额）。
 * 标准 5,000 万 → 210 元；专业 1.25 亿 → 525 元；旗舰 3 亿 → 1,260 元；试用 2,000 万 → 84 元。
 */
export const B62_CNY_PER_MTOK = 4.2;

/** tokens → 元（保留到分）。 */
export const tokensToCny = (tokens: number, k = B62_CNY_PER_MTOK): number => Math.round((tokens * k) / 10_000) / 100;
/** tokens → 微元（内部单位）。 */
export const tokensToMicro = (tokens: number, k = B62_CNY_PER_MTOK): number => Math.round(tokens * k);

export class PlanError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9;

/**
 * 缺省目录（开发、测试与未配置 billing 段的部署）：tokens 套餐，token 数沿用第 40 批（20 万 / 50 万 / 120 万单位 × 每千 token 4 单位）；
 * **价格留空**——正式价格由商务在控制台填。另有一个 14 天试用套餐给自助注册。
 * 说明里的“约多少单”按实测写：第 40 批写的“每单约 50～70 万 token、每月约 80 单”与实测不符——11-12 的 57 单真实任务每单中位
 * 24 次模型调用、输入九成多命中缓存，合计约 190 万 token；11-14 真实验收一单 24 次请求 187 万 token。tokens 套餐把缓存命中的输入
 * 也按 1 个 token 计（真实数据，不折算），所以同样的单数，tokens 套餐比金额套餐“显得贵”；定价后建议改金额套餐。
 * 试用原为 600 万 token、5 小时窗口 40%：真实任务做到第 24 次请求即被窗口拦下（11-14 验收），改为 2,000 万、窗口 50%（约 5 单）。
 */
/**
 * 金额套餐目录（第 62 批起的生产缺省：配置给了 billing 段而没写 plans，或补试用套餐时用它）：额度 = 每席位每月若干元，按价目售价 × 实际用量扣
 * （缓存命中按命中价）；律师端只看百分比。数额由 DEFAULT_CATALOG 的 token 额度 × 4.2 元/百万 token 折算（见 B62_CNY_PER_MTOK），说明里的“约多少单”沿用实测。
 */
export const CNY_CATALOG: Catalog = {
  plans: [
    plan({ id: "standard", label: "标准", note: "每席位每月 210 元额度（按价目计），约 25 单常规任务", quota_unit: "cny", seat_quota: 210, origin: "default" }),
    plan({ id: "pro", label: "专业", note: "每席位每月 525 元额度（按价目计），约 65 单常规任务", quota_unit: "cny", seat_quota: 525, origin: "default" }),
    plan({ id: "max", label: "旗舰", note: "每席位每月 1,260 元额度（按价目计），约 160 单常规任务", quota_unit: "cny", seat_quota: 1260, origin: "default" }),
    plan({ id: "trial", label: "试用", note: "自助注册试用 14 天，84 元额度（按价目计），约 10 单常规任务", quota_unit: "cny", seat_quota: 84, burst: { hours: 5, pct: 50 }, device_limit: 2, origin: "default" }),
  ],
  default_plan: "standard",
  settings: { registration: "open", trial_plan: "trial", trial_days: 14, trial_seats: 1, default_device_limit: 2 },
};

export const DEFAULT_CATALOG: Catalog = {
  plans: [
    plan({ id: "standard", label: "标准", note: "每席位每月 5,000 万 token，约 25 单常规任务", quota_unit: "tokens", seat_quota: 50_000_000, origin: "default" }),
    plan({ id: "pro", label: "专业", note: "每席位每月 1.25 亿 token，约 65 单常规任务", quota_unit: "tokens", seat_quota: 125_000_000, origin: "default" }),
    plan({ id: "max", label: "旗舰", note: "每席位每月 3 亿 token，约 160 单常规任务", quota_unit: "tokens", seat_quota: 300_000_000, origin: "default" }),
    plan({ id: "trial", label: "试用", note: "自助注册试用 14 天，2,000 万 token，约 10 单常规任务", quota_unit: "tokens", seat_quota: 20_000_000, burst: { hours: 5, pct: 50 }, device_limit: 2, origin: "default" }),
  ],
  default_plan: "standard",
  settings: { registration: "open", trial_plan: "trial", trial_days: 14, trial_seats: 1, default_device_limit: 2, phone_required: false },
};

function plan(p: Partial<PlanSpec> & Pick<PlanSpec, "id" | "label" | "quota_unit" | "seat_quota">): PlanSpec {
  return { note: null, period: "month", burst: null, seat_price_cny: null, boost_price_factor: 1, device_limit: 2, alert_thresholds: [80, 100], enforce_seat_quota: false, models: null, origin: "default", ...p };
}

/** 校验一个套餐（控制台提交或配置导入）。 */
export function validatePlan(id: string, raw: unknown, origin: PlanSpec["origin"], prev?: PlanSpec): PlanSpec {
  if (!PLAN_ID_RE.test(id)) throw new PlanError(400, "plan_id_invalid", "套餐代码只许小写字母、数字与连字符");
  const b = { ...(prev ?? {}), ...((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>) } as Record<string, any>;
  if (typeof b.label !== "string" || b.label.trim().length < 1 || b.label.length > 20) throw new PlanError(400, "plan_label_invalid", "套餐名称须为 1–20 个字符");
  if (b.note !== undefined && b.note !== null && (typeof b.note !== "string" || b.note.length > 60)) throw new PlanError(400, "plan_note_invalid", "说明至多 60 个字符");
  if (b.quota_unit !== "tokens" && b.quota_unit !== "cny") throw new PlanError(400, "plan_unit_invalid", "额度单位须为 tokens 或 cny");
  const q = b.seat_quota;
  if (b.quota_unit === "tokens" ? !(Number.isSafeInteger(q) && q >= 1 && q <= 1e13) : !(money(q) && q > 0)) throw new PlanError(400, "plan_quota_invalid", b.quota_unit === "tokens" ? "每席位额度须为正整数 token" : "每席位额度须为正数（元）");
  const period = b.period ?? "month";
  if (period !== "month" && period !== "week") throw new PlanError(400, "plan_period_invalid", "统计周期须为 month 或 week");
  let burst: PlanSpec["burst"] = null;
  if (b.burst !== undefined && b.burst !== null) {
    const h = b.burst.hours;
    const pct = b.burst.pct;
    if (!(Number.isSafeInteger(h) && h >= 1 && h <= 72) || !(Number.isSafeInteger(pct) && pct >= 1 && pct <= 100)) throw new PlanError(400, "plan_burst_invalid", "频率窗口须为 1–72 小时、1–100%");
    burst = { hours: h, pct };
  }
  if (b.seat_price_cny !== undefined && b.seat_price_cny !== null && !money(b.seat_price_cny)) throw new PlanError(400, "plan_price_invalid", "席位价格不合法");
  const f = b.boost_price_factor ?? 1;
  if (typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > 10) throw new PlanError(400, "plan_boost_factor_invalid", "加量价格系数须为 0–10");
  const dl = b.device_limit ?? 2;
  if (!(Number.isSafeInteger(dl) && dl >= 1 && dl <= 9)) throw new PlanError(400, "plan_device_limit_invalid", "每账号设备数须为 1–9");
  const th = b.alert_thresholds ?? [80, 100];
  if (!Array.isArray(th) || th.length > 5 || !th.every((x: unknown) => Number.isSafeInteger(x) && (x as number) >= 1 && (x as number) <= 100)) throw new PlanError(400, "plan_thresholds_invalid", "提醒阈值须为至多 5 个 1–100 的整数");
  const models = b.models ?? null;
  if (models !== null && (!Array.isArray(models) || models.length > 32 || !models.every((x: unknown) => typeof x === "string" && /^[a-z0-9][a-z0-9._/-]{1,47}$/.test(x)))) throw new PlanError(400, "plan_models_invalid", "可用模型须为别名列表或不限");
  const audience = b.audience ?? "any";
  if (audience !== "personal" && audience !== "team" && audience !== "any") throw new PlanError(400, "plan_audience_invalid", "适用对象须为 personal、team 或 any");
  return {
    id,
    label: b.label.trim(),
    note: b.note ?? null,
    quota_unit: b.quota_unit,
    seat_quota: q,
    period,
    burst,
    seat_price_cny: b.seat_price_cny ?? null,
    boost_price_factor: f,
    device_limit: dl,
    alert_thresholds: [...new Set(th as number[])].sort((x, y) => x - y),
    enforce_seat_quota: b.enforce_seat_quota === true,
    models,
    origin,
    audience,
  };
}

export function validateSettings(raw: unknown, plans: PlanSpec[], prev: RegistrationSettings): RegistrationSettings {
  const b = { ...prev, ...((raw && typeof raw === "object" ? raw : {}) as Record<string, any>) };
  if (!["open", "code", "closed"].includes(b.registration)) throw new PlanError(400, "registration_invalid", "注册方式须为 open、code 或 closed");
  if (!plans.some((p) => p.id === b.trial_plan)) throw new PlanError(400, "trial_plan_unknown", "试用套餐不在目录里");
  if (!(Number.isSafeInteger(b.trial_days) && b.trial_days >= 1 && b.trial_days <= 365)) throw new PlanError(400, "trial_days_invalid", "试用天数须为 1–365");
  if (!(Number.isSafeInteger(b.trial_seats) && b.trial_seats >= 1 && b.trial_seats <= 50)) throw new PlanError(400, "trial_seats_invalid", "试用席位须为 1–50");
  if (!(Number.isSafeInteger(b.default_device_limit) && b.default_device_limit >= 1 && b.default_device_limit <= 9)) throw new PlanError(400, "device_limit_invalid", "缺省设备数须为 1–9");
  if (b.phone_required !== undefined && typeof b.phone_required !== "boolean") throw new PlanError(400, "phone_required_invalid", "phone_required 须为 true 或 false");
  return { registration: b.registration, trial_plan: b.trial_plan, trial_days: b.trial_days, trial_seats: b.trial_seats, default_device_limit: b.default_device_limit, phone_required: b.phone_required === true };
}

/**
 * 配置 `billing` 段 → 目录（首次启动导入）。认两种写法：第 44 批的（带 quota_unit）与第 40 批的（seat_monthly_units，按 §4.6 翻译）。
 */
/**
 * 注册方式缺省（第 46 批，契约 §2.6）：未给 billing（开发与测试的进程内调用）仍为 open；给了 billing 段（生产入口一律给，缺省 {}）缺省 code——
 * 凭开通码 / 邀请码注册，open 要运营显式打开。只影响新状态：读回的旧状态保持原值。
 */
/**
 * 第 62 批：同一先例（注册方式），未给 billing（开发与测试的进程内调用）仍是 tokens 目录（DEFAULT_CATALOG，既有用例按 token 写）；
 * 给了 billing 段（生产入口一律给）而没写 plans 时用金额目录 CNY_CATALOG。配置里显式写了 tokens 套餐的照写（运营的选择）。
 * 新建的目录都带迁移标记 native（不再走第 62 批的读回迁移）。
 */
export function catalogFromConfig(raw: unknown): Catalog {
  const native = (c: Catalog): Catalog => ({ ...c, migrations: { ...(c.migrations ?? {}), b62_billing: { status: "native", at: new Date(0).toISOString() } } });
  if (raw === undefined || raw === null) return native(structuredClone(DEFAULT_CATALOG));
  if (typeof raw !== "object") throw new Error("billing 须为对象");
  const b = raw as Record<string, any>;
  const strict = { ...CNY_CATALOG.settings, registration: "code" as const };
  if (b.plans === undefined) {
    const c = structuredClone(CNY_CATALOG);
    return native({ ...c, settings: validateSettings(b.registration ?? {}, c.plans, strict) });
  }
  if (!Array.isArray(b.plans) || b.plans.length === 0 || b.plans.length > 20) throw new Error("billing.plans 须为 1–20 个套餐");
  const plans: PlanSpec[] = [];
  for (const [i, p] of b.plans.entries()) {
    if (!p || typeof p !== "object" || typeof p.id !== "string") throw new Error(`billing.plans[${i}] 缺 id`);
    if (plans.some((x) => x.id === p.id)) throw new Error(`billing.plans 套餐代码重复：${p.id}`);
    try {
      if (p.quota_unit === undefined && Number.isSafeInteger(p.seat_monthly_units)) {
        plans.push(validatePlan(p.id, { label: p.label, note: p.note ?? "由旧版计量额度换算，待商务确认", quota_unit: "tokens", seat_quota: p.seat_monthly_units * 250, seat_price_cny: p.seat_price_cny ?? null, boost_price_factor: b.boost_price_factor ?? 1 }, "migrated"));
      } else plans.push(validatePlan(p.id, p, "config"));
    } catch (e) {
      throw new Error(`billing.plans[${i}]：${(e as Error).message}`);
    }
  }
  const def = typeof b.default_plan === "string" ? b.default_plan : plans[0]!.id;
  if (!plans.some((p) => p.id === def)) throw new Error(`billing.default_plan 不在目录里：${def}`);
  if (!plans.some((p) => p.id === "trial")) plans.push(structuredClone(CNY_CATALOG.plans.find((p) => p.id === "trial")!));
  const settings = validateSettings(b.registration ?? {}, plans, strict);
  return native({ plans, default_plan: def, settings });
}

export function migrateCatalog(raw: unknown, fallback: Catalog): Catalog {
  const c = raw as Catalog | undefined;
  if (!c || !Array.isArray(c.plans) || c.plans.length === 0 || typeof c.default_plan !== "string" || !c.settings) return fallback;
  return c;
}

export function planOf(c: Catalog, id: string | undefined): PlanSpec {
  return c.plans.find((p) => p.id === id) ?? c.plans.find((p) => p.id === c.default_plan)!;
}

/** 每席位额度折成内部整数（tokens 原样；cny 元 → 微元）。 */
export function seatQuotaUnits(p: PlanSpec): number {
  return p.quota_unit === "cny" ? Math.round(p.seat_quota * 1_000_000) : p.seat_quota;
}

/** 内部整数 → 对外数值（tokens 原样；cny 微元 → 元，保留 4 位）。 */
export function unitOut(unit: QuotaUnit, n: number): number {
  return unit === "cny" ? Math.round(n / 100) / 10_000 : n;
}

export const microToCny = (n: number | null): number | null => (n === null ? null : Math.round(n / 100) / 10_000);

/** 统计周期边界（北京时间）：月 = 自然月；周 = 周一 0 点起 7 天。 */
export function periodBounds(kind: "month" | "week", t: number): { key: string; start: string; resets_at: string; fromDay: string; toDay: string } {
  const BJ = 8 * 3600_000;
  const d = new Date(t + BJ);
  const day = (ms: number) => new Date(ms + BJ).toISOString().slice(0, 10);
  if (kind === "month") {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - BJ;
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - BJ;
    return { key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, start: new Date(start).toISOString(), resets_at: new Date(end).toISOString(), fromDay: day(start), toDay: day(end - 1) };
  }
  const dow = (d.getUTCDay() + 6) % 7; // 周一 = 0
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - BJ;
  const end = start + 7 * 24 * 3600_000;
  // ISO 周序号
  const th = new Date(start + BJ + 3 * 24 * 3600_000);
  const y = th.getUTCFullYear();
  const wk = Math.floor((th.getTime() - Date.UTC(y, 0, 1)) / (7 * 24 * 3600_000)) + 1;
  return { key: `${y}-W${String(wk).padStart(2, "0")}`, start: new Date(start).toISOString(), resets_at: new Date(end).toISOString(), fromDay: day(start), toDay: day(end - 1) };
}

/** 本期账单（元；没配价格的项为 null）：席位费 + 加量费 = 应收；用量价值与成本来自账本（微元）。 */
export function periodBill(o: { plan: PlanSpec; seats: number; boost_pct: number; value_micro: number; cost_micro: number; unpriced: number; uncosted: number; requests: number }) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const seatFee = o.plan.seat_price_cny == null ? null : r2(o.plan.seat_price_cny * o.seats);
  const boostFee = seatFee === null ? null : r2((seatFee * o.boost_pct * o.plan.boost_price_factor) / 100);
  const revenue = seatFee === null ? null : r2(seatFee + (boostFee ?? 0));
  // 有用量却全部未定价 → null（显示“未定价”，不显示 0）；部分未定价时只计已定价部分（界面另提示未定价行数）
  const value = o.requests > 0 && o.unpriced > 0 && o.value_micro === 0 ? null : microToCny(o.value_micro);
  const cost = o.requests > 0 && o.uncosted > 0 && o.cost_micro === 0 ? null : microToCny(o.cost_micro);
  return { seat_price_cny: o.plan.seat_price_cny, seat_fee_cny: seatFee, boost_pct: o.boost_pct, boost_fee_cny: boostFee, revenue_cny: revenue, value_cny: value, cost_cny: cost, margin_cny: revenue !== null && cost !== null ? r2(revenue - cost) : null };
}
