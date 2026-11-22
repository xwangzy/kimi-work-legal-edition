"""48 张场景卡的最终评分矩阵：每卡取最新一次在新代码上评过的结果（第三波 > 第二波），没有新代码评分的取第一波（旧代码）。
在 platform 目录下运行：python3 -I <本脚本> [输出 json]"""
import json, sys
from pathlib import Path
cards = [c for c in json.loads(Path('eval/cards/cards16.json').read_text()) if c['tag'].startswith('m')]
SRC = [('wave3', Path('output/v31-wave3-grades'), '新（最终版）'), ('wave2', Path('output/v31-wave2-grades'), '新（中间版）'),
       ('wave1', Path('output/v31-wave1-grades'), '旧（第 56 批）')]
V30 = Path('../research/2026-11-22-V30-遗留闭环与架构审查/evidence/grades')
def load(p):
    return json.loads(p.read_text()) if p.exists() else None
rows = []
for c in cards:
    t = c['tag']; hist = {}
    for w, d, code in SRC:
        g = load(d/f'{t}.json')
        if g: hist[w] = g
    g30 = load(V30/f'{t}.json')
    if g30: hist['V30'] = g30
    final = next(((w, hist[w], code) for w, d, code in SRC if w in hist), None)
    r = dict(tag=t, card=c.get('fields', {}).get('type') or c.get('id'), group=c.get('group'))
    for w in ('V30', 'wave1', 'wave2', 'wave3'):
        g = hist.get(w)
        r[w] = None if not g else dict(score=g['score'], veto=g.get('veto', []), passed=g['status'] == '已通过', dims=g.get('dims'))
    if final:
        w, g, code = final
        r.update(final_wave=w, final_code=code, final_score=g['score'], final_veto=g.get('veto', []), final_passed=g['status'] == '已通过',
                 final_card=g.get('card'), top=(g.get('top_issues') or [''])[0], defects=g.get('product_defect', []))
    rows.append(r)
out = sys.argv[1] if len(sys.argv) > 1 else None
s = json.dumps(rows, ensure_ascii=False, indent=1)
(open(out, 'w').write(s) if out else print(s))
n = len(rows); fin = [r for r in rows if r.get('final_wave')]
print(f'卡 {n}；有评分 {len(fin)}；通过 {sum(r["final_passed"] for r in fin)}；新代码上评分 {sum(r["final_wave"]!="wave1" for r in fin)}', file=sys.stderr)
