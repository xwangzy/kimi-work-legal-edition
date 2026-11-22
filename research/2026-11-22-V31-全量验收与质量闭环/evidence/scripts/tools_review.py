"""逐卡工具调用与独立复核统计（只读打开各栈账本）。在 platform 目录下运行。"""
import sqlite3, json, sys
from pathlib import Path
from collections import Counter
OLD = Path('../../kimi-legal-architecture-review-c6783f/platform/output')
STACKS = {'V30': [OLD/'v30-real-model'/'stack-a', OLD/'v30-real-model'/'stack-b'],
          'wave1': [OLD/'v31-wave1'/'stack-a', OLD/'v31-wave1'/'stack-b'],
          'wave2': [Path('output/v31-wave2/stack-c'), Path('output/v31-wave2/stack-d')],
          'wave3': [Path('output/v31-wave3/stack-e'), Path('output/v31-wave3/stack-f')]}
WATCH = ['calc.ledger','calc.interest','calc.labor','calc.court_fee','calc.deadline','Bash','docx.edit_draft','xlsx.edit_cells','xlsx.render_table','docx.render_report','citations.verify']
rows=[]
for wave, stacks in STACKS.items():
    for s in stacks:
        db = s/'web-data'/'demo-firm'/'ledger.db'
        if not db.exists(): continue
        tag = {}
        for f in s.parent.glob('runs-*.txt'):
            for l in f.read_text().splitlines():
                p=l.split()
                if len(p)>=2: tag[p[1]]=p[0]
        c = sqlite3.connect(db.resolve().as_uri()+('?mode=ro' if Path(str(db)+'-wal').exists() else '?immutable=1'), uri=True)
        for (rid,status) in c.execute('select run_id,status from runs'):
            if rid not in tag: continue
            tools=Counter(); rev=[]; fu=None; machine=0
            for (t,p) in c.execute('select type,payload from run_events where run_id=? order by rowid',(rid,)):
                try: pj=json.loads(p) if p else {}
                except Exception: pj={}
                if t=='agent.tool_started':
                    raw=(pj.get('tool') or pj.get('name') or '')
                    n=raw[len('mcp__legal__'):].replace('_','.',1) if raw.startswith('mcp__legal__') else raw
                    tools[n]+=1
                elif t=='review.completed':
                    rev.append({k:pj.get(k) for k in ('findings','must','machine','kind','skipped') if k in pj})
                elif t=='review.followup':
                    fu=pj.get('open')
            rows.append(dict(wave=wave,tag=tag[rid],run=rid,status=status,tools={k:tools[k] for k in WATCH if tools[k]},other_tools=sum(v for k,v in tools.items() if k not in WATCH),review=rev,followup_open=fu))
json.dump(rows, open(sys.argv[1],'w') if len(sys.argv)>1 else sys.stdout, ensure_ascii=False, indent=1)
