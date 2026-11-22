import json, sys, subprocess, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ids import IDS
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
raw=sys.argv[1]; jar=sys.argv[2]
os.makedirs(raw+"/docx",exist_ok=True)
def get(url,fn,ref="https://flk.npc.gov.cn/detail"):
    subprocess.run(["curl","-sL","--compressed","-A",UA,"-b",jar,"-c",jar,"-H","Referer: "+ref,"-o",fn,url],check=True)
for k,i in IDS.items():
    fn=f"{raw}/detail_{k}.json"
    get(f"https://flk.npc.gov.cn/law-search/search/flfgDetails?bbbs={i}",fn)
    d=json.load(open(fn))['data']
    print(k,d.get('title'),'gbrq',d.get('gbrq'),'sxrq',d.get('sxrq'),'sxx',d.get('sxx'),'zdjg',d.get('zdjgName'),'flxz',d.get('flxz'))
    time.sleep(1.2)
    fn2=f"{raw}/dl_{k}.json"
    get(f"https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs={i}&fileId=",fn2)
    dd=json.load(open(fn2))
    url=dd["data"]["url"]
    assert url.startswith("https://flkoss.obs-bj2.cucloud.cn/prod/"), url
    ext=url.split('?')[0].rsplit('.',1)[-1]
    out=f"{raw}/docx/{k}.{ext}"
    r=subprocess.run(["curl","-sL","-A",UA,"-o",out,"-w","%{http_code} %{size_download} %{content_type}",url],capture_output=True,text=True)
    print('  ',url.split('?')[0].split('cucloud.cn/')[1],r.stdout, open(out,'rb').read(4))
    time.sleep(1.2)
