/**
 * 套餐目录与计费口径（第 40 批）。
 *
 * - 律所按**席位 × 套餐**订阅：每个席位每月一份额度（seat_monthly_units，内部计量单位，界面不显示）；
 *   本月套餐额度 = 席位数 × 每席位额度，按百分比统计用量（quota.ts）；
 * - 加量包按套餐额度的百分比买，价格 = 加量百分比 × 当月席位费 × boost_price_factor（缺省 1：加 50% 额度收半个月席位费）；
 * - 成本只用于运营看毛利：unit_cost_cny = 每个计量单位的模型成本（按中软 MaaS 合同价折算；不配就不显示）；
 * - 目录写在控制面配置 `billing` 段（cloud-serve），改目录即对所有租户的本月额度生效。
 */

export interface PlanSpec {
  /** 套餐代码（小写字母、数字、连字符）。 */
  id: string;
  label: string;
  /** 每席位每月额度（计量单位：网关按 token 折算，`legal/k3` 每千 token 4 个单位）。 */
  seat_monthly_units: number;
  /** 每席位每月价格（元，可选；只用于控制台计费与毛利显示）。 */
  seat_price_cny?: number | null;
  /** 一句话说明（控制台下拉框里显示）。 */
  note?: string;
}

export interface BillingConfig {
  plans: PlanSpec[];
  /** 新开通租户的缺省套餐。 */
  default_plan: string;
  /** 每计量单位的模型成本（元，可选）。 */
  unit_cost_cny?: number | null;
  /** 加量价格系数（缺省 1）。 */
  boost_price_factor?: number;
}

/**
 * 缺省目录（开发、测试与未配置 billing 段的试点）：额度按“每单真实法律任务约 50～70 万 token ≈ 2,000～3,000 单位”估：
 * 标准约 80 单/席/月、专业约 200 单、旗舰约 480 单。**价格留空**——正式价格由商务在配置里填。
 */
export const DEFAULT_BILLING: BillingConfig = {
  plans: [
    { id: "standard", label: "标准", seat_monthly_units: 200_000, seat_price_cny: null, note: "每席位每月约 80 单常规任务" },
    { id: "pro", label: "专业", seat_monthly_units: 500_000, seat_price_cny: null, note: "每席位每月约 200 单常规任务" },
    { id: "max", label: "旗舰", seat_monthly_units: 1_200_000, seat_price_cny: null, note: "每席位每月约 480 单常规任务" },
  ],
  default_plan: "standard",
  unit_cost_cny: null,
  boost_price_factor: 1,
};

const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9;

/** 校验并规范化套餐目录（配置错误启动即失败）。 */
export function validateBilling(raw: unknown): BillingConfig {
  if (raw === undefined || raw === null) return DEFAULT_BILLING;
  if (typeof raw !== "object") throw new Error("billing 须为对象");
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.plans) || b.plans.length === 0 || b.plans.length > 20) throw new Error("billing.plans 须为 1–20 个套餐");
  const seen = new Set<string>();
  const plans: PlanSpec[] = b.plans.map((p: any, i: number) => {
    if (!p || typeof p !== "object") throw new Error(`billing.plans[${i}] 不是对象`);
    if (typeof p.id !== "string" || !PLAN_ID_RE.test(p.id)) throw new Error(`billing.plans[${i}].id 只许小写字母、数字与连字符`);
    if (seen.has(p.id)) throw new Error(`billing.plans 套餐代码重复：${p.id}`);
    seen.add(p.id);
    if (typeof p.label !== "string" || p.label.length < 1 || p.label.length > 20) throw new Error(`billing.plans[${i}].label 须为 1–20 个字符`);
    if (!Number.isSafeInteger(p.seat_monthly_units) || p.seat_monthly_units < 1 || p.seat_monthly_units > 1e10) throw new Error(`billing.plans[${i}].seat_monthly_units 须为正整数`);
    if (p.seat_price_cny !== undefined && p.seat_price_cny !== null && !money(p.seat_price_cny)) throw new Error(`billing.plans[${i}].seat_price_cny 不合法`);
    if (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 60)) throw new Error(`billing.plans[${i}].note 至多 60 个字符`);
    return { id: p.id, label: p.label, seat_monthly_units: p.seat_monthly_units, seat_price_cny: p.seat_price_cny ?? null, ...(p.note ? { note: p.note } : {}) };
  });
  const def = typeof b.default_plan === "string" ? b.default_plan : plans[0]!.id;
  if (!seen.has(def)) throw new Error(`billing.default_plan 不在目录里：${def}`);
  if (b.unit_cost_cny !== undefined && b.unit_cost_cny !== null && !money(b.unit_cost_cny)) throw new Error("billing.unit_cost_cny 不合法");
  const f = b.boost_price_factor ?? 1;
  if (typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > 10) throw new Error("billing.boost_price_factor 须为 0–10");
  return { plans, default_plan: def, unit_cost_cny: (b.unit_cost_cny as number | null | undefined) ?? null, boost_price_factor: f };
}

export function planOf(cfg: BillingConfig, id: string | undefined): PlanSpec {
  return cfg.plans.find((p) => p.id === id) ?? cfg.plans.find((p) => p.id === cfg.default_plan)!;
}

/** 本月账单（元；没配价格的项为 null）：席位费 + 加量费；成本按已用单位估。 */
export function monthBill(cfg: BillingConfig, o: { plan: PlanSpec; seats: number; boost_pct: number; used_units: number }) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const seatFee = o.plan.seat_price_cny == null ? null : r2(o.plan.seat_price_cny * o.seats);
  const boostFee = seatFee === null ? null : r2((seatFee * o.boost_pct * (cfg.boost_price_factor ?? 1)) / 100);
  const cost = cfg.unit_cost_cny == null ? null : r2(o.used_units * cfg.unit_cost_cny);
  const revenue = seatFee === null ? null : r2(seatFee + (boostFee ?? 0));
  return { seat_fee_cny: seatFee, boost_fee_cny: boostFee, revenue_cny: revenue, cost_cny: cost, margin_cny: revenue !== null && cost !== null ? r2(revenue - cost) : null };
}
