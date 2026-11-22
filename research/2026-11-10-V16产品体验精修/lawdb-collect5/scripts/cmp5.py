import re, sys, os, json, html
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from split import cn2int, WS
R=sys.argv[1]; W=sys.argv[2]
ART2=re.compile(r'^第([零一二三四五六七八九十百千]+)条[　 \t]*(.*)$', re.S)
JUNK=re.compile(r'责任编辑|相关稿件|相关链接|^【|^\[打印|上一篇|下一篇|法律声明|机关子站|国家规章库|^附件|返回首页|扫一扫|E-mail推荐|^分享|^来源')
SEC=re.compile(r'^[一二三四五六七八九十]+、[^。；：，]{1,25}$')
CH=re.compile(r'^第[零一二三四五六七八九十百千]+[编章节]')
H2F=str.maketrans({',':'，',';':'；',':':'：','(':'（',')':'）','?':'？','!':'！'})
def strict(s): return re.sub(r'[\s　​\xa0﻿]+','',s)
def loose(s): return strict(s).translate(H2F)
def lines(path):
    t=open(path,encoding='utf-8',errors='replace').read()
    t=re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>','',t)
    t=re.sub(r'(?is)<!--.*?-->','',t)
    t=re.sub(r'(?i)<br\s*/?>|</p>|</div>|<p[^>]*>|</td>|</tr>|</h\d>|</li>','\n',t)
    t=re.sub(r'<[^>]+>','',t)
    t=html.unescape(t).replace('\xa0',' ')
    return [s.strip(WS) for s in t.split('\n') if s.strip(WS)]
def split_from(ls,i):
    arts=[];cur=None
    for s in ls[i:]:
        m=ART2.match(s)
        if m:
            n=cn2int(m.group(1))
            if n!=len(arts)+1: break
            cur={'no':n,'lines':[m.group(2).strip(WS)] if m.group(2).strip(WS) else []}; arts.append(cur); continue
        if (CH.match(s) and len(s)<40 and not s.endswith('。')) or SEC.match(s): cur=None; continue
        if cur is not None: cur['lines'].append(s)
    if arts:
        L=arts[-1]['lines']
        for j,x in enumerate(L):
            if JUNK.search(x): del L[j:]; break
    return [{'no':a['no'],'text':'\n'.join(a['lines'])} for a in arts]
def split2(ls):
    best=[]
    for i,s in enumerate(ls):
        m=ART2.match(s)
        if m and m.group(1)=='一':
            a=split_from(ls,i)
            if len(a)>=len(best): best=a
    return best
def clean_primary(arts):
    heads=[]
    for a in arts:
        L=a['text'].split('\n')
        while L and SEC.match(L[-1]): heads.append((a['no'],L.pop()))
        a['text']='\n'.join(L)
    return heads
if __name__=='__main__':
    flk=json.load(open(f'{W}/flk_split.json'))
    PAIRS=json.load(open(sys.argv[3]))
    out={}
    for k,srcs in PAIRS.items():
        if k in flk:
            prim=flk[k]['articles']; heads=clean_primary(prim)
        else:
            prim=split2(lines(f'{R}/second/{srcs[0]}.html')); heads=[]; srcs=srcs[1:]
            flk[k]={'articles':prim,'from':PAIRS[k][0]}
        a1={a['no']:a['text'] for a in prim}
        print(f'## {k} primary N={len(prim)} heads_removed={heads}')
        out[k]=[]
        for tag in srcs:
            if not os.path.exists(f'{R}/second/{tag}.html') or os.path.getsize(f'{R}/second/{tag}.html')==0: print('  MISSING',tag); continue
            arts=split2(lines(f'{R}/second/{tag}.html'))
            a2={a['no']:a['text'] for a in arts}
            ms=[n for n in sorted(set(a1)|set(a2)) if strict(a1.get(n,''))!=strict(a2.get(n,''))]
            ml=[n for n in ms if loose(a1.get(n,''))!=loose(a2.get(n,''))]
            r=dict(source=tag,url=open(f'{R}/second/{tag}.url').read().strip(),n=len(arts),mismatch_strict=ms,mismatch_loose=ml,diffs=[{'no':n,'primary':a1.get(n),'second':a2.get(n)} for n in ms])
            out[k].append(r)
            print(f'  {tag}: N2={len(arts)} strict_diff={ms} loose_diff={ml}')
            for n in ml[:4]:
                x,y=strict(a1.get(n,'')),strict(a2.get(n,''))
                j=0
                while j<min(len(x),len(y)) and x[j]==y[j]: j+=1
                print(f'    #{n} at {j}: P=…{x[max(0,j-15):j+40]!r}\n              S=…{y[max(0,j-15):j+40]!r}')
    json.dump(out,open(f'{W}/compare.json','w'),ensure_ascii=False,indent=1)
    json.dump(flk,open(f'{W}/primary_clean.json','w'),ensure_ascii=False,indent=1)
