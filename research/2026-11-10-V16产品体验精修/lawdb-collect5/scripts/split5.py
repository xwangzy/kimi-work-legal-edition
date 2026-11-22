import json, sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docx2txt import paras
from doc2txt import doc_text
from split import split_lines, check
from ids import IDS
src=sys.argv[1]; dst=sys.argv[2]
res={}
for k in IDS:
    p=f'{src}/{k}.docx'
    if os.path.exists(p): ps,names=paras(p)
    else: ps,names=doc_text(f'{src}/{k}.doc')
    arts,heads,pre=split_lines(ps)
    ok,nos=check(arts)
    empty=[a['no'] for a in arts if not a['text']]
    res[k]={'articles':arts,'heads':heads,'pre':pre,'allparas':[x for x in ps if x.strip()]}
    print(k,'N=',len(arts),'contiguous',ok,'empty',empty,'heads',len(heads))
    print('  pre:',pre)
    print('  heads:',heads[:3],'...')
    print('  last art:',repr(arts[-1]['text'][-150:]) if arts else None)
json.dump(res,open(dst,'w'),ensure_ascii=False,indent=1)
