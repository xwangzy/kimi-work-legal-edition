import json, sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docx2txt import paras
from split import split_lines, check
src=sys.argv[1]; dst=sys.argv[2]
res={}
for k in ['patent','antimonopoly','laborreg','unfair','datasec']:
    ps,names=paras(f'{src}/{k}.docx')
    arts,heads,pre=split_lines(ps)
    ok,nos=check(arts)
    empty=[a['no'] for a in arts if not a['text']]
    res[k]={'articles':arts,'heads':heads,'pre':pre}
    print(k,'N=',len(arts),'contiguous',ok,'last',nos[-1] if nos else None,'empty',empty,'heads',len(heads),'parts',[n for n in names if n.startswith('word/') and n.endswith('.xml')])
    print('  pre:',pre)
    print('  heads:',heads)
    print('  last art:',arts[-1]['text'][:120])
json.dump(res,open(dst,'w'),ensure_ascii=False,indent=1)
