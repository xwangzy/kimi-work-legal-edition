"""生成 E 文：python3 -I build_E.py（在 platform 目录下运行）"""
import json, subprocess, statistics as st
from pathlib import Path
D = Path('../research/2026-11-22-V31-全量验收与质量闭环')
S = D/'evidence'/'scripts'
subprocess.run(['python3', '-I', str(S/'matrix48.py'), str(D/'evidence'/'48卡评分矩阵.json')], check=True)
rows = json.loads((D/'evidence'/'48卡评分矩阵.json').read_text())
table = subprocess.run(['python3', '-I', str(S/'table48.py'), str(D/'evidence'/'48卡评分矩阵.json')], check=True, capture_output=True, text=True).stdout.strip()
n = len(rows); ok = [r for r in rows if r['final_passed']]; new = [r for r in rows if r['final_wave'] != 'wave1']
veto = [r for r in rows if r['final_veto']]
line = {}
src = open('apps/desktop/src/lib/scenarios.ts').read()
import re
LINE_OF = dict(re.findall(r'id:\s*"([^"]+)"[^{}]*?line:\s*"(\w+)"', src))
TITLE_OF = dict(re.findall(r'id:\s*"([^"]+)"[^{}]*?title:\s*"([^"]+)"', src))
T = lambda tag: TITLE_OF.get(cards[tag]['id'], tag)
cards = {c['tag']: c for c in json.loads(Path('eval/cards/cards16.json').read_text())}
for r in rows:
    l = LINE_OF.get(cards[r['tag']]['id'])
    a = line.setdefault(l, [0, 0]); a[0] += 1; a[1] += r['final_passed']
LN = {'litigation': '诉讼', 'transactional': '非诉', 'inhouse': '企业法务'}
summary = (f"48 张卡全部真实跑完并独立评分：通过 {len(ok)} 张、未通过 {n-len(ok)} 张"
           f"（其中 {len(veto)} 张命中一票否决：" + '、'.join(f"{T(r['tag'])} {''.join(r['final_veto'])}" for r in veto) + "）。"
           f"{len(new)} 张的最终评分在新代码上，{n-len(new)} 张只在旧代码上跑过。按业务线：" + '；'.join(f"{LN[k]} {v[1]}/{v[0]}" for k, v in line.items()) + "。")
# 同卡对比
def pair(old, tags):
    out = []
    for t in tags:
        r = next(x for x in rows if x['tag'] == t)
        if r.get(old) and r['final_wave'] != old: out.append((t, r[old], r))
    return out
setA = pair('V30', [r['tag'] for r in rows if r.get('V30')])
setB = pair('wave1', [r['tag'] for r in rows if r.get('wave1') and r['final_wave'] == 'wave3'])
setC = pair('wave2', [r['tag'] for r in rows if r.get('wave2') and r['final_wave'] == 'wave3'])
def line_of(name, ps):
    if not ps: return ''
    a = [p[1]['score'] for p in ps]; b = [p[2]['final_score'] for p in ps]
    pa = sum(p[1]['passed'] for p in ps); pb = sum(p[2]['final_passed'] for p in ps)
    va = sum(bool(p[1]['veto']) for p in ps); vb = sum(bool(p[2]['final_veto']) for p in ps)
    up = sum(y > x for x, y in zip(a, b)); dn = sum(y < x for x, y in zip(a, b))
    return f"| {name} | {len(ps)} | {pa} → **{pb}** | {va} → {vb} | {st.mean(a):.1f} → {st.mean(b):.1f} | {up} 升 · {len(ps)-up-dn} 平 · {dn} 降 |"
cmp = ['| 同卡集合 | 卡数 | 通过 | 一票否决 | 平均分 | 逐卡变化 |', '|---|---:|---|---|---|---|',
       line_of('第 56 批十三卡（旧代码）→ 本批新代码', setA), line_of('第一波（旧代码）→ 第三波（新代码）', setB), line_of('第二波（中间版）→ 第三波（最终版）', setC)]
detail = ['', '| 卡片 | 以前（所在） | 现在 |', '|---|---|---|']
for t, o, r in setA + setB + setC:
    detail.append(f"| {T(t)} | {o['score']}{'✓' if o['passed'] else '×'}{''.join(o['veto'])} | {r['final_score']}{'✓' if r['final_passed'] else '×'}{''.join(r['final_veto'])} |")
compare = '\n'.join(cmp + detail) + '\n\n耗时、token 与成本的同卡对比见 [C 文](C-优化前后对比.md)。'
t = (S/'E.template.md').read_text().replace('{{SUMMARY}}', summary).replace('{{TABLE}}', table).replace('{{COMPARE}}', compare)
(D/'E-全量验收记录.md').write_text(t)
print(summary)
print('\n'.join(cmp))
