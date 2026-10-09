#!/usr/bin/env python3
"""Reproducible planning model, not billing code. Standard library only.

Usage: python3 06-economics-model.py [--config PATH] [--output PATH]
Existing legacy economic models are intentionally preserved.
"""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path


def validate_numbers(value, location="config"):
    if isinstance(value, dict):
        for key, item in value.items():
            validate_numbers(item, f"{location}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            validate_numbers(item, f"{location}[{index}]")
    elif isinstance(value, (int, float)):
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"Non-finite or negative planning input at {location}")


def task_cost(task, prices, no_cache=False):
    model = 0.0
    for step in task["steps"]:
        price = prices[step["model"]]
        if no_cache:
            billable = (step["miss_k"] + step["hit_k"]) * price["miss"]
        else:
            billable = (step["miss_k"] * price["miss"] + step["hit_k"] * price["hit"]
                        + step["write_5m_k"] * price["write_5m"]
                        + step["write_1h_k"] * price["write_1h"])
        model += (billable + step["output_k"] * price["output"]) / 1000
    retry = model * task["retry_fraction"]
    total = model + retry + task["ocr"] + task["data"] + task["compute"]
    return {"name":task["name"], "model":round(model,4), "model_retry":round(retry,4),
            "ocr":task["ocr"], "data":task["data"], "compute":task["compute"],
            "variable_total":round(total,4), "points":task["points"]}


def financial_row(seats, plan, fixed_data, fixed_platform, opex,
                  task_cost_annual=None, price_realization=None):
    realization = plan["price_realization"] if price_realization is None else price_realization
    task_cost_annual = plan["annual_task_cost_baseline"] if task_cost_annual is None else task_cost_annual
    price = plan["list_price_annual"] * realization * (1 - plan["refund_fraction"])
    seat_cost = task_cost_annual + plan["annual_storage_cloud_per_seat"] + plan["annual_direct_support_per_seat"]
    revenue = seats * price
    variable = seats * seat_cost
    fixed = fixed_data + fixed_platform
    gross = revenue - variable - fixed
    commission = revenue * plan["channel_commission_fraction"]
    contribution_after_channel = price * (1-plan["channel_commission_fraction"]) - seat_cost
    return {"average_seats":seats,"net_annual_seat_price":round(price,2),
            "revenue":round(revenue,2),"variable_cogs":round(variable,2),"fixed_direct_cogs":fixed,
            "gross_profit":round(gross,2),"gross_margin":round(gross/revenue,6) if revenue else None,
            "channel_commission":round(commission,2),"opex_excluding_channel":opex,
            "operating_result":round(gross-commission-opex,2),
            "break_even_average_seats":math.ceil((fixed+opex)/contribution_after_channel) if contribution_after_channel>0 else None}


def evaluate(config):
    validate_numbers(config)
    plan=config["seat_plan"]
    for key in ("price_realization","refund_fraction","channel_commission_fraction"):
        if not 0<=plan[key]<=1:
            raise ValueError(f"seat_plan.{key} must be between zero and one")
    if abs(sum(p["weight"] for p in config["personas"].values())-1)>1e-9:
        raise ValueError("Persona weights must sum to one")
    tasks={key:task_cost(task,config["price_per_million_tokens"]) for key,task in config["task_assumptions"].items()}
    no_cache={key:task_cost(task,config["price_per_million_tokens"],True) for key,task in config["task_assumptions"].items()}
    personas={}
    for name,persona in config["personas"].items():
        variable=sum(count*tasks[key]["variable_total"] for key,count in persona["monthly_tasks"].items())
        points=sum(count*tasks[key]["points"] for key,count in persona["monthly_tasks"].items())
        personas[name]={"annual_unrestricted_task_cost":round(variable*12,2),"monthly_points_requested":points,
                        "monthly_points_above_individual_allocation":max(0,points-plan["monthly_points"])}
    blend=sum(config["personas"][key]["weight"]*row["annual_unrestricted_task_cost"] for key,row in personas.items())
    blend_points=sum(config["personas"][key]["weight"]*row["monthly_points_requested"] for key,row in personas.items())
    steady=config["steady_state"]
    table=[financial_row(n,plan,steady["fixed_legal_data"],steady["fixed_platform_operations"],steady["opex_excluding_direct_delivery"]) for n in steady["average_seats"]]
    stress=[]
    for case in config["stress_cases"]:
        row=financial_row(1000,plan,case["fixed_data"],steady["fixed_platform_operations"],steady["opex_excluding_direct_delivery"],case["annual_task_cost"],case["price_realization"])
        row["label"]=case["label"]
        stress.append(row)
    ramp=[]
    cumulative=-config["prelaunch_cash_assumption"]
    for year in config["ramp_years"]:
        delay = year.get("pre_ramp_weeks", 0)
        if not 0 <= delay < 52:
            raise ValueError("pre_ramp_weeks must be in [0, 52)")
        average = (year["start_seats"] + year["end_seats"])/2 - (year["end_seats"]-year["start_seats"])*delay/104
        row=financial_row(average,plan,year["fixed_legal_data"],year["fixed_platform_operations"],year["opex"])
        cumulative+=row["operating_result"]
        row.update(period=year["period"],start_seats=year["start_seats"],end_seats=year["end_seats"],pre_ramp_weeks=delay,
                   ending_arr=round(year["end_seats"]*row["net_annual_seat_price"],2),
                   cumulative_operating_result_including_prelaunch=round(cumulative,2))
        ramp.append(row)
    return {"prepared_date":config["prepared_date"],"evidence_date":config["evidence_date"],"currency":config["currency"],
            "task_costs":tasks,"no_persistent_cache_task_costs":no_cache,"personas":personas,
            "weighted_unrestricted_task_cost_annual":round(blend,2),"weighted_requested_points_monthly":round(blend_points,2),
            "annual_cost_if_point_budget_fully_consumed":plan["monthly_points"]*12*plan["internal_variable_cost_per_point"],
            "steady_state":table,"stress_at_1000_average_seats":stress,"ramp":ramp,
            "note":"Forecast baseline annual task cost is an independent hypothesis, not the unrestricted persona demand and not a simulated quota cap. Add-on revenue is zero. Cumulative operating result is not cash flow or funding requirement."}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config",type=Path,default=Path(__file__).with_name("06-economics-inputs.json"))
    parser.add_argument("--output",type=Path)
    args=parser.parse_args()
    result=evaluate(json.loads(args.config.read_text(encoding="utf-8")))
    data=json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False)+"\n"
    if args.output:
        args.output.write_text(data,encoding="utf-8")
    print(data)


if __name__=="__main__":
    main()
