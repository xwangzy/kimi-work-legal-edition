#!/usr/bin/env python3
"""对账：网关结算行（kind=settle）↔ 控制面用量账本行，按 request_id 逐条对上；只看给定租户、给定时刻之后。
用法：sudo python3 reconcile.py <租户> <起始 ISO 时刻>"""
import json, sys
tid, since = sys.argv[1], sys.argv[2]
gw = {}
for l in open("/var/lib/kwl/gateway/meter.jsonl"):
    j = json.loads(l)
    if j.get("kind") == "settle" and j.get("tid") == tid and j["at"] >= since:
        gw[j["requestId"]] = j
cp = {}
for l in open("/var/lib/kwl/control-plane/usage/2026-11.jsonl"):
    j = json.loads(l)
    if j.get("tid") == tid and j["at"] >= since:
        cp[j["request_id"]] = j
both = set(gw) & set(cp)
mism = []
for k in both:
    g, c = gw[k], cp[k]
    if (g["inputTokens"] or 0) != c["usage"]["input"] or (g["outputTokens"] or 0) != c["usage"]["output"] or (g["cachedTokens"] or 0) != c["usage"]["cached"] or g["status"] != c["status"]:
        mism.append(k)
st = {}
for c in cp.values():
    st[c["status"]] = st.get(c["status"], 0) + 1
tok_gw = sum((g["inputTokens"] or 0) + (g["outputTokens"] or 0) for g in gw.values())
tok_cp = sum(c["usage"]["input"] + c["usage"]["output"] for c in cp.values())
charge = sum(c.get("charge") or 0 for c in cp.values())
value = sum(c.get("value_micro") or 0 for c in cp.values()) / 1e6
cost = sum(c.get("cost_micro") or 0 for c in cp.values()) / 1e6
by_seat = {}
for c in cp.values():
    by_seat[c["sid"]] = by_seat.get(c["sid"], 0) + c["usage"]["input"] + c["usage"]["output"]
print(f"租户 {tid} 自 {since}：网关结算 {len(gw)} 行，控制面账本 {len(cp)} 行，按请求编号对上 {len(both)}，只在网关 {len(set(gw)-set(cp))}，只在控制面 {len(set(cp)-set(gw))}，字段不一致 {len(mism)}")
print(f"状态分布 {st}；token 网关 {tok_gw:,} / 控制面 {tok_cp:,}；计入额度 {charge:,}；用量价值 ¥{value:.6f}；上游成本 ¥{cost:.6f}")
print("按席位 token：", {k: f"{v:,}" for k, v in by_seat.items()})
print("上游型号：", sorted({c["upstream_model"] for c in cp.values()}))
