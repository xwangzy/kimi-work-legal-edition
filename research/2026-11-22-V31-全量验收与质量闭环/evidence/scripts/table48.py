"""由 matrix48 的 json 生成主文 E 的逐卡表（Markdown）。用法：python3 -I table48.py <matrix.json> <grades 根目录相对路径前缀>"""
import json, sys
rows = json.load(open(sys.argv[1]))
import re
LINE = {'litigation': '诉讼', 'transactional': '非诉', 'inhouse': '企业法务'}
_src = open('apps/desktop/src/lib/scenarios.ts').read()
TITLE_OF = dict(re.findall(r'id:\s*"([^"]+)"[^{}]*?title:\s*"([^"]+)"', _src))
LINE_OF = dict(re.findall(r'id:\s*"([^"]+)"[^{}]*?line:\s*"(\w+)"', _src))
cards = {c['tag']: c for c in json.load(open('eval/cards/cards16.json'))}
WAVE = {'wave1': '第一波（旧）', 'wave2': '第二波（新·中间版）', 'wave3': '第三波（新·最终版）'}
def prev(r):
    out = []
    for w, lab in (('V30', '56批'), ('wave1', '一波'), ('wave2', '二波')):
        if w == r['final_wave']: break
        g = r.get(w)
        if g: out.append(f"{lab} {g['score']}{'✓' if g['passed'] else '×'}{''.join(g['veto'])}")
    return '；'.join(out) or '—'
print('| # | 卡片 | 线 | 评分所在 | 总分 | 否决 | 结果 | 以前 | 首要问题 |')
print('|---:|---|---|---|---:|---|---|---|---|')
for i, r in enumerate(rows, 1):
    c = cards[r['tag']]
    name = TITLE_OF.get(c['id']) or r.get('final_card') or r['tag']
    line = LINE_OF.get(c['id'], '')
    wave = r['final_wave']
    link = f"[{name}](evidence/grades/{wave}/{r['tag']}.md)"
    top = (r.get('top') or '').replace('|', '／')
    if len(top) > 90: top = top[:88] + '…'
    print(f"| {i} | {link} | {LINE.get(line, line)} | {WAVE[wave]} | {r['final_score']} | {''.join(r['final_veto']) or '无'} | {'已通过' if r['final_passed'] else '**未通过**'} | {prev(r)} | {top} |")
