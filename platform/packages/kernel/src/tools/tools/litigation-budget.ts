/**
 * calc.litigation_budget — 诉讼成本与回收测算（第 65 批，V39，D-279）。
 *
 * 律师最常被客户问的两句：“这官司打下来能拿回多少、要花多少”“对方给 X 万要不要和解”。产品此前只有定性的
 * 案情分析（不给胜诉率）与诉请金额测算，没有把诉讼费、保全费、担保费、律师费、执行回收放在一张表里比较。
 * 外部技能 billing-and-litigation-budget 的“诉讼经济性分析”用“胜诉概率 × 争议金额”求期望——这与工作准则第 7 条
 * （不预测裁判结果）冲突，也不是律师能对客户负责的说法。这里改为**情景并列**：每个情景写明“法院支持哪几项、各支持多少”，
 * 逐项算出我方要付的、能收回的与净额，再算出“和解金额达到多少时与该情景持平”。不给概率、不加权求期望。
 *
 * 规则（逐条对照法规库《诉讼费用交纳办法》原文）：
 * - 受理费由原告预交（第二十条第一款），败诉方负担；部分胜诉、部分败诉的由法院决定各自负担（第二十九条）——
 *   本工具按“支持金额 ÷ 请求金额”的比例分担作测算口径，并在假设里写明以法院决定为准；
 * - 简易程序、调解结案或撤诉减半（第十五、十六条，calc.court_fee 只减半一次）；调解结案的负担由双方协商（第三十一条）；
 * - 保全申请费由申请人负担，申请人起诉的可以列入诉讼请求（第三十八条第三款）；
 * - 申请执行费执行后交纳、由被执行人负担（第二十条第二款、第三十八条第一款）——原告不预付；被告不主动履行时多出这笔；
 * - 二审按不服一审判决部分的上诉请求数额交纳（第十七条）。
 * 律师费、鉴定费、公证费、保全担保费（保险保函报价）等不由本工具估计：律师给多少算多少，不给的不算并在 warnings 里列出。
 * 仲裁的费用按各机构费用表，本工具不算，由律师在 arbitration_fee_yuan 给出。
 */
import { DomainError } from "@zr-legal/domain";
import type { SheetSpec } from "@zr-legal/docx-engine";
import type { InvokeCtx } from "../registry.ts";
import { calcCourtFee, roundHalfUpCents } from "./court-fee.ts";
import { finishTable } from "./review.ts";

export type BudgetSide = "plaintiff" | "defendant";
export type BudgetStage = "first_instance" | "appeal" | "enforcement";

export interface BudgetClaim {
  /** 请求项目名称（如“货款本金”“逾期付款违约金”“律师费”）——情景里按这个名字指定支持比例 */
  label: string;
  amount_yuan: number;
  /**
   * 履行期尚未届满（第 65 批真实验收 v39-B1：未到期的质保金被算进“现在起诉”的情景与受理费）：这一项不进本次诉讼的请求、受理费与各情景，
   * 只在和解比较里作为“到期后另行主张”的部分——一揽子和解把它一并了结的，与“现在起诉 + 到期后另行收回”比较
   */
  not_yet_due?: boolean;
  /** 未届满项的到期日（写明，供说明引用） */
  due_on?: string;
}
export interface BudgetCost {
  label: string;
  amount_yuan: number;
  stage?: BudgetStage;
  /** 已经发生（已付或已确定要付、和解也省不下）的成本 */
  incurred?: boolean;
}
export interface BudgetScenario {
  label: string;
  /** 各请求项目统一的支持比例（0～1） */
  support?: number;
  /** 按请求项目逐项的支持比例（0～1）；没列到的项目按 0（不支持） */
  items?: Record<string, number>;
}
export interface LitigationBudgetParams {
  /** 我方是原告（申请人）还是被告（被申请人） */
  side: BudgetSide;
  forum?: "court" | "arbitration";
  /** 金钱请求逐项（原告视角是我方的请求，被告视角是对方的请求） */
  claims: BudgetClaim[];
  /** 一审是否适用简易程序（受理费减半） */
  simple_procedure?: boolean;
  /** 是否已经立案（已立案的，一审受理费已预交，和解也只能退一半） */
  filed?: boolean;
  /** 财产保全：申请保全的财产数额；担保费是律师给的报价（保险保函等）；fee_in_claims 为 true 表示保全申请费已列入诉讼请求 */
  preservation?: { amount_yuan: number; guarantee_fee_yuan?: number; fee_in_claims?: boolean };
  /** 情景里加上“我方对不利部分上诉”的二审受理费 */
  appeal?: boolean;
  /** 被告视角：不主动履行、被强制执行时多出的申请执行费 */
  forced_enforcement?: boolean;
  /** 我方自付的其他成本（律师费、鉴定费、公证费、差旅等），不含本工具会算的诉讼费、保全费 */
  costs?: BudgetCost[];
  /** 风险代理：按实际收回金额计的比例（0～1），律师给；只用于原告视角 */
  contingency_rate?: number;
  /** 情景；缺省“全部支持”“全部驳回”两个 */
  scenarios?: BudgetScenario[];
  /** 执行回收比例情景（0～1），缺省 [1]；只用于原告视角 */
  collection?: number[];
  /** 拟比较的和解金额（元） */
  settlement_offers?: number[];
  /** 和解金额是否一并了结未届满的请求（缺省：有未届满项时视为一并了结，按“现在起诉 + 到期后另行收回”比较） */
  settlement_covers_not_due?: boolean;
  /** 仲裁费（forum=arbitration 时由律师按机构费用表给） */
  arbitration_fee_yuan?: number;
}

export interface BudgetFeeRow {
  item: string;
  stage: BudgetStage;
  amount_yuan: number;
  payer: string;
  incurred: boolean;
  steps: string[];
  basis: string[];
}
export interface BudgetScenarioRow {
  scenario: string;
  /** 判决（裁决）支持的请求金额 */
  supported_yuan: number;
  support_ratio: number;
  /** 按比例分担的一审受理费：对方负担的部分（原告视角能随判决收回）/ 我方负担的部分 */
  fee_borne_by_counterparty_yuan: number;
  fee_borne_by_us_yuan: number;
  collection_ratio: number | null;
  /** 原告：判决应收（支持金额 + 对方负担的受理费 + 列入请求的保全费按比例）；被告：判决应付 */
  judgment_yuan: number;
  /** 原告：预计收回 = 判决应收 × 回收比例；被告：null */
  collected_yuan: number | null;
  /** 我方自己付出的全部费用（含已发生的） */
  our_costs_yuan: number;
  contingency_fee_yuan: number;
  /** 原告：净回收 = 预计收回 − 我方费用 − 风险代理费（可为负）；被告：总支出（负数） */
  net_yuan: number;
  notes: string[];
}
export interface LitigationBudgetResult {
  side: BudgetSide;
  forum: "court" | "arbitration";
  total_claim_yuan: number;
  fees: BudgetFeeRow[];
  scenarios: BudgetScenarioRow[];
  settlement: { offer_yuan: number; net_yuan: number; steps: string[]; versus: { scenario: string; diff_yuan: number }[] }[];
  /** 未届满、不进本次诉讼的请求（到期后另行主张） */
  not_due: { label: string; amount_yuan: number; due_on: string | null }[];
  /** 和解金额达到多少时，和解的净额与该情景持平 */
  break_even: { scenario: string; settlement_yuan: number; steps: string[] }[];
  assumptions: string[];
  basis: string[];
  warnings: string[];
}

const round2 = roundHalfUpCents;
const MAX_CLAIMS = 20;
const MAX_SCENARIOS = 6;
const MAX_COLLECTION = 3;
const money = (n: number) => round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r: number) => `${Math.round(r * 10000) / 100}%`;

function ratio(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new DomainError("validation", `${where} 须为 0～1 的数（如 0.6 表示支持六成），不是百分数`, 422);
  return v;
}
function amount(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new DomainError("validation", `${where} 须为非负数字（元）`, 422);
  return v;
}

export function calcLitigationBudget(p: LitigationBudgetParams): LitigationBudgetResult {
  if (p.side !== "plaintiff" && p.side !== "defendant") throw new DomainError("validation", "side 写 plaintiff（我方是原告或申请人）或 defendant（我方是被告或被申请人）", 422);
  const forum = p.forum ?? "court";
  if (forum !== "court" && forum !== "arbitration") throw new DomainError("validation", "forum 写 court 或 arbitration", 422);
  if (!Array.isArray(p.claims) || p.claims.length === 0) throw new DomainError("validation", "claims 至少一项：逐项写金钱请求的名称与金额", 422);
  if (p.claims.length > MAX_CLAIMS) throw new DomainError("validation", `claims 最多 ${MAX_CLAIMS} 项`, 422);
  const labels = new Set<string>();
  const notDue: { label: string; amount_yuan: number; due_on: string | null }[] = [];
  const claims = p.claims.flatMap((c, i) => {
    const label = String(c?.label ?? "").trim();
    if (!label) throw new DomainError("validation", `claims[${i}] 缺 label`, 422);
    if (labels.has(label)) throw new DomainError("validation", `claims 里“${label}”重复：同名的项目合并成一项`, 422);
    const amt = round2(amount(c.amount_yuan, `claims[${i}].amount_yuan`));
    if (c.not_yet_due === true) {
      notDue.push({ label, amount_yuan: amt, due_on: typeof c.due_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.due_on) ? c.due_on : null });
      return [];
    }
    labels.add(label);
    return [{ label, amount_yuan: amt }];
  });
  if (claims.length === 0) throw new DomainError("validation", "claims 里全部是未届满的请求：本次诉讼没有可以主张的金钱请求", 422);
  const total = round2(claims.reduce((s, c) => s + c.amount_yuan, 0));
  if (total <= 0) throw new DomainError("validation", "请求金额合计为 0：本工具只测算有金钱请求的案件", 422);

  const fees: BudgetFeeRow[] = [];
  const assumptions: string[] = [];
  const basis = new Set<string>();
  const warnings: string[] = [];
  const plaintiff = p.side === "plaintiff";

  // ── 一审受理费（或仲裁费）────────────────────────────────
  let firstFee = 0;
  let firstFull = 0;
  if (forum === "court") {
    const r = calcCourtFee({ kind: "case_property", amount_yuan: total, ...(p.simple_procedure ? { reductions: ["simple_procedure"] } : {}) });
    firstFee = r.fee_yuan;
    firstFull = r.full_fee_yuan;
    r.basis.forEach((b) => basis.add(b));
    basis.add("《诉讼费用交纳办法》第二十条第一款");
    basis.add("《诉讼费用交纳办法》第二十九条");
    fees.push({ item: p.simple_procedure ? "一审案件受理费（简易程序减半）" : "一审案件受理费", stage: "first_instance", amount_yuan: firstFee, payer: plaintiff ? "我方预交；判决后按支持比例由对方负担一部分" : "对方预交；判决后按支持比例由我方负担一部分", incurred: !!p.filed, steps: r.steps, basis: r.basis });
  } else {
    if (p.arbitration_fee_yuan === undefined) warnings.push("仲裁费按仲裁机构的费用表计算，本工具不估：没有给 arbitration_fee_yuan，测算里仲裁费按 0 计，请按机构费用表补上后重算");
    firstFee = round2(amount(p.arbitration_fee_yuan ?? 0, "arbitration_fee_yuan"));
    firstFull = firstFee;
    fees.push({ item: "仲裁费（律师按机构费用表给出）", stage: "first_instance", amount_yuan: firstFee, payer: plaintiff ? "我方预交；裁决按仲裁规则确定负担" : "对方预交；裁决按仲裁规则确定负担", incurred: !!p.filed, steps: [`仲裁费 ${money(firstFee)} 元（律师提供）`], basis: [] });
    assumptions.push("仲裁费的负担按各机构仲裁规则由仲裁庭决定，本表与诉讼一样按支持比例分担作测算");
  }

  // ── 保全 ─────────────────────────────────────────────
  let presFee = 0;
  let guarantee = 0;
  const presInClaims = !!p.preservation?.fee_in_claims;
  if (p.preservation) {
    if (!plaintiff) throw new DomainError("validation", "preservation 只用于原告（申请人）视角：被告视角不测算对方的保全费", 422);
    const pa = round2(amount(p.preservation.amount_yuan, "preservation.amount_yuan"));
    const r = calcCourtFee({ kind: "preservation", amount_yuan: pa });
    presFee = r.fee_yuan;
    r.basis.forEach((b) => basis.add(b));
    basis.add("《诉讼费用交纳办法》第三十八条第三款");
    fees.push({ item: "财产保全申请费", stage: "first_instance", amount_yuan: presFee, payer: presInClaims ? "我方预交；已列入诉讼请求，判决按支持比例由对方负担" : "我方负担（可以列入诉讼请求）", incurred: !!p.filed, steps: r.steps, basis: r.basis });
    if (p.preservation.guarantee_fee_yuan !== undefined) {
      guarantee = round2(amount(p.preservation.guarantee_fee_yuan, "preservation.guarantee_fee_yuan"));
      fees.push({ item: "保全担保费（律师提供的报价）", stage: "first_instance", amount_yuan: guarantee, payer: "我方负担", incurred: !!p.filed, steps: [`保全担保费 ${money(guarantee)} 元（律师提供）`], basis: [] });
    } else {
      warnings.push("申请保全一般要提供担保：没有给保全担保费（保险保函报价等），测算里按 0 计");
    }
  }

  // ── 其他自付成本 ───────────────────────────────────────
  const costs = (p.costs ?? []).map((c, i) => {
    const label = String(c?.label ?? "").trim();
    if (!label) throw new DomainError("validation", `costs[${i}] 缺 label`, 422);
    const stage: BudgetStage = c.stage ?? "first_instance";
    if (!["first_instance", "appeal", "enforcement"].includes(stage)) throw new DomainError("validation", `costs[${i}].stage 写 first_instance / appeal / enforcement`, 422);
    if (labels.has(label)) warnings.push(`“${label}”同时列在请求与自付成本里：作为请求向对方主张的部分按判决支持比例收回，自付成本照付，两者不抵销——如这是同一笔律师费，确认没有重复计算`);
    const amt = round2(amount(c.amount_yuan, `costs[${i}].amount_yuan`));
    fees.push({ item: label, stage, amount_yuan: amt, payer: "我方负担（律师提供）", incurred: !!c.incurred, steps: [`${label} ${money(amt)} 元（律师提供）`], basis: [] });
    return { label, stage, amount_yuan: amt, incurred: !!c.incurred };
  });
  if (!costs.some((c) => /律师费|代理费/.test(c.label))) warnings.push("没有给我方律师费：测算没有计入，净额偏高（原告）或支出偏低（被告），请按委托合同补上");
  if (p.appeal && !costs.some((c) => c.stage === "appeal")) warnings.push("算了二审受理费，但没有给二审阶段的律师费等成本");

  const contingency = p.contingency_rate === undefined ? 0 : ratio(p.contingency_rate, "contingency_rate");
  if (contingency > 0 && !plaintiff) throw new DomainError("validation", "contingency_rate（风险代理按收回金额计费）只用于原告视角", 422);

  // ── 情景 ─────────────────────────────────────────────
  const scen0 = p.scenarios && p.scenarios.length > 0 ? p.scenarios : [{ label: "全部支持", support: 1 }, { label: "全部驳回", support: 0 }];
  if (scen0.length > MAX_SCENARIOS) throw new DomainError("validation", `scenarios 最多 ${MAX_SCENARIOS} 个`, 422);
  const collection = plaintiff ? (p.collection && p.collection.length > 0 ? p.collection.map((c, i) => ratio(c, `collection[${i}]`)) : [1]) : [null];
  if (collection.length > MAX_COLLECTION) throw new DomainError("validation", `collection 最多 ${MAX_COLLECTION} 个`, 422);
  if (plaintiff && !p.collection) assumptions.push("执行回收按全部收回测算：对方履行能力、可供执行财产不明的，用 collection 并列几种回收比例（如 1、0.5、0）");

  const stageOn = (s: BudgetStage) => s === "first_instance" || (s === "appeal" && !!p.appeal) || (s === "enforcement" && (plaintiff || !!p.forced_enforcement));
  const otherCosts = costs.filter((c) => stageOn(c.stage)).reduce((s, c) => s + c.amount_yuan, 0);

  const rows: BudgetScenarioRow[] = [];
  const laterByScenario = new Map<string, number>();
  const supportOf: { label: string; supported: number; ratio: number; detail: string[]; later: number }[] = [];
  for (const [si, s] of scen0.entries()) {
    const label = String(s?.label ?? "").trim() || `情景${si + 1}`;
    if ((s.support === undefined) === (s.items === undefined)) throw new DomainError("validation", `scenarios[${si}]（${label}）：support（统一比例）与 items（逐项比例）给且只给一个`, 422);
    let supported = 0;
    const detail: string[] = [];
    if (s.support !== undefined) {
      const r = ratio(s.support, `scenarios[${si}].support`);
      supported = round2(total * r);
      detail.push(`各项请求统一支持 ${pct(r)}：${money(total)} × ${pct(r)} = ${money(supported)} 元`);
    } else {
      const items = s.items ?? {};
      for (const k of Object.keys(items)) {
        if (notDue.some((x) => x.label === k)) continue; // 未届满项不进本次诉讼的情景
        if (!labels.has(k)) throw new DomainError("validation", `scenarios[${si}]（${label}）的 items 里“${k}”不是 claims 里的项目名：照抄 claims 的 label（现有：${[...labels].join("、")}）`, 422);
      }
      for (const c of claims) {
        const r = items[c.label] === undefined ? 0 : ratio(items[c.label], `scenarios[${si}].items.${c.label}`);
        const v = round2(c.amount_yuan * r);
        supported += v;
        detail.push(`${c.label} ${money(c.amount_yuan)} × ${pct(r)} = ${money(v)} 元`);
      }
      supported = round2(supported);
    }
    const r = round2((supported / total) * 1e6) / 1e6;
    // 未届满项到期后另行主张能收回多少（第 65 批 v39-B1-r4）：情景逐项写了它的比例的按所写；统一比例的情景按同一比例（同一认定）；都没写的按全部
    const later = round2(notDue.reduce((n, x) => n + x.amount_yuan * (s.items && s.items[x.label] !== undefined ? ratio(s.items[x.label], `scenarios[${si}].items.${x.label}`) : s.support !== undefined ? s.support : 1), 0));
    supportOf.push({ label, supported, ratio: r, detail, later });
  }
  assumptions.push("部分支持时受理费按“支持金额 ÷ 请求金额”的比例分担，是测算口径；实际由法院根据案件具体情况决定（《诉讼费用交纳办法》第二十九条第二款）");
  assumptions.push("各情景并列，不是胜诉概率，也不加权求期望；哪个情景更接近，由律师结合证据判断");

  for (const s of supportOf) {
    laterByScenario.set(s.label, s.later);
    const byThem = round2(plaintiff ? firstFee * s.ratio : firstFee * (1 - s.ratio));
    const byUs = round2(firstFee - byThem);
    // 二审：我方对不利部分上诉（原告就未支持部分、被告就已支持部分）
    let appealFee = 0;
    const notes = [...s.detail];
    if (p.appeal && forum === "court") {
      const base = round2(plaintiff ? total - s.supported : s.supported);
      if (base > 0) {
        const ar = calcCourtFee({ kind: "case_property", amount_yuan: base });
        appealFee = ar.fee_yuan;
        basis.add("《诉讼费用交纳办法》第十七条");
        notes.push(`我方就${plaintiff ? "未获支持" : "被判支付"}的 ${money(base)} 元上诉，二审受理费 ${money(appealFee)} 元（按上诉请求数额；二审改判的，费用负担随之调整，本表不再测算二审结果）`);
      } else notes.push("这一情景我方没有不利部分，不上诉");
    }
    if (plaintiff) {
      const presBack = presInClaims ? round2(presFee * s.ratio) : 0;
      const judgment = round2(s.supported + byThem + presBack);
      const ourCosts = round2(firstFee + presFee + guarantee + otherCosts + appealFee);
      for (const c of collection) {
        const cr = c as number;
        const collected = round2(judgment * cr);
        const cfee = round2(s.supported * cr * contingency);
        const net = round2(collected - ourCosts - cfee);
        const n2 = [...notes];
        if (s.supported > 0) n2.push(`判决应收 = 支持金额 ${money(s.supported)} + 对方负担的受理费 ${money(byThem)}${presInClaims ? ` + 对方负担的保全申请费 ${money(presBack)}` : ""} = ${money(judgment)} 元；按回收 ${pct(cr)} 收回 ${money(collected)} 元`);
        if (cfee > 0) n2.push(`风险代理费 = 收回的请求金额 ${money(s.supported * cr)} × ${pct(contingency)} = ${money(cfee)} 元`);
        n2.push(`净回收 = ${money(collected)} − 我方费用 ${money(ourCosts)}${cfee > 0 ? ` − 风险代理费 ${money(cfee)}` : ""} = ${money(net)} 元`);
        rows.push({ scenario: s.label, supported_yuan: s.supported, support_ratio: s.ratio, fee_borne_by_counterparty_yuan: byThem, fee_borne_by_us_yuan: byUs, collection_ratio: cr, judgment_yuan: judgment, collected_yuan: collected, our_costs_yuan: ourCosts, contingency_fee_yuan: cfee, net_yuan: net, notes: n2 });
      }
    } else {
      let enfFee = 0;
      if (p.forced_enforcement && s.supported > 0 && forum === "court") {
        const er = calcCourtFee({ kind: "enforcement", amount_yuan: s.supported });
        enfFee = er.fee_yuan;
        basis.add("《诉讼费用交纳办法》第三十八条第一款");
        notes.push(`不主动履行被强制执行的，另负担申请执行费 ${money(enfFee)} 元；迟延履行期间的加倍债务利息另计，本表未测算`);
      }
      const judgment = round2(s.supported + byUs + enfFee);
      const ourCosts = round2(otherCosts + appealFee);
      const net = round2(-(judgment + ourCosts));
      notes.push(`总支出 = 判决应付 ${money(s.supported)} + 我方负担的受理费 ${money(byUs)}${enfFee > 0 ? ` + 申请执行费 ${money(enfFee)}` : ""} + 我方费用 ${money(ourCosts)} = ${money(-net)} 元`);
      rows.push({ scenario: s.label, supported_yuan: s.supported, support_ratio: s.ratio, fee_borne_by_counterparty_yuan: byThem, fee_borne_by_us_yuan: byUs, collection_ratio: null, judgment_yuan: judgment, collected_yuan: null, our_costs_yuan: ourCosts, contingency_fee_yuan: 0, net_yuan: net, notes });
    }
  }

  // ── 和解比较与持平点 ───────────────────────────────────
  // 现在和解：已发生的成本收不回；已立案的，撤诉或调解受理费减半（第十五条），调解结案的负担由双方协商（第三十一条）——
  // 原告视角按“我方负担减半后的受理费”、被告视角按“不负担受理费”测算，并写进假设
  const incurredOther = costs.filter((c) => c.incurred && stageOn(c.stage)).reduce((s, c) => s + c.amount_yuan, 0);
  let settleCost = incurredOther;
  const settleSteps: string[] = [];
  if (plaintiff) {
    if (p.filed) {
      const half = round2(firstFull / 2);
      settleCost += half + (presFee + guarantee);
      settleSteps.push(`已立案：撤诉或调解的受理费减半为 ${money(half)} 元，按我方负担测算（调解结案的负担由双方协商，《诉讼费用交纳办法》第十五条、第三十一条）；保全申请费与担保费 ${money(presFee + guarantee)} 元已发生`);
      basis.add("《诉讼费用交纳办法》第十五条");
      basis.add("《诉讼费用交纳办法》第三十一条");
    } else settleSteps.push("尚未立案：现在和解不发生受理费与保全费");
  }
  if (incurredOther > 0) settleSteps.push(`已发生、和解也省不下的其他成本 ${money(incurredOther)} 元`);
  settleCost = round2(settleCost);
  // 未届满项（第 65 批）：和解一并了结的，诉讼一方按“现在起诉 + 到期后另行收回（按同一回收比例，不计另诉的成本）”比较；被告视角是“到期后另行支付”
  const laterTotal = round2(notDue.reduce((n, x) => n + x.amount_yuan, 0));
  const covers = laterTotal > 0 && p.settlement_covers_not_due !== false;
  const laterOf = (r: BudgetScenarioRow) => {
    if (!covers) return 0;
    const base = laterByScenario.get(r.scenario) ?? laterTotal;
    return round2(plaintiff ? base * (r.collection_ratio ?? 1) : -base);
  };
  const scenName = (r: BudgetScenarioRow) => (r.collection_ratio === null || collection.length === 1 ? r.scenario : `${r.scenario}（回收 ${pct(r.collection_ratio)}）`);
  const settlement = (p.settlement_offers ?? []).slice(0, 6).map((x, i) => {
    const offer = round2(amount(x, `settlement_offers[${i}]`));
    const net = plaintiff ? round2(offer - settleCost) : round2(-(offer + settleCost));
    return {
      offer_yuan: offer,
      net_yuan: net,
      steps: [
        ...settleSteps,
        plaintiff ? `和解净得 = ${money(offer)} − ${money(settleCost)} = ${money(net)} 元` : `和解总支出 = ${money(offer)} + ${money(settleCost)} = ${money(-net)} 元`,
        ...(covers ? [`和解一并了结尚未届满的 ${notDue.map((x) => `${x.label} ${money(x.amount_yuan)} 元${x.due_on ? `（${x.due_on} 到期）` : ""}`).join("、")}：各情景按“现在起诉的净额 ${plaintiff ? "＋ 到期后另行收回的部分（按同一回收比例，另诉成本未计）" : "＋ 到期后另行支付的部分"}”比较`] : []),
      ],
      versus: rows.map((r) => ({ scenario: scenName(r), diff_yuan: round2(net - (r.net_yuan + laterOf(r))) })),
    };
  });
  const break_even = rows.map((r) => {
    const name = scenName(r);
    const v = plaintiff ? round2(r.net_yuan + laterOf(r) + settleCost) : round2(-(r.net_yuan + laterOf(r)) - settleCost);
    const later = laterOf(r);
    // 第 65 批真实验收（v39-B2-r3 评分）：持平点为 0 或负数时原先仍写“低于此数和解少付”，读不通——写明“任何金额的和解都不比该情景有利”
    const tail = plaintiff
      ? v <= 0 ? "（该情景净回收不高于现在和解仍要承担的成本：任何金额的和解都比该情景多得）" : "（高于此数，和解比该情景多得）"
      : v <= 0 ? "（该情景总支出不高于现在和解也省不下的成本：任何金额的和解都不比该情景少付）" : "（低于此数，和解比该情景少付）";
    return { scenario: name, settlement_yuan: v, steps: [plaintiff ? `和解金额 = 该情景净回收 ${money(r.net_yuan)}${later ? ` + 到期后另行收回 ${money(later)}` : ""} + 现在和解仍要承担的 ${money(settleCost)} = ${money(v)} 元${tail}` : `和解金额 = 该情景总支出 ${money(-r.net_yuan)}${later ? ` + 到期后另行支付 ${money(-later)}` : ""} − 现在和解仍要承担的 ${money(settleCost)} = ${money(v)} 元${tail}`] };
  });
  if (settleSteps.length > 0) assumptions.push(...settleSteps.map((x) => `和解测算：${x}`));
  if (laterTotal > 0) assumptions.push(`尚未届满的请求（${notDue.map((x) => `${x.label} ${money(x.amount_yuan)} 元${x.due_on ? `，${x.due_on} 到期` : ""}`).join("；")}）不进本次诉讼的请求、受理费与各情景：起诉时尚未到期的债权法院不会判令给付，到期后可追加请求或另诉${covers ? "；和解比较按“现在起诉 + 到期后另行主张”" : ""}`);
  // 第 65 批真实验收（v39-B2-r2 评分）：原先不分原告被告都写“早收回”，并写了没有依据的“数月至一年以上”——周期交律师按经验补
  assumptions.push(plaintiff ? "不计时间成本与资金占用：诉讼、上诉与执行所需的周期由律师按经验补充；和解的价值还在于早收回、少占用律师与管理层时间，由律师与客户另行权衡" : "不计时间成本与资金占用：诉讼、上诉与执行所需的周期由律师按经验补充；和解的价值还在于早了结争议、免去判决后的执行与迟延履行风险、少占用律师与管理层时间，由律师与客户另行权衡");
  if (plaintiff) warnings.push("执行回收比例是假设，不是对对方履行能力的判断：对方财产情况不明的，先做财产调查或申请保全，再定回收比例");
  warnings.push("费用按《诉讼费用交纳办法》预估，以受理法院的交费通知为准；律师费、鉴定费、担保费等以律师提供的数为准");

  return { side: p.side, forum, total_claim_yuan: total, fees, scenarios: rows, settlement, break_even, not_due: notDue, assumptions, basis: [...basis], warnings: [...new Set(warnings)] };
}

// ── 工具入口：给了 title 就由内核直接写成《诉讼成本与回收测算》Excel（数字不经模型转抄）──────────────

type Cell = string | number | null;
const STAGE_LABEL: Record<BudgetStage, string> = { first_instance: "一审", appeal: "二审", enforcement: "执行" };

export function litigationBudgetWorkbook(p: LitigationBudgetParams, r: LitigationBudgetResult): SheetSpec[] {
  const plaintiff = r.side === "plaintiff";
  const sheets: SheetSpec[] = [];
  const multi = plaintiff && r.scenarios.some((x, i, a) => a.findIndex((y) => y.scenario === x.scenario) !== i);
  // 情景测算（主表）：派生列带公式，律师改回收比例、我方费用，净额跟着重算。
  // 第 71 批第二轮：比例按百分比显示（原先 0.73568783）；每个情景的计算过程挪到紧跟的“情景计算过程”表——
  // 长文字在主表最后一列换行，把每一行撑到五六行高，主表的数字反而看不全
  const steps: Cell[][] = [["情景", "计算过程"]];
  if (plaintiff) {
    const rate = p.contingency_rate ?? 0;
    const rows: Cell[][] = [["情景", "支持金额（元）", "支持比例", "回收比例", "判决应收（元）", "预计收回（元）", "我方费用（元）", "风险代理费（元）", "净回收（元）"]];
    const formulas: Record<string, string> = {};
    const percents: string[] = [];
    r.scenarios.forEach((s, i) => {
      const n = i + 2;
      const name = multi ? `${s.scenario}（回收 ${Math.round((s.collection_ratio ?? 1) * 100)}%）` : s.scenario;
      rows.push([name, s.supported_yuan, s.support_ratio, s.collection_ratio, s.judgment_yuan, s.collected_yuan, s.our_costs_yuan, s.contingency_fee_yuan, s.net_yuan]);
      steps.push([name, s.notes.join("；")]);
      percents.push(`C${n}`, `D${n}`);
      formulas[`F${n}`] = `ROUND(E${n}*D${n},2)`;
      if (rate > 0) formulas[`H${n}`] = `ROUND(B${n}*D${n}*${rate},2)`;
      formulas[`I${n}`] = `ROUND(F${n}-G${n}-H${n},2)`;
    });
    sheets.push({ name: "情景测算", rows, formulas, percents });
  } else {
    const rows: Cell[][] = [["情景", "判决支付的请求金额（元）", "支持比例", "我方负担的受理费（元）", "判决应付合计（元）", "我方费用（元）", "总支出（元）"]];
    const formulas: Record<string, string> = {};
    const percents: string[] = [];
    r.scenarios.forEach((s, i) => {
      const n = i + 2;
      rows.push([s.scenario, s.supported_yuan, s.support_ratio, s.fee_borne_by_us_yuan, s.judgment_yuan, s.our_costs_yuan, -s.net_yuan]);
      steps.push([s.scenario, s.notes.join("；")]);
      percents.push(`C${n}`);
      formulas[`G${n}`] = `ROUND(E${n}+F${n},2)`;
    });
    sheets.push({ name: "情景测算", rows, formulas, percents });
  }
  sheets.push({ name: "情景计算过程", rows: steps });
  // 请求与支持比例：每个情景各项请求支持多少
  const scen = p.scenarios && p.scenarios.length > 0 ? p.scenarios : [{ label: "全部支持", support: 1 }, { label: "全部驳回", support: 0 }];
  const head: Cell[] = ["请求项目", "请求金额（元）", ...scen.map((s, i) => `${String(s.label ?? "").trim() || `情景${i + 1}`}（支持比例）`)];
  const due = p.claims.filter((c) => c.not_yet_due !== true);
  const body: Cell[][] = due.map((c) => [String(c.label).trim(), c.amount_yuan, ...scen.map((s) => (s.support !== undefined ? s.support : (s.items?.[String(c.label).trim()] ?? 0)))]);
  body.push(["合计（本次诉讼）", r.total_claim_yuan, ...scen.map(() => null)]);
  const later: Cell[][] = r.not_due.map((x) => [`${x.label}（履行期未届满，${x.due_on ? `${x.due_on} 到期，` : ""}不进本次诉讼）`, x.amount_yuan, ...scen.map(() => null)]);
  // 第 71 批第二轮：各情景的支持比例按百分比显示
  const ratioCells = body.slice(0, due.length).flatMap((_, bi) => scen.map((__, si) => `${String.fromCharCode(67 + si)}${bi + 2}`));
  sheets.push({ name: "请求与支持比例", rows: [head, ...body, ...later], formulas: { [`B${body.length + 1}`]: `SUM(B2:B${body.length})` }, percents: ratioCells });
  // 费用明细
  sheets.push({ name: "费用明细", rows: [["项目", "阶段", "金额（元）", "负担", "是否已发生", "计算过程", "依据"], ...r.fees.map((f): Cell[] => [f.item, STAGE_LABEL[f.stage], f.amount_yuan, f.payer, f.incurred ? "已发生" : "未发生", f.steps.join("；"), f.basis.join("；")])] });
  // 和解：持平点与方案比较
  const be: Cell[][] = [["情景", "和解持平金额（元）", "说明"], ...r.break_even.map((b): Cell[] => [b.scenario, b.settlement_yuan, b.steps.join("；")])];
  sheets.push({ name: "和解持平点", rows: be });
  if (r.settlement.length > 0) {
    const names = r.settlement[0]!.versus.map((v) => v.scenario);
    // 列名写明正负的含义（第 65 批 v39-B2-r3 评分：列名固定写“少付”，多付填负数，读者易误读）
    sheets.push({ name: "和解方案比较", rows: [["和解金额（元）", plaintiff ? "和解净得（元）" : "和解总支出（元）", ...names.map((n) => (plaintiff ? `比“${n}”多得（元，负数为少得）` : `比“${n}”少付（元，负数为多付）`)), "计算过程"], ...r.settlement.map((s): Cell[] => [s.offer_yuan, plaintiff ? s.net_yuan : -s.net_yuan, ...s.versus.map((v) => v.diff_yuan), s.steps.join("；")])] });
  }
  sheets.push({ name: "口径与假设", rows: [["类别", "内容"], ...r.assumptions.map((a): Cell[] => ["测算口径", a]), ...r.basis.map((b): Cell[] => ["依据", b]), ...r.warnings.map((w): Cell[] => ["提示", w])] });
  return sheets;
}

export function calcLitigationBudgetTool(ctx: InvokeCtx, p: LitigationBudgetParams & { title?: string }) {
  const { title: title0, ...params } = p ?? ({} as LitigationBudgetParams & { title?: string });
  const r = calcLitigationBudget(params);
  const out: Record<string, unknown> = {
    ...r,
    how_to_use:
      "文书与答复里用到的金额逐字照抄这里的数，不要自己再加减；情景是“如果法院支持这些”的并列测算，不是胜诉概率：写成“如全部支持……如只支持本金……”，不写“大概率”“期望值”。" +
      "回收比例、律师费、担保费是律师给的假设或报价，原样写明来源；warnings 里缺的数（律师费、担保费、仲裁费）在答复里请律师补上后重算。",
  };
  const title = typeof title0 === "string" ? title0.trim() : "";
  if (title) {
    out.workbook = finishTable(ctx, title, litigationBudgetWorkbook(params, r), "calc.litigation_budget", { computed: true });
    out.workbook_note = "测算表已生成并登记为本任务成果：情景测算、请求与支持比例、费用明细、和解持平点（有拟比较的和解金额时另有方案比较）、口径与假设各表的数字由系统写入，主表派生列带公式。要改数就改参数、用同一个 title 重新调用本工具；不要另用 xlsx.render_table 重抄这些数。这是给律师与客户决策用的内部测算，不作为起诉状或申请书的附件。";
  }
  return out;
}
