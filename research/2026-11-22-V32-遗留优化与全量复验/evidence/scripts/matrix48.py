# 汇总 48 张卡：每张卡取最新一波的评分（v32-run4 > run3 > run2 > run1），附各波与第 57 批（V31）的分数。
# 通过口径按《质量评估标准》重算：无否决、总分 ≥ 20、8 个维度都 ≥ 2、文件全部能打开。
import json, os, glob, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
P = os.path.join(ROOT, "platform/output")
V31 = os.path.join(ROOT, "research/2026-11-22-V31-全量验收与质量闭环/evidence/grades")
cards = [c for c in json.load(open(os.path.join(ROOT, "platform/eval/cards/cards16.json"))) if c["tag"].startswith("m")]
def load(d):
    out = {}
    for f in glob.glob(os.path.join(d, "*.json")):
        if os.path.basename(f).startswith("_"): continue
        g = json.load(open(f)); out[g["tag"]] = g
    return out
waves = [("v32-run1", load(os.path.join(P, "v32-run1/grades"))), ("v32-run2", load(os.path.join(P, "v32-run2/grades"))), ("v32-run3", load(os.path.join(P, "v32-run3/grades"))), ("v32-run4", load(os.path.join(P, "v32-run4/grades")))]
v31 = {}
for w in ("wave1", "wave2", "wave3"):
    v31.update(load(os.path.join(V31, w)))
def ok(g):
    return not g["veto"] and g["score"] >= 20 and min(g["dims"]) >= 2 and g.get("open_ok", True)
FAILED16 = {"m01","m05","m07","m10","m13","m17","m18","m19","m25","m30","m31","m35","m45","m46","m47","m48"}
rows = []
for c in cards:
    t = c["tag"]; hist = [(w, d[t]) for w, d in waves if t in d]
    last = hist[-1] if hist else None
    rows.append({"tag": t, "group": "复测（上轮未过）" if t[:3] in FAILED16 else "回归（上轮已过）", "v31": v31.get(t), "hist": hist, "last": last})
if "--json" in sys.argv:
    print(json.dumps([{"tag": r["tag"], "group": r["group"], "v31": (r["v31"] or {}).get("score"), "v31_pass": ok(r["v31"]) if r["v31"] else None,
                       "final_wave": r["last"][0] if r["last"] else None, "score": r["last"][1]["score"] if r["last"] else None,
                       "veto": r["last"][1]["veto"] if r["last"] else None, "dims": r["last"][1]["dims"] if r["last"] else None,
                       "pass": ok(r["last"][1]) if r["last"] else None, "history": [[w, g["score"], g["veto"], ok(g)] for w, g in r["hist"]],
                       "top": (r["last"][1].get("top_issues") or [""])[0] if r["last"] else ""} for r in rows], ensure_ascii=False, indent=1))
    sys.exit()
n = len(rows); passed = sum(1 for r in rows if r["last"] and ok(r["last"][1])); graded = sum(1 for r in rows if r["last"])
for grp in ("复测（上轮未过）", "回归（上轮已过）"):
    rs = [r for r in rows if r["group"] == grp]
    print(f"{grp}：{sum(1 for r in rs if r['last'] and ok(r['last'][1]))}/{len(rs)} 通过（已评 {sum(1 for r in rs if r['last'])}）")
print(f"合计：{passed}/{n} 通过（已评 {graded}）")
print("| # | 卡片 | 组 | 上轮（V31） | 本批各波 | 最终 | 否决 | 结果 | 首要问题 |\n|---:|---|---|---|---|---:|---|---|---|")
for i, r in enumerate(rows, 1):
    v = r["v31"]; vs = f"{v['score']}{'✓' if ok(v) else '×'}{(' ' + ','.join(v['veto'])) if v['veto'] else ''}" if v else "—"
    hs = " → ".join(f"{w[-4:]} {g['score']}{'✓' if ok(g) else '×'}{(' ' + ','.join(g['veto'])) if g['veto'] else ''}" for w, g in r["hist"]) or "未评"
    last = r["last"][1] if r["last"] else None
    top = ((last.get("top_issues") or [""])[0] if last else "").replace("|", "／")[:80]
    print(f"| {i} | {r['tag']} | {r['group'][:2]} | {vs} | {hs} | {last['score'] if last else '—'} | {','.join(last['veto']) if last and last['veto'] else '无'} | {'**通过**' if last and ok(last) else ('未通过' if last else '未评')} | {top} |")
