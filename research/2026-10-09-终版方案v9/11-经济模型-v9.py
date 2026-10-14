#!/usr/bin/env python3
"""Kimi Work 法律行业发行版 · 经济模型 v9（规划模型，不是计费代码）。

在 v7 模型结构上改输入与少量机制（v7 结构经过一轮对抗式审阅）：
- 云地划分：本地事项为默认（案卷在律所侧处理，算力由律所硬件承担）；中软云端为控制面、能力网关（模型、检索、法源、无事项问答）、
  中继（端到端加密共享与设备中继）；G3（2028 起计）提供云端事项与云端执行面，按采用比例计入每席云端成本。
- 执行域：WASM 执行域为默认，桌面支持成本较 v7 略降；不再设“Windows 沙箱覆盖不足导致席位 −15%/−30%”的主风险，改为兼容性小幅敏感性。
- 节奏：设计合作律所 2027-04 起转付费，公开销售目标 2027-06，专业版自助 2027-09；2027 年末席位相应下调。
- 开放任务：子 Agent 默认走低价模型池（K2.6 级），主循环 K3。
- 新增机制：pro_start_month_2027；cloud_matters（云端事项采用比例与每席年成本）；base_sensitivity（主口径，默认“加量收入为零”）；
  敏感性 paid_start_month_override、year_seat_factor、cloud_matters_factor、subagent_k3_share（子 Agent 改用 K3 的比例）。
- 对抗式审阅（2026-10-10）后：主口径改为零加量收入；桌面支持成本恢复 v7 水平（待试点实测）；编制按到岗爬坡（2026 年均 32 人）。

只用 Python 标准库。按月模拟 2026-10 至 2030-12：
  任务成本（含缓存写入、重试、OCR、法源、检索按次费）→ 用户画像与额度（团队池化/个人不池化）
  → 各版本每席收入与贡献 → 席位爬坡 → 损益、现金流（年付预收）、盈亏平衡与敏感性。

用法：
  python3 11-经济模型-v9.py                       # 打印基准情景摘要
  python3 11-经济模型-v9.py --output results.json # 全部情景与敏感性写入 JSON
  python3 11-经济模型-v9.py --markdown summary.md # 生成可嵌入方案的摘要表
"""
from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent


# ---------------------------------------------------------------- 任务与画像
def task_cost(task: dict, prices: dict, token_factor: float = 1.0, no_cache: bool = False) -> dict:
    model = 0.0
    for step in task["steps"]:
        p = prices[step["model"]]
        if no_cache:
            inp = (step["miss_k"] + step["hit_k"]) * p["miss"]
        else:
            inp = (step["miss_k"] * p["miss"] + step["hit_k"] * p["hit"]
                   + step["write_5m_k"] * p["write_5m"] + step["write_1h_k"] * p["write_1h"])
        model += (inp + step["output_k"] * p["output"]) / 1000.0
    model *= token_factor
    retry = model * task["retry_fraction"]
    total = model + retry + task["ocr"] + task["data"] + task["compute"]
    return {"name": task["name"], "points": task["points"], "model": round(model, 4),
            "retry": round(retry, 4), "ocr": task["ocr"], "data": task["data"],
            "compute": task["compute"], "variable_total": round(total, 4),
            "cost_per_point": round(total / task["points"], 4)}


def persona_stats(cfg: dict, tasks: dict) -> dict:
    out = {}
    for name, persona in cfg["personas"].items():
        req_points = sum(n * tasks[k]["points"] for k, n in persona["monthly_tasks"].items())
        cost = sum(n * tasks[k]["variable_total"] for k, n in persona["monthly_tasks"].items())
        out[name] = {"weight": persona["weight"], "monthly_points_requested": req_points,
                     "monthly_unrestricted_cost": round(cost, 2),
                     "cost_per_point": round(cost / req_points, 4) if req_points else 0.0}
    return out


def seat_economics(cfg: dict, tasks: dict, personas: dict, edition_key: str,
                   addon_share: float, force_full: bool, realization_override: float | None,
                   support_add: float = 0.0) -> dict:
    """单个生产席位（或审阅席）的年度收入与可变成本。"""
    ed = dict(cfg["editions"][edition_key])
    ed["support"] = ed["support"] + support_add
    quota = ed["monthly_points"]
    price_pt = cfg["addon"]["price_per_point"]
    realization = ed["realization"]
    if realization_override is not None and edition_key in ("team", "firm", "reviewer"):
        realization = realization_override
    # 加权的每点成本（按请求点数加权）
    total_req = sum(p["weight"] * p["monthly_points_requested"] for p in personas.values())
    total_cost = sum(p["weight"] * p["monthly_unrestricted_cost"] for p in personas.values())
    cpp_blend = total_cost / total_req if total_req else 0.0

    if edition_key == "reviewer":
        qa_cpp = tasks["qa"]["cost_per_point"]
        consumed = quota * (1.0 if force_full else 0.5)
        task_cost_m = consumed * qa_cpp
        addon_pts = 0.0
        addon_cost_m = 0.0
    elif ed["pooled"]:
        consumed = quota if force_full else min(total_req, quota)
        task_cost_m = consumed * cpp_blend
        over = max(0.0, total_req - quota)
        addon_pts = over * addon_share
        addon_cost_m = addon_pts * cpp_blend
    else:  # 个人不池化
        share = cfg["addon"]["pro_overquota_purchase_share"] if addon_share > 0 else 0.0
        task_cost_m = 0.0
        addon_pts = 0.0
        addon_cost_m = 0.0
        consumed = 0.0
        for p in personas.values():
            c = quota if force_full else min(p["monthly_points_requested"], quota)
            consumed += p["weight"] * c
            task_cost_m += p["weight"] * c * p["cost_per_point"]
            over = max(0.0, p["monthly_points_requested"] - quota)
            addon_pts += p["weight"] * over * share
            addon_cost_m += p["weight"] * over * share * p["cost_per_point"]

    net_price = ed["list_price"] * realization
    addon_rev = addon_pts * price_pt * 12
    variable = task_cost_m * 12 + ed["storage"] + ed["support"]
    addon_cost = addon_cost_m * 12
    payment_fee = net_price * cfg["channel"]["payment_fee_rate_pro"] if edition_key == "pro" else 0.0
    contribution = net_price + addon_rev - variable - addon_cost - payment_fee
    return {"edition": ed["label"], "net_subscription": round(net_price, 2),
            "addon_revenue": round(addon_rev, 2), "monthly_points_consumed": round(consumed, 1),
            "task_cost": round(task_cost_m * 12, 2), "storage": ed["storage"], "support": ed["support"],
            "addon_cost": round(addon_cost, 2), "payment_fee": round(payment_fee, 2),
            "contribution_before_channel": round(contribution, 2),
            "contribution_margin": round(contribution / (net_price + addon_rev), 4) if net_price + addon_rev else None}


# ---------------------------------------------------------------- 席位爬坡
def month_index(year: int, month: int) -> int:
    return (year - 2026) * 12 + (month - 1)


def seat_curve(year_end: dict, start_month_2027: int, pro_start_month_2027: int, years: list) -> dict:
    """返回 {edition: [每月月末席位]}，2026-01 起计 60 个月（只用 2026-10 之后）。"""
    months = 12 * (years[-1] - 2026 + 1)
    curves = {}
    for ed in ("team", "firm", "pro"):
        arr = [0.0] * months
        prev_val, prev_idx = 0.0, month_index(2027, (pro_start_month_2027 if ed == "pro" else start_month_2027)) - 1
        for y in years:
            if str(y) not in year_end:
                continue
            target = float(year_end[str(y)][ed])
            end_idx = month_index(y, 12)
            span = end_idx - prev_idx
            for i in range(prev_idx + 1, end_idx + 1):
                arr[i] = prev_val + (target - prev_val) * (i - prev_idx) / span
            prev_val, prev_idx = target, end_idx
        curves[ed] = arr
    return curves


def linear_by_year(year_end: dict, years: list, start_idx: int) -> list:
    months = 12 * (years[-1] - 2026 + 1)
    arr = [0.0] * months
    prev_val, prev_idx = 0.0, start_idx - 1
    for y in years:
        if str(y) not in year_end:
            continue
        target = float(year_end[str(y)])
        end_idx = month_index(y, 12)
        span = max(1, end_idx - prev_idx)
        for i in range(prev_idx + 1, end_idx + 1):
            arr[i] = prev_val + (target - prev_val) * (i - prev_idx) / span
        prev_val, prev_idx = target, end_idx
    return arr


# ---------------------------------------------------------------- 损益与现金
def simulate(cfg: dict, scenario_key: str, sens: dict | None = None) -> dict:
    # 主口径（base_sensitivity，如“加量收入为零”）先合并，单项敏感性再覆盖
    sens = {**cfg.get("base_sensitivity", {}), **(sens or {})}
    token_factor = sens.get("token_price_factor", 1.0)
    addon_share = sens.get("addon_share_override", cfg["addon"]["share_of_overquota_demand_purchased"])
    force_full = sens.get("force_full_quota", False)
    realization_override = sens.get("realization_override")
    hc_factor = sens.get("headcount_factor", 1.0)
    data_factor = sens.get("legal_data_factor", 1.0)
    no_cache = sens.get("no_cache", False)
    cloud_factor = sens.get("cloud_platform_factor", 1.0)
    compliance_factor = sens.get("compliance_factor", 1.0)
    team_seat_factor = sens.get("team_seat_factor", 1.0)

    search_factor = sens.get("search_price_factor", 1.0)
    open_task_factor = sens.get("open_task_factor", 1.0)
    open_task_counts = sens.get("open_task_counts")
    open_task_token_factor = sens.get("open_task_token_factor", 1.0)
    if search_factor != 1.0 or open_task_factor != 1.0 or open_task_counts or open_task_token_factor != 1.0:
        cfg = copy.deepcopy(cfg)
        for t in cfg["task_assumptions"].values():
            t["compute"] = t["compute"] * search_factor
        for name, persona in cfg["personas"].items():
            if open_task_counts:
                persona["monthly_tasks"]["open_task"] = open_task_counts[name]
            persona["monthly_tasks"]["open_task"] = persona["monthly_tasks"]["open_task"] * open_task_factor
        if open_task_token_factor != 1.0:
            for step in cfg["task_assumptions"]["open_task"]["steps"]:
                for k in ("miss_k", "hit_k", "write_5m_k", "write_1h_k", "output_k"):
                    step[k] = step[k] * open_task_token_factor
    k3_share = sens.get("subagent_k3_share", 0.0)
    if k3_share:
        cfg = copy.deepcopy(cfg)
        new_steps = []
        for step in cfg["task_assumptions"]["open_task"]["steps"]:
            if step["model"] == "K2.6":
                keep = {k: (v * (1 - k3_share) if k.endswith("_k") else v) for k, v in step.items()}
                moved = {k: (v * k3_share if k.endswith("_k") else v) for k, v in step.items()}
                moved["model"] = "K3"
                new_steps += [keep, moved]
            else:
                new_steps.append(step)
        cfg["task_assumptions"]["open_task"]["steps"] = new_steps
    tasks = {k: task_cost(t, cfg["price_per_million_tokens"], token_factor, no_cache) for k, t in cfg["task_assumptions"].items()}
    personas = persona_stats(cfg, tasks)
    support_add = sens.get("support_add", 0.0)
    seat = {k: seat_economics(cfg, tasks, personas, k, addon_share, force_full, realization_override, support_add)
            for k in ("team", "firm", "pro", "reviewer")}

    sc = copy.deepcopy(cfg["scenarios"][scenario_key])
    for yk, fct in sens.get("year_seat_factor", {}).items():
        if yk in sc["year_end_production_seats"]:
            for ek in sc["year_end_production_seats"][yk]:
                sc["year_end_production_seats"][yk][ek] = sc["year_end_production_seats"][yk][ek] * fct
    production_seat_factor = sens.get("production_seat_factor", 1.0)
    if team_seat_factor != 1.0 or production_seat_factor != 1.0:
        for yv in sc["year_end_production_seats"].values():
            yv["team"] = yv["team"] * team_seat_factor * production_seat_factor
            yv["firm"] = yv["firm"] * production_seat_factor
    years = cfg["years"]
    start_m = sens.get("paid_start_month_override", cfg["launch"]["paid_start_month_2027"])
    pro_m = max(start_m, cfg["launch"].get("pro_start_month_2027", 7))
    curves = seat_curve(sc["year_end_production_seats"], start_m, pro_m, years)
    firm_customers = linear_by_year(sc["firm_customers_year_end"], years, month_index(2027, start_m))
    months = len(curves["team"])
    ratio_rev = cfg["reviewer_seats_per_production_seat"]
    ed = cfg["editions"]
    platform_fee = ed["firm"]["platform_fee_per_customer"]
    chan = cfg["channel"]
    pdp = cfg["private_deployment"]
    svc = cfg["services"]

    annual = {}
    cash_cum, cash_trough = 0.0, 0.0
    op_cum, op_trough = 0.0, 0.0
    billed_history = {ek: [0.0] * months for ek in ("team", "firm", "pro", "reviewer")}
    prev = {ek: 0.0 for ek in ("team", "firm", "pro", "reviewer")}
    deals_total_before = 0
    for y in years:
        ys = str(y)
        row = {k: 0.0 for k in ("subscription", "reviewer", "platform_fee", "addon", "services", "private",
                                "task_cogs", "storage_support_cogs", "addon_cogs", "services_cogs", "private_cogs", "platform_fee_cogs",
                                "payment_fees", "legal_data", "cloud_platform", "headcount", "experts",
                                "sales_marketing", "compliance", "ga", "channel_commission", "cash_in")}
        active_months = cfg["year_months_active"][ys]
        cm = cfg.get("cloud_matters", {})
        cm_share = cm.get("share_of_production_seats", {}).get(ys, 0.0) * sens.get("cloud_matters_factor", 1.0)
        cm_cost_seat_year = cm.get("cost_per_seat_year", 0.0)
        first_idx = month_index(y, 1) if y > 2026 else month_index(2026, 10)
        for i in range(first_idx, month_index(y, 12) + 1):
            seats_m = {ek: curves[ek][i] for ek in ("team", "firm", "pro")}
            seats_m["reviewer"] = (seats_m["team"] + seats_m["firm"]) * ratio_rev
            row["storage_support_cogs"] += (seats_m["team"] + seats_m["firm"] + seats_m["pro"]) * cm_share * cm_cost_seat_year / 12
            free_rev = (seats_m["team"] + seats_m["firm"]) * cfg.get("reviewer_free_seats_per_production_seat", 0.0)
            rvs = seat["reviewer"]
            row["task_cogs"] += free_rev * rvs["task_cost"] / 12
            row["storage_support_cogs"] += free_rev * (rvs["storage"] + rvs["support"]) / 12
            for ek in ("team", "firm", "pro", "reviewer"):
                s = seat[ek]
                n = seats_m[ek]
                rev_sub = n * s["net_subscription"] / 12
                if ek == "reviewer":
                    row["reviewer"] += rev_sub
                else:
                    row["subscription"] += rev_sub
                row["addon"] += n * s["addon_revenue"] / 12
                row["task_cogs"] += n * s["task_cost"] / 12
                row["storage_support_cogs"] += n * (s["storage"] + s["support"]) / 12
                row["addon_cogs"] += n * s["addon_cost"] / 12
                row["payment_fees"] += n * s["payment_fee"] / 12
                # 现金：新增席位与 12 个月前的批次续费按年预收
                added = max(0.0, n - prev[ek])
                renew = billed_history[ek][i - 12] if i >= 12 else 0.0
                billed_history[ek][i] = added + renew
                row["cash_in"] += (added + renew) * s["net_subscription"]
                if ek in ("team", "firm"):
                    row["services"] += added * svc["onboarding_revenue_per_new_team_seat"]
                    row["services_cogs"] += added * svc["onboarding_revenue_per_new_team_seat"] * svc["onboarding_cost_ratio"]
                prev[ek] = n
            row["platform_fee"] += firm_customers[i] * platform_fee / 12
            row["platform_fee_cogs"] += firm_customers[i] * cfg["editions"]["firm"].get("platform_fee_cost_per_customer", 0.0) / 12
        row["cash_in"] += row["platform_fee"] + row["addon"] + row["services"]
        # 私有化：成交当年确认首年合同，此后每年维护费
        new_deals = sc["private_deployment_new_deals"].get(ys, 0)
        row["private"] = new_deals * pdp["first_year_contract"] + deals_total_before * pdp["first_year_contract"] * pdp["annual_maintenance_rate"]
        row["private_cogs"] = (new_deals * pdp["first_year_contract"] * pdp["first_year_cost_ratio"]
                               + deals_total_before * pdp["first_year_contract"] * pdp["annual_maintenance_rate"] * pdp["maintenance_cost_ratio"])
        row["cash_in"] += row["private"]
        deals_total_before += new_deals
        fc = cfg["fixed_costs"]
        row["legal_data"] = fc["legal_data"][ys] * data_factor
        row["cloud_platform"] = fc["cloud_platform"][ys] * cloud_factor
        row["headcount"] = cfg["headcount_avg_fte"][ys] * hc_factor * cfg["loaded_cost_per_fte"] * active_months / 12
        row["experts"] = fc["external_lawyer_experts"][ys]
        row["sales_marketing"] = fc["sales_marketing_programs"][ys]
        row["compliance"] = fc["compliance_certification"][ys] * compliance_factor
        row["ga"] = fc["ga_allocation"][ys]
        recurring = row["subscription"] + row["reviewer"] + row["platform_fee"] + row["addon"]
        row["channel_commission"] = recurring * chan["share_of_revenue_via_channel"] * chan["commission_rate"]

        revenue = recurring + row["services"] + row["private"]
        cogs = (row["task_cogs"] + row["storage_support_cogs"] + row["addon_cogs"] + row["services_cogs"]
                + row["private_cogs"] + row["platform_fee_cogs"] + row["payment_fees"] + row["legal_data"] + row["cloud_platform"])
        gross = revenue - cogs
        opex = (row["headcount"] + row["experts"] + row["sales_marketing"] + row["compliance"] + row["ga"]
                + row["channel_commission"])
        operating = gross - opex
        cash_out = cogs + opex
        cash_net = row["cash_in"] - cash_out
        op_cum += operating
        cash_cum += cash_net
        op_trough = min(op_trough, op_cum)
        cash_trough = min(cash_trough, cash_cum)
        end_seats = {ek: curves[ek][month_index(y, 12)] for ek in ("team", "firm", "pro")}
        prod_end = sum(end_seats.values())
        arr = (sum(end_seats[ek] * seat[ek]["net_subscription"] for ek in end_seats)
               + (end_seats["team"] + end_seats["firm"]) * ratio_rev * seat["reviewer"]["net_subscription"]
               + firm_customers[month_index(y, 12)] * platform_fee)
        avg_prod = sum(sum(curves[ek][month_index(y, m)] for ek in ("team", "firm", "pro")) for m in range(1, 13)) / 12
        # 盈亏平衡：当年固定成本与运营费用 ÷ 每生产席综合贡献（含审阅席、平台费、加量；扣渠道）
        blend_contrib = blended_contribution_per_production_seat(cfg, seat, end_seats, firm_customers[month_index(y, 12)])
        fixed_and_opex = (row["legal_data"] + row["cloud_platform"] + row["headcount"] + row["experts"]
                          + row["sales_marketing"] + row["compliance"] + row["ga"])
        other_margin = (row["services"] - row["services_cogs"]) + (row["private"] - row["private_cogs"])
        be = math.ceil((fixed_and_opex - other_margin) / blend_contrib) if blend_contrib > 0 else None
        annual[ys] = {k: round(v, 0) for k, v in row.items()}
        annual[ys].update({
            "revenue": round(revenue, 0), "recurring_revenue": round(recurring, 0), "cogs": round(cogs, 0),
            "gross_profit": round(gross, 0), "gross_margin": round(gross / revenue, 4) if revenue else None,
            "opex": round(opex, 0), "operating_result": round(operating, 0),
            "cumulative_operating_result": round(op_cum, 0), "cash_net": round(cash_net, 0),
            "cumulative_cash": round(cash_cum, 0), "year_end_production_seats": round(prod_end),
            "average_production_seats": round(avg_prod), "year_end_arr": round(arr, 0),
            "blended_contribution_per_production_seat": round(blend_contrib, 0),
            "break_even_average_production_seats_at_this_cost_base": be})
    return {"scenario": sc["label"], "tasks": tasks, "personas": personas, "seat_economics": seat,
            "annual": annual, "operating_trough": round(op_trough, 0), "cash_trough": round(cash_trough, 0)}


def blended_contribution_per_production_seat(cfg, seat, end_seats, firm_customers_end) -> float:
    total = sum(end_seats.values())
    if total <= 0:
        mix = {"team": 0.72, "firm": 0.20, "pro": 0.08}
        total = 1.0
        end_seats = {k: v for k, v in mix.items()}
        firm_customers_end = 0.2 / 100
    chan = cfg["channel"]
    ratio = cfg["reviewer_seats_per_production_seat"]
    contrib = 0.0
    for ek in ("team", "firm", "pro"):
        s = seat[ek]
        rec = s["net_subscription"] + s["addon_revenue"]
        contrib += end_seats[ek] * (s["contribution_before_channel"] - rec * chan["share_of_revenue_via_channel"] * chan["commission_rate"])
    rv = seat["reviewer"]
    contrib += (end_seats["team"] + end_seats["firm"]) * ratio * (
        rv["contribution_before_channel"] - rv["net_subscription"] * chan["share_of_revenue_via_channel"] * chan["commission_rate"])
    free_ratio = cfg.get("reviewer_free_seats_per_production_seat", 0.0)
    contrib -= (end_seats["team"] + end_seats["firm"]) * free_ratio * (rv["task_cost"] + rv["storage"] + rv["support"])
    pf = cfg["editions"]["firm"]["platform_fee_per_customer"]
    pfc = cfg["editions"]["firm"].get("platform_fee_cost_per_customer", 0.0)
    contrib += firm_customers_end * (pf * (1 - chan["share_of_revenue_via_channel"] * chan["commission_rate"]) - pfc)
    return contrib / total


# ---------------------------------------------------------------- 输出
def wan(x: float) -> str:
    return f"{x / 10000:,.0f}"


def markdown_summary(cfg: dict, results: dict) -> str:
    base = results["scenarios"]["base"]
    lines = []
    if cfg.get("base_sensitivity"):
        lines.append("> 主口径：" + cfg.get("base_sensitivity_label", json.dumps(cfg["base_sensitivity"], ensure_ascii=False)) + "；含加量收入的结果见敏感性表。\n")
    lines.append("### 单任务可变成本（元，公开价、含缓存写入与重试）\n")
    lines.append("| 任务 | 对外点数 | 模型 | 重试 | OCR | 法源 | 检索 | 合计 | 每点成本 | 无持久缓存合计 |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for k, t in base["tasks"].items():
        nc = results["no_cache_tasks"][k]["variable_total"]
        lines.append(f"| {t['name']} | {t['points']} | {t['model']:.2f} | {t['retry']:.2f} | {t['ocr']:.2f} | {t['data']:.2f} | {t['compute']:.2f} | **{t['variable_total']:.2f}** | {t['cost_per_point']:.3f} | {nc:.2f} |")
    lines.append("\n### 用户画像（未限额需求）\n")
    lines.append("| 画像 | 权重 | 月请求点数 | 月未限额成本（元） | 每点成本 |")
    lines.append("|---|---:|---:|---:|---:|")
    for k, p in base["personas"].items():
        lines.append(f"| {k} | {p['weight']:.0%} | {p['monthly_points_requested']:.0f} | {p['monthly_unrestricted_cost']:.0f} | {p['cost_per_point']:.3f} |")
    lines.append("\n### 每席年度经济（基准，扣渠道前）\n")
    lines.append("| 版本 | 实收订阅 | 加量收入 | 月消耗点数 | 任务成本 | 存储 | 支持 | 加量成本 | 贡献 | 贡献率 |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for k, s in base["seat_economics"].items():
        cm = f"{s['contribution_margin']:.1%}" if s["contribution_margin"] is not None else "—"
        lines.append(f"| {s['edition']} | {s['net_subscription']:,.0f} | {s['addon_revenue']:,.0f} | {s['monthly_points_consumed']:.0f} | {s['task_cost']:,.0f} | {s['storage']} | {s['support']} | {s['addon_cost']:,.0f} | **{s['contribution_before_channel']:,.0f}** | {cm} |")
    for key in ("conservative", "base", "aggressive"):
        r = results["scenarios"][key]
        lines.append(f"\n### {r['scenario']}情景（万元）\n")
        lines.append("| 年份 | 年末生产席位 | 平均生产席位 | 年末ARR | 确认收入 | 毛利率 | 运营费用 | 经营结果 | 累计经营结果 | 累计现金 | 当年成本结构下平衡平均席位 |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
        for y, a in r["annual"].items():
            gm = f"{a['gross_margin']:.1%}" if a["gross_margin"] is not None else "—"
            be = f"{a['break_even_average_production_seats_at_this_cost_base']:,}" if a["break_even_average_production_seats_at_this_cost_base"] else "—"
            lines.append(f"| {y} | {a['year_end_production_seats']:,} | {a['average_production_seats']:,} | {wan(a['year_end_arr'])} | {wan(a['revenue'])} | {gm} | {wan(a['opex'])} | {wan(a['operating_result'])} | {wan(a['cumulative_operating_result'])} | {wan(a['cumulative_cash'])} | {be} |")
        lines.append(f"\n累计经营结果谷底 {wan(r['operating_trough'])} 万元；累计现金谷底（年付预收口径）{wan(r['cash_trough'])} 万元。")
    lines.append("\n### 敏感性（基准情景）\n")
    lines.append("| 情形 | 2029 经营结果（万元） | 2030 经营结果（万元） | 累计现金谷底（万元） | 2030 成本结构下平衡平均席位 |")
    lines.append("|---|---:|---:|---:|---:|")
    b = results["scenarios"]["base"]
    lines.append(f"| 基准（主口径） | {wan(b['annual']['2029']['operating_result'])} | {wan(b['annual']['2030']['operating_result'])} | {wan(b['cash_trough'])} | {b['annual']['2030']['break_even_average_production_seats_at_this_cost_base']:,} |")
    for s in results["sensitivities"]:
        be = f"{s['break_even_2030']:,}" if s.get("break_even_2030") else "—"
        lines.append(f"| {s['label']} | {wan(s['op_2029'])} | {wan(s['op_2030'])} | {wan(s['cash_trough'])} | {be} |")
    return "\n".join(lines) + "\n"


def evaluate(cfg: dict) -> dict:
    res = {"version": cfg["version"], "prepared_date": cfg["prepared_date"], "basis": cfg["basis"], "scenarios": {}}
    for key in cfg["scenarios"]:
        res["scenarios"][key] = simulate(cfg, key)
    res["no_cache_tasks"] = {k: task_cost(t, cfg["price_per_million_tokens"], 1.0, True) for k, t in cfg["task_assumptions"].items()}
    res["sensitivities"] = []
    for s in cfg["sensitivities"]:
        r = simulate(cfg, "base", s)
        res["sensitivities"].append({"label": s["label"], "op_2029": r["annual"]["2029"]["operating_result"],
                                     "op_2030": r["annual"]["2030"]["operating_result"], "cash_trough": r["cash_trough"],
                                     "operating_trough": r["operating_trough"],
                                     "break_even_2030": r["annual"]["2030"]["break_even_average_production_seats_at_this_cost_base"]})
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=Path, default=HERE / "11-经济模型-v9-inputs.json")
    ap.add_argument("--output", type=Path)
    ap.add_argument("--markdown", type=Path)
    args = ap.parse_args()
    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    res = evaluate(cfg)
    if args.output:
        args.output.write_text(json.dumps(res, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md = markdown_summary(cfg, res)
    if args.markdown:
        args.markdown.write_text(md, encoding="utf-8")
    print(md)


if __name__ == "__main__":
    main()
