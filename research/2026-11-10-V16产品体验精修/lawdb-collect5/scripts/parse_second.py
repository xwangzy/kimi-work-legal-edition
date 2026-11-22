import re, sys, os, json, html
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from split import cn2int, HEAD, WS
ART2=re.compile(r'^第([零一二三四五六七八九十百千]+)条[　 \t]*(.*)$', re.S)
def html_lines(path):
    t=open(path,encoding='utf-8',errors='replace').read()
    for start in ('id="Zoom"','class="txt_txt"'):
        i=t.find(start)
        if i>=0: t=t[i:]; break
    for end in ('<div class="editor">','<div class="txt_etr">'):
        j=t.find(end)
        if j>=0: t=t[:j]; break
    t=re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>','',t)
    t=re.sub(r'(?i)<br\s*/?>|</p>|</div>|<p[^>]*>','\n',t)
    t=re.sub(r'<[^>]+>','',t)
    t=html.unescape(t).replace('\xa0',' ')
    return t.split('\n')
def split2(lines):
    arts=[];cur=None
    for ln in lines:
        s=ln.strip(WS)
        if not s: continue
        m=ART2.match(s)
        if m:
            cur={'no':cn2int(m.group(1)),'lines':[m.group(2).strip(WS)] if m.group(2).strip(WS) else []}; arts.append(cur); continue
        if HEAD.match(s) or (re.match(r'^第[零一二三四五六七八九十百千]+[编章节]',s) and len(s)<40 and not s.endswith('。')): cur=None; continue
        if cur is not None: cur['lines'].append(s)
    return [{'no':a['no'],'text':'\n'.join(a['lines'])} for a in arts]
if __name__=='__main__':
    D=sys.argv[1]
    urls=dict(pipl='http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html',
      arbitration='http://www.npc.gov.cn/npc/c2/c30834/202509/t20250912_447762.html',
      copyright='http://www.npc.gov.cn/c2/c30834/202011/t20201119_308796.html',
      partnership=open(f'{D}/raw/second/partnership.url').read().strip(),
      labor1='https://www.court.gov.cn/fabu/xiangqing/282121.html')
    for k,u in urls.items():
        arts=split2(html_lines(f'{D}/raw/second/{k}.html'))
        nos=[a['no'] for a in arts]
        print(k,len(arts),'contiguous',nos==list(range(1,len(nos)+1)), 'last', arts[-1]['text'][-30:] if arts else None)
        json.dump({'url':u,'articles':arts},open(f'{D}/work/second_{k}.json','w'),ensure_ascii=False,indent=1)
