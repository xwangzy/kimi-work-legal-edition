#!/usr/bin/env python3
"""Standard-library-only scenario calculator. No network, credentials or paid calls."""
import json
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parent
D = lambda value: Decimal(str(value))
def rounded(value):
    return float(value.quantize(D("0.01"), rounding=ROUND_HALF_UP))

def calculate(cfg):
    model, task, account = cfg["model"], cfg["task"], cfg["account"]
    out = []
    for scenario in cfg["scenarios"]:
        uncached, cached = D(task["noncached_input"]), D(task["cache_hit_input"])
        if scenario.get("cache_disabled", False):
            uncached, cached = uncached + cached, D(0)
        output = D(task["billed_output_including_reasoning"]) * D(scenario.get("output_multiplier", 1))
        single_model = (uncached*D(model["input_per_million"]) + cached*D(model["cache_hit_per_million"]) + output*D(model["output_per_million"]))/D(1000000)
        model_cost = single_model*D(scenario.get("model_attempt_multiplier", task["model_attempt_multiplier"]))
        other = D(task["search_calls"])*D(task["search_unit_price_assumption"]) + sum(D(task[k]) for k in ("licensed_data", "execution_compute", "storage_network"))
        per_task = model_cost + other
        annual_tasks = D(scenario["tasks_per_month"])*12
        revenue = D(account["annual_list_price"])*D(scenario.get("realization", account["realization"]))
        fixed_service = D(account["annual_allocated_service_cost"])
        cost = annual_tasks*per_task + fixed_service
        margin = revenue-cost
        # Maximum included monthly tasks with 60% contribution margin, no add-on revenue.
        cap60 = max(D(0), (revenue*D("0.4")-fixed_service)/per_task/12)
        out.append({"name": scenario["name"], "tasks_per_month": scenario["tasks_per_month"], "model_cost_per_task": rounded(model_cost), "total_cost_per_task": rounded(per_task), "annual_net_revenue_assumption": rounded(revenue), "annual_direct_and_allocated_service_cost": rounded(cost), "annual_contribution": rounded(margin), "contribution_percent": rounded(margin/revenue*100), "monthly_tasks_at_60pct_contribution": rounded(cap60)})
    dev = cfg["development"]
    weeks = D(dev["base_person_weeks"])*(1+D(dev["contingency_fraction"]))
    development = {"person_weeks_with_contingency": rounded(weeks), "work_weeks_at_assumed_team": rounded(weeks/D(dev["average_fte"])/D(dev["effective_fraction"])), "cost_scenarios_cny": [{"cny_per_person_week": cost, "total": rounded(weeks*D(cost))} for cost in dev["all_in_cny_per_person_week"]]}
    return {"as_of": cfg["as_of"], "notice": cfg["notice"], "scenarios": out, "development": development}

def render(result):
    lines = ["# 07 经济压力测算摘要", "", result["notice"], "", "公式：每任务成本＝累计模型输入/输出/缓存费用×尝试系数＋检索＋法源＋计算＋存储网络；账号贡献＝不含税收入假设－年任务数×每任务成本－分摊服务成本。此贡献尚未扣研发、销售、总部费用和融资成本，不等于营业利润。", "", "| 情景 | 任务/月 | 元/任务 | 年收入假设 | 年服务成本 | 年贡献 | 贡献率 | 达60%贡献率可含任务/月 |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for s in result["scenarios"]:
        lines.append(f'| {s["name"]} | {s["tasks_per_month"]} | {s["total_cost_per_task"]:.2f} | {s["annual_net_revenue_assumption"]:.2f} | {s["annual_direct_and_allocated_service_cost"]:.2f} | {s["annual_contribution"]:.2f} | {s["contribution_percent"]:.2f}% | {s["monthly_tasks_at_60pct_contribution"]:.2f} |')
    dev = result["development"]
    lines += ["", "## 研发投入", "", f'700有效人周加25%预留为{dev["person_weeks_with_contingency"]:.0f}人周；30人、80%有效投入约{dev["work_weeks_at_assumed_team"]:.2f}工作周，外部等待另计。', "", "| 全成本/人周假设 | 总研发预算 |", "|---|---:|"]
    for s in dev["cost_scenarios_cny"]:
        lines.append(f'| {s["cny_per_person_week"]:,.0f}元 | {s["total"]:,.0f}元 |')
    lines += ["", "## 参数解释与限制", "", "- K3输入20元/百万、输出100元/百万、缓存命中2元/百万为2026-10-09官方公开价记录；实际企业价与账单规则待核。缓存写入按输入价计，本模型不重复把同一token计入输入和写入；如合同另有存储费，应增加该项。[Kimi官方价格](https://platform.kimi.com/)。", "- 任务token是所有轮次/子Agent的累计计费量，输出含计费思考；80k未命中、120k命中、20k输出和1.15尝试系数均为假设，不是测量结果。", "- 检索0.015元/次在此是报价假设，法源0.8元、计算0.6元、存储网络0.15元/任务以及年分摊服务1200元均须真实合同/遥测校准；固定最低采购额另做容量分摊，不重复计费。", "- 年标价9800元×80%=7840元只是收入假设，尚需实际含税报价、税率、折扣和渠道费用调整；本模型没有假定任何加量包收入。", "- 任务复杂度差异大，按任务数限制只用于解释；正式计费按可理解额度+费用上限，不能让简单问答和长案卷共用不透明计量。", "- 云/本地算力占比、数据许可最低承诺、客户支持、退款、渠道和坏账需要单独敏感性；禁止把本表转述成2030年利润预测。", "", "结论：固定年费不宜承诺无限调用；重度账号需要明确额度或额外购买。先以试点校准每份最终被采用交付件成本，再确定售价和包含用量。", "", "复算：在任意目录运行 `python3 07-经济压力测算.py`（传入脚本实际路径），修改同目录inputs.json即可；无网络调用。"]
    return "\n".join(lines)+"\n"

if __name__ == "__main__":
    cfg = json.loads((ROOT/"inputs.json").read_text())
    result = calculate(cfg)
    (ROOT/"results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n")
    (ROOT/"07-经济压力测算摘要.md").write_text(render(result))
    print(json.dumps(result, ensure_ascii=False, indent=2))
