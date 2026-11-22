import re, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docx2txt import paras
CN='零一二三四五六七八九'
def cn2int(s):
    if s.isdigit(): return int(s)
    total=0; num=0
    units={'十':10,'百':100,'千':1000}
    for ch in s:
        if ch in CN: num=CN.index(ch)
        elif ch in units:
            if num==0: num=1
            total+=num*units[ch]; num=0
        else: raise ValueError(s)
    return total+num
WS=' \t　​\xa0﻿\r\u2002\u2003\u2009\u200a'
ART=re.compile(r'^第([零一二三四五六七八九十百千]+)条(?:[　 \t]+|$)(.*)$', re.S)
HEAD=re.compile(r'^第[零一二三四五六七八九十百千]+[编章节](?:[　 \t]|$)')
def split_lines(lines):
    arts=[]; cur=None; heads=[]; pre=[]
    for raw in lines:
        for ln in raw.split('\n'):
            s=ln.strip(WS)
            if not s: continue
            m=ART.match(s)
            if m:
                cur={'no':cn2int(m.group(1)),'lines':[m.group(2).strip(WS)] if m.group(2).strip(WS) else []}
                arts.append(cur); continue
            if HEAD.match(s):
                if arts: heads.append(s)
                cur=None; continue
            if cur is not None: cur['lines'].append(s)
            else: pre.append(s)
    return [{'no':a['no'],'text':'\n'.join(a['lines'])} for a in arts], heads, pre
def check(arts):
    nos=[a['no'] for a in arts]
    ok = nos==list(range(1,len(nos)+1))
    return ok, nos
if __name__=='__main__':
    src=sys.argv[1]; dst=sys.argv[2]
    res={}
    for k in ['pipl','arbitration','copyright','partnership','labor1','company3']:
        ps,_=paras(f'{src}/{k}.docx')
        arts,heads,pre=split_lines(ps)
        ok,nos=check(arts)
        empty=[a['no'] for a in arts if not a['text']]
        res[k]={'articles':arts,'heads':heads,'pre':pre}
        print(k,'N=',len(arts),'contiguous',ok,'last',nos[-1] if nos else None,'empty',empty,'heads',len(heads))
    json.dump(res,open(dst,'w'),ensure_ascii=False,indent=1)
