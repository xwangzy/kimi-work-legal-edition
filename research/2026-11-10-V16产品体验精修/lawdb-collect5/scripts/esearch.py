import json, re, sys, subprocess, time
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
out=sys.argv[1]; jar=sys.argv[2]
for i,q in enumerate(sys.argv[3:]):
    body=json.dumps({"searchRange":1,"sxrq":[],"gbrq":[],"searchType":1,"sxx":[],"gbrqYear":[],"flfgCodeId":[],"zdjgCodeId":[],"searchContent":q,"pageNum":1,"pageSize":50},ensure_ascii=False)
    fn=f"{out}/esearch_{abs(hash(q))%100000}.json"
    subprocess.run(["curl","-sL","--compressed","-A",UA,"-b",jar,"-c",jar,"-H","Content-Type: application/json;charset=UTF-8","-H","Referer: https://flk.npc.gov.cn/search","-X","POST","--data-binary",body,"-o",fn,"https://flk.npc.gov.cn/law-search/search/list"],check=True)
    try: d=json.load(open(fn))
    except Exception as e: print("ERR",q,open(fn,errors='replace').read()[:300]); continue
    print("==",q,"total",d.get("total"),fn)
    for r in d.get("rows",[]):
        print(" ",r["bbbs"],re.sub(r"<[^>]+>","",r["title"]),r["gbrq"],r["sxrq"],"sxx",r["sxx"],r["flxz"])
    time.sleep(1.5)
