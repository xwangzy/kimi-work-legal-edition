#!/usr/bin/env python3
"""Kimi Work 法律发行版单位经济测算（2026-09-23）。

价格为 platform.kimi.com 2026-09-23 一手价格（元/百万 token）；
任务 token 量、用户画像、非 token 成本均为假设，试点期用实测 P50/P95 替换。
运行：python3 research/2026-09-23-单位经济测算.py
"""

PRICE = {  # 未命中输入, 缓存命中输入, 输出
    "K3": (20.0, 2.0, 100.0),
    "K2.6": (6.5, 1.1, 27.0),
}

def step(model, uncached_k, cached_k, out_k):
    p_in, p_hit, p_out = PRICE[model]
    return (uncached_k * p_in + cached_k * p_hit + out_k * p_out) / 1000.0

# 结构化流水线：每步 (模型, 未命中输入 k token, 命中输入 k token, 输出 k token)
PIPELINES = {
    "S1 合同审查（30 页）": [
        ("K2.6", 20, 0, 4),     # 解析与要素抽取
        ("K3", 62, 304, 20),    # Playbook 逐组检查：首次 38k 未命中 + 8 次变量部分；稳定前缀 8 次命中
        ("K3", 10, 40, 6),      # 审查意见书
        ("K2.6", 15, 30, 3),    # 支持性检查
    ],
    "S2 案卷整理（300 页，不含 OCR）": [
        ("K2.6", 130, 30, 25),  # 分块抽取
        ("K2.6", 20, 0, 5),     # 分类去重
        ("K3", 40, 80, 15),     # 时间线、证据目录、争点矩阵
        ("K2.6", 20, 20, 3),    # 校验
    ],
    "S3 要素式起诉状": [
        ("K2.6", 30, 0, 3),
        ("K3", 20, 20, 6),
    ],
    "S4 研究与类案报告（3 争点，不含数据调用）": [
        ("K3", 5, 0, 2),        # 检索计划
        ("K2.6", 180, 0, 18),   # 候选筛选
        ("K3", 90, 60, 15),     # 精读 15 份关键来源
        ("K3", 20, 60, 12),     # 备忘录与报告
        ("K2.6", 40, 0, 4),     # 支持性检查
    ],
}

# 通用 Agent 循环对照：25 轮，平均上下文 62.5k，其中每轮新增约 6k 未命中
AGENT_LOOP_S1 = step("K3", 25 * 6, 25 * 56.5, 25 * 1.5)

QA = 0.6 * step("K2.6", 8, 0, 0.8) + 0.4 * step("K3", 8, 0, 0.8)   # 问答路由：六成走 K2.6
OPEN_SESSION = 10.0          # 开放式 Agent 会话，假设 ¥5–15，取中值
OCR_CLOUD_PER_300P = 6.0     # 云端 GPU OCR，约 ¥0.02/页（假设）；本机 OCR 记 0
DATA_CALLS_S4 = 12.0         # 研究场景数据调用，30 次 × ¥0.3–0.5（假设，待询价）

def pipeline_cost(name):
    return sum(step(*s) for s in PIPELINES[name])

task = {k: pipeline_cost(k) for k in PIPELINES}
s1, s2, s3, s4 = (task[k] for k in PIPELINES)
s2_avg = s2 + 0.5 * OCR_CLOUD_PER_300P   # 一半扫描件走云端 OCR

# 月度用量画像：(S1, S2, S3, S4, 问答, 开放会话)
PERSONAS = {
    "轻度": (2, 0, 0, 0, 15, 2),
    "中度": (6, 1, 2, 1, 40, 8),
    "重度": (20, 4, 6, 4, 150, 40),
}
MIX = {"轻度": 0.3, "中度": 0.5, "重度": 0.2}

def monthly(p):
    n1, n2, n3, n4, nq, no = p
    model = n1 * s1 + n2 * s2_avg + n3 * s3 + n4 * s4 + nq * QA + no * OPEN_SESSION
    return model, n4 * DATA_CALLS_S4

print("== 单任务模型成本（元）")
for k, v in task.items():
    print(f"{k:<28} {v:6.2f}")
print(f"{'S1 若用通用 Agent 循环':<28} {AGENT_LOOP_S1:6.2f}")
print(f"{'问答（路由后均值）':<28} {QA:6.2f}")

print("\n== 席位年度可变成本（元）")
blend_model = blend_data = 0.0
for name, p in PERSONAS.items():
    m, d = monthly(p)
    print(f"{name}: 模型 {m*12:7.0f}  数据调用 {d*12:5.0f}")
    blend_model += MIX[name] * m * 12
    blend_data += MIX[name] * d * 12
print(f"加权（3:5:2）: 模型 {blend_model:7.0f}  数据调用 {blend_data:5.0f}")

POOL_TEAM = 500 * 0.5 * 12   # 团队版每席每月 500 点，1 点 = ¥0.5 模型成本当量，团队共享
NON_TOKEN = (1000, 1900)     # 云资源、数据授权分摊、支持与客户成功（稳态假设）
PRICE_TEAM = 9800

print(f"\n== 团队版毛利（席位价 ¥{PRICE_TEAM}，额度池上限 ¥{POOL_TEAM:.0f}/席/年）")
for label, token in (("预期", blend_model + blend_data), ("额度用满", POOL_TEAM + blend_data),
                     ("token 降价 30%", 0.7 * blend_model + blend_data)):
    for nt in NON_TOKEN:
        gm = (PRICE_TEAM - token - nt) / PRICE_TEAM
        print(f"{label:<14} 非 token 成本 {nt}: 毛利率 {gm:5.1%}")
