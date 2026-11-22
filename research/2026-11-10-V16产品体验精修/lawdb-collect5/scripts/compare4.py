import re, sys, os, json, html
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_second import split2
R=sys.argv[1]; W=sys.argv[2]
SRC={
 'patent':[('npc','http://www.npc.gov.cn/npc/c2/c30834/202011/t20201119_308800.html','patent.html')],
 'antimonopoly':[('samr','https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2023/art_f0fae9eb3a684fc39e84d89eabfc2caa.html','antimonopoly_samr.html')],
 'laborreg':[('govcn','https://www.gov.cn/zhengce/2008-09/19/content_2602519.htm','laborreg.html'),('govcn_gongbao','https://www.gov.cn/gongbao/content/2008/content_1107604.htm','laborreg_gongbao.html')],
 'unfair':[('samr','https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2023/art_3737890d856a4e44a8ea07c50c90c116.html','unfair_samr.html'),('spp','https://www.spp.gov.cn/spp/fl/202506/t20250627_699862.shtml','unfair_spp.html')],
 'datasec':[('npc','http://www.npc.gov.cn/npc/c2/c30834/202106/t20210610_311888.html','datasec.html')],
}
SAMPLE={'patent':[42,71,74],'antimonopoly':[17,22,63],'laborreg':[6,19,27],'unfair':[7,9,22],'datasec':[21,27,45]}
H2F=str.maketrans({',':'，',';':'；',':':'：','(':'（',')':'）'})
def strict(s): return re.sub(r'[\s　​\xa0﻿]+','',s)
def norm(s): return strict(s).translate(H2F)
def lines(path):
    t=open(path,encoding='utf-8',errors='replace').read()
    j=t.rfind('起施行。'); t=t[:j+4]
    t=re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>','',t)
    t=re.sub(r'(?is)<!--.*?-->','',t)
    t=re.sub(r'(?i)<br\s*/?>|</p>|</div>|<p[^>]*>|</td>|</tr>','\n',t)
    t=re.sub(r'<[^>]+>','',t)
    t=html.unescape(t).replace('\xa0',' ')
    return t.split('\n')
flk=json.load(open(f'{W}/flk_split.json'))
out={}
for k,srcs in SRC.items():
    a1={a['no']:a['text'] for a in flk[k]['articles']}
    out[k]=[]
    for tag,url,fn in srcs:
        arts=split2(lines(f'{R}/second/{fn}'))
        nos=[a['no'] for a in arts]
        a2={a['no']:a['text'] for a in arts}
        mism=[n for n in sorted(set(a1)|set(a2)) if norm(a1.get(n,''))!=norm(a2.get(n,''))]
        strict_m=[n for n in sorted(set(a1)|set(a2)) if strict(a1.get(n,''))!=strict(a2.get(n,''))]
        samp={n:(strict(a1[n])==strict(a2.get(n,''))) for n in SAMPLE[k]}
        r=dict(source=tag,url=url,file=fn,n=len(arts),contiguous=nos==list(range(1,len(nos)+1)),mismatch_norm=mism,mismatch_strict=strict_m,sample_strict_equal=samp,
               diffs=[{'no':n,'flk':a1.get(n),'second':a2.get(n)} for n in strict_m])
        out[k].append(r)
        print(k,tag,'N2=',len(arts),'contig',r['contiguous'],'N1=',len(a1),'mism_norm',mism,'mism_strict',strict_m,'sample',samp)
json.dump(out,open(f'{W}/compare.json','w'),ensure_ascii=False,indent=1)
