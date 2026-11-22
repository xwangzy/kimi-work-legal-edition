"""第 57 批：逐卡耗时、调用、token、成本，按“优化前（旧代码）/ 优化后（新代码）”同卡对照。
在 platform 目录下运行：python3 -I ../research/2026-11-22-V31-全量验收与质量闭环/evidence/scripts/metrics.py
口径同 eval/ledger-summary.mjs（工作时间已扣除等律师的时间；成本为账本 cost_microcny 之和，按价目表估算）。"""
import json, subprocess, os, sys
from pathlib import Path
NODE = os.path.expanduser('~/.nvm/versions/node/v26.8.1/bin/node')
OLD = Path('../../kimi-legal-architecture-review-c6783f/platform/output')
WAVES = {  # 名称: (账本所在目录列表, 取件目录, 代码)
    'V30':   ([OLD/'v30-real-model'/'stack-a', OLD/'v30-real-model'/'stack-b'], None, '旧'),
    'wave1': ([OLD/'v31-wave1'/'stack-a', OLD/'v31-wave1'/'stack-b'], OLD/'v31-wave1'/'out', '旧'),
    'wave2': ([Path('output/v31-wave2/stack-c'), Path('output/v31-wave2/stack-d')], Path('output/v31-wave2-latest/out'), '新（中间版）'),
    'wave3': ([Path('output/v31-wave3/stack-e'), Path('output/v31-wave3/stack-f')], Path('output/v31-wave3/out'), '新（最终版）'),
}
GRADES = {'V30': Path('../research/2026-11-22-V30-遗留闭环与架构审查/evidence/grades'),
          'wave1': Path('output/v31-wave1-grades'), 'wave2': Path('output/v31-wave2-grades'), 'wave3': Path('output/v31-wave3-grades')}
def runs_of(stackdirs):
    m = {}
    for s in stackdirs:
        for f in s.parent.glob('runs-*.txt'):
            for line in f.read_text().splitlines():
                p = line.split()
                if len(p) >= 2: m[p[1]] = p[0]
    return m
rows = []
for wave, (stacks, out, code) in WAVES.items():
    tagof = runs_of(stacks)
    graded = {}
    for g in GRADES[wave].glob('*.json'):
        j = json.loads(g.read_text())
        if j.get('run_id'): graded[j['tag']] = j['run_id']
    if out and out.exists():
        for d in out.iterdir():
            if (d/'run.json').exists(): graded.setdefault(d.name, json.loads((d/'run.json').read_text())['run']['run_id'])
    for s in stacks:
        db = s/'web-data'/'demo-firm'/'ledger.db'
        if not db.exists(): continue
        j = json.loads(subprocess.check_output([NODE, 'eval/ledger-summary.mjs', '--json', str(db)], stderr=subprocess.DEVNULL))
        for r in j['runs']:
            tag = tagof.get(r['run_id'])
            if not tag: continue
            if graded.get(tag) and graded[tag] != r['run_id']: continue  # 只取被评分（最终取件）的那一次
            g = GRADES[wave]/f'{tag}.json'
            gj = json.loads(g.read_text()) if g.exists() else {}
            rows.append(dict(wave=wave, code=code, tag=tag, run=r['run_id'], status=r['status'], work_min=round(r['work_min'],1),
                             review_min=round(r.get('review_min') or 0,1), fix_min=round(r.get('fix_min') or 0,1), calls=r['calls'], tools=r['tools'],
                             input=r['input'], cached=r['cached'], out=r['out'], reasoning=r['reasoning'], cost=round(r['cost_yuan'],2),
                             score=gj.get('score'), passed=gj.get('status')=='已通过' if gj else None, veto=gj.get('veto')))
json.dump(rows, open(sys.argv[1] if len(sys.argv)>1 else '/dev/stdout','w'), ensure_ascii=False, indent=1)
