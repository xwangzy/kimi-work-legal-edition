#!/usr/bin/env python3
"""Kimi Work 法律发行版：单位经济与盈亏测算 v3（2026-09-28）。

在 09-23 脚本基础上增加：各版本席位毛利、首年与稳态的固定成本分摊、三情景收入与盈亏平衡。
价格为 platform.kimi.com 一手价格（元/百万 token，09-23 核验，09-28 复核结果见子报告）；
任务 token 量、用户画像、席位数、人力成本均为假设，试点第 4 周用实测 P50/P95 替换。
运行：python3 "research/2026-09-28-整合交付/单位经济与盈亏测算.py"
"""

PRICE = {  # 未命中输入, 缓存命中输入, 输出
    "K3": (20.0, 2.0, 100.0),
    "K2.6": (6.5, 1.1, 27.0),
    "K2.6B": (3.9, 1.1, 16.2),   # Batch：标准价 60%；缓存命中按原价计（保守）
}

def step(model, uncached_k, cached_k, out_k):
    p_in, p_hit, p_out = PRICE[model]
    return (uncached_k * p_in + cached_k * p_hit + out_k * p_out) / 1000.0

# 结构化流水线：每步 (模型, 未命中输入 k token, 命中输入 k token, 输出 k token)
PIPELINES = {
    "S1 合同审查（30 页）": [
        ("K2.6", 20, 0, 4), ("K3", 62, 304, 20), ("K3", 10, 40, 6), ("K2.6", 15, 30, 3)],
    "S1b 下一稿比对重审（改动 6 条）": [
        ("K3", 12, 60, 5), ("K2.6", 6, 10, 1)],
    "S2 案卷整理（300 页，不含 OCR）": [
        ("K2.6", 130, 30, 25), ("K2.6", 20, 0, 5), ("K3", 40, 80, 15), ("K2.6", 20, 20, 3)],
    "S3 要素式起诉状": [
        ("K2.6", 30, 0, 3), ("K3", 20, 20, 6)],
    "S4 研究与类案报告（3 争点，不含数据）": [
        ("K3", 5, 0, 2), ("K2.6", 180, 0, 18), ("K3", 90, 60, 15), ("K3", 20, 60, 12), ("K2.6", 40, 0, 4)],
    "S6 脱敏（50 页，本机规则+NER）": [],          # 本机执行，不调用云端模型
    "S7 尽调矩阵（50 份文件）": [
        ("K2.6", 600, 100, 60), ("K3", 60, 120, 25)],
    "S10 批量合同台账（100 份，夜间 Batch）": [
        ("K2.6B", 1500, 0, 150)],
}
QA = 0.6 * step("K2.6", 8, 0, 0.8) + 0.4 * step("K3", 8, 0, 0.8)   # 问答路由：六成走 K2.6
OPEN_SESSION = 10.0          # 开放式 Agent 会话，假设 ¥5–15，取中值
OCR_CLOUD_PER_PAGE = 0.02    # 云端 GPU OCR（假设）；本机 OCR 记 0
# 法源按次调用（09-28 公开价：法规约 ¥0.07/次（法律之星），案例约 ¥0.20/次（元典会员价））
DATA_CALL_S4 = 20 * 0.07 + 30 * 0.20 + 2.6   # 研究：20 次法规 + 30 次案例 + 企业信息等，约 ¥10
DATA_CALL_QA = 2 * 0.07                       # 问答：约 2 次法规检索
DATA_CALL_VERIFY = 5 * 0.07                   # 合同审查、要素式文书的引用核验：约 5 次法条原文
POINT_YUAN = 0.5             # 1 点 ≈ ¥0.5 模型成本当量

task = {k: sum(step(*s) for s in v) for k, v in PIPELINES.items()}
S1, S1b, S2, S3, S4, S6, S7, S10 = task.values()
S2_AVG = S2 + 0.5 * 300 * OCR_CLOUD_PER_PAGE   # 一半扫描件走云端 OCR

# 月度用量画像：(S1, S1b, S2, S3, S4, S7, S10, 问答, 开放会话)
PERSONAS = {
    "轻度": (2, 1, 0, 0, 0, 0, 0, 15, 2),
    "中度": (6, 3, 1, 2, 1, 0.2, 0, 40, 8),
    "重度": (20, 10, 4, 6, 4, 1, 0.5, 150, 40),
}
UNIT = (S1, S1b, S2_AVG, S3, S4, S7, S10, QA, OPEN_SESSION)

def persona_cost(p):
    model = sum(n * c for n, c in zip(p, UNIT))
    data = p[4] * DATA_CALL_S4 + p[7] * DATA_CALL_QA + (p[0] + p[3]) * DATA_CALL_VERIFY
    return model * 12, data * 12

# 版本：(席位价/年, 每席每月点数, 画像结构 轻/中/重, 非 token 可变成本/席/年, 额度是否团队共享)
EDITIONS = {
    "专业版": (3600, 200, (0.5, 0.4, 0.1), 450, False),
    "团队版": (9800, 500, (0.3, 0.5, 0.2), 700, True),
    "律所版": (8800, 500, (0.4, 0.45, 0.15), 600, True),   # 另收平台费，见下
}
ADDON_PRICE_PER_POINT = 1.0   # 加量包 ¥2,000 = 2,000 点
OVERAGE_CONVERSION = 0.5      # 超出额度的需求中，一半买加量包，一半被抑制（不再消耗）
FIRM_PLATFORM_FEE = 200_000

def edition_economics(ed, token_factor=1.0):
    """返回 (模型成本, 数据成本, 加量包收入)，均为每席每年。"""
    price, pts, mix, nt, shared = EDITIONS[ed]
    cap = pts * POINT_YUAN * 12
    usage = [(w, persona_cost(PERSONAS[n])) for w, n in zip(mix, PERSONAS)]
    data = sum(w * d for w, (m, d) in usage)
    demands = [(1.0, sum(w * m for w, (m, d) in usage))] if shared else [(w, m) for w, (m, d) in usage]
    model = addon = 0.0
    for w, m in demands:
        m *= token_factor
        over = max(0.0, m - cap)
        model += w * (min(m, cap) + OVERAGE_CONVERSION * over)
        addon += w * OVERAGE_CONVERSION * over / POINT_YUAN * ADDON_PRICE_PER_POINT
    return model, data, addon

def main():
    print("== 单任务模型成本（元，结构化流水线）")
    for k, v in task.items():
        print(f"  {k:<30} {v:6.2f}")
    print(f"  {'S2 含一半云端 OCR':<30} {S2_AVG:6.2f}")
    print(f"  {'问答（路由后均值）':<30} {QA:6.2f}")
    print(f"  {'开放式 Agent 会话（假设）':<30} {OPEN_SESSION:6.2f}")

    print("\n== 用户画像年度可变成本（元）")
    for name, p in PERSONAS.items():
        m, d = persona_cost(p)
        print(f"  {name}: 模型 {m:7.0f}  数据调用 {d:5.0f}  折合点数/月 {m / 12 / POINT_YUAN:6.0f}")

    print("\n== 各版本席位毛利（稳态，不含固定成本分摊）")
    for ed, (price, pts, mix, nt, shared) in EDITIONS.items():
        for label, factor in (("预期", 1.0), ("token 量 +50%", 1.5), ("token 降价 30%", 0.7)):
            model, data, addon = edition_economics(ed, factor)
            rev = price + addon
            cogs = model + data + nt
            head = f"  {ed}（{'团队共享' if shared else '按人'}额度 {pts} 点/月）" if label == "预期" else " " * 6
            print(f"{head} {label:<12} 模型 {model:6.0f} 数据 {data:4.0f} 非token {nt:4.0f}"
                  f" 加量包 {addon:5.0f} → 毛利率 {(rev - cogs) / rev:5.1%}")

    # 三情景：席位数与大客户数（年末），ARR = 席位 + 律所版平台费 + 私有化年服务费
    SCEN = {
        "保守": {2027: (500, 2, 1), 2028: (2000, 6, 3), 2029: (4500, 12, 6)},
        "基准": {2027: (1000, 3, 2), 2028: (4000, 12, 6), 2029: (9000, 25, 12)},
        "进取": {2027: (1800, 5, 3), 2028: (7000, 20, 9), 2029: (15000, 40, 18)},
    }
    SEAT_MIX = {"专业版": 0.25, "团队版": 0.6, "律所版": 0.15}
    blended_price = sum(EDITIONS[e][0] * w for e, w in SEAT_MIX.items())
    blended_var = 0.0
    for e, w in SEAT_MIX.items():
        model, data, addon = edition_economics(e)
        blended_var += w * (model + data + EDITIONS[e][3] - addon)   # 加量包收入冲减可变成本
    PRIVATE_FIRST_YEAR = 2_000_000      # 私有化首年合同额（一次性，含实施）
    PRIVATE_MAINT = 0.18 * PRIVATE_FIRST_YEAR
    DATA_LICENSE = {2027: 800_000, 2028: 1_500_000, 2029: 2_500_000}     # 法源企业保底、法信案例库、企业信息 API 等固定费（推测，按量部分已计入席位可变成本）
    CLOUD_BASE = {2027: 1_200_000, 2028: 2_000_000, 2029: 3_000_000}     # 云资源底座与等保运维
    HEADCOUNT = {2027: 55, 2028: 75, 2029: 95}
    LOADED = 450_000                    # 人均全口径年成本（假设）
    OTHER_OPEX = {2027: 6_000_000, 2028: 9_000_000, 2029: 12_000_000}    # 市场、渠道、办公、差旅

    INVEST_2026Q4 = 33 * LOADED * 4 / 12 + 1_500_000   # 第 0–1 阶段：33 人 4 个月 + 法源预付、设备、合规咨询
    print(f"\n== 三情景收入与盈亏（席位加权价 ¥{blended_price:.0f}，席位加权净可变成本 ¥{blended_var:.0f}）")
    print(f"  2026Q4 投入约 ¥{INVEST_2026Q4 / 1e4:.0f} 万")
    for s, years in SCEN.items():
        print(f"  [{s}]")
        prev_private = 0
        cum = -INVEST_2026Q4
        for y, (seats, firms, privates) in years.items():
            avg_seats = seats * 0.55 if y == 2027 else seats * 0.8   # 年内爬坡，收入按平均在册席位确认
            new_private = privates - prev_private
            arr = seats * blended_price + firms * FIRM_PLATFORM_FEE + privates * PRIVATE_MAINT
            rev = (avg_seats * blended_price + firms * FIRM_PLATFORM_FEE * 0.7
                   + new_private * PRIVATE_FIRST_YEAR + prev_private * PRIVATE_MAINT)
            cogs = (avg_seats * blended_var + DATA_LICENSE[y] + CLOUD_BASE[y]
                    + new_private * PRIVATE_FIRST_YEAR * 0.45)          # 私有化实施成本约 45%
            opex = HEADCOUNT[y] * LOADED + OTHER_OPEX[y]
            gm = (rev - cogs) / rev if rev else 0
            cum += rev - cogs - opex
            print(f"    {y}: 年末 ARR ¥{arr / 1e4:6.0f} 万 | 确认收入 ¥{rev / 1e4:6.0f} 万"
                  f" | 毛利率 {gm:5.1%} | 运营费用 ¥{opex / 1e4:5.0f} 万 | 经营利润 ¥{(rev - cogs - opex) / 1e4:6.0f} 万"
                  f" | 累计 ¥{cum / 1e4:6.0f} 万")
            prev_private = privates
    lean = {2027: 50, 2028: 62, 2029: 72}
    print("  精简编制敏感性（2027/28/29 = 50/62/72 人，其余同基准）：", end="")
    for y in (2027, 2028, 2029):
        seats, firms, privates = SCEN["基准"][y]
        delta = (HEADCOUNT[y] - lean[y]) * LOADED
        print(f" {y} 经营利润改善 ¥{delta / 1e4:.0f} 万", end=";")
    print()
    steady_gm = (blended_price - blended_var) / blended_price
    opex_2029 = HEADCOUNT[2029] * LOADED + OTHER_OPEX[2029]
    fixed_2029 = DATA_LICENSE[2029] + CLOUD_BASE[2029]
    be_seats = (opex_2029 + fixed_2029) / (blended_price - blended_var)
    print(f"\n== 盈亏平衡：席位边际贡献率 {steady_gm:.1%}；按 2029 年费用规模需约 {be_seats:,.0f} 个付费席位"
          f"（约 ¥{be_seats * blended_price / 1e4:,.0f} 万席位 ARR，未计私有化与律所平台费）")

if __name__ == "__main__":
    main()
