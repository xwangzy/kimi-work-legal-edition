import zipfile, re, json, subprocess, urllib.request, ssl, sys, time, os
def docx_text(p):
    z = zipfile.ZipFile(p); x = z.read("word/document.xml").decode()
    out=[]
    for para in re.findall(r"<w:p[ >].*?</w:p>", x, flags=re.S):
        t="".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", para, flags=re.S))
        if t.strip(): out.append(t)
    return "\n".join(out)
mat_dir, draft, task, stance, outp = sys.argv[1:6]
effort = sys.argv[6] if len(sys.argv) > 6 else None
mats=[]
for f in sorted(os.listdir(mat_dir)):
    p=os.path.join(mat_dir,f)
    if f.endswith(".docx"): mats.append((f, docx_text(p)))
    elif f.endswith(".txt"): mats.append((f, open(p,encoding="utf-8").read()))
drafts=[(os.path.basename(d), docx_text(d)) for d in draft.split("|")]
prompt = open(os.path.join(os.path.dirname(__file__),"reviewer_prompt.txt"),encoding="utf-8").read()
body = prompt.replace("{TASK}", task).replace("{STANCE}", stance)
body += "\n\n=== 事项材料 ===\n" + "\n\n".join(f"【材料：{n}】\n{t}" for n,t in mats)
body += "\n\n=== 待复核交付件 ===\n" + "\n\n".join(f"【交付件：{n}】\n{t}" for n,t in drafts)
kc = subprocess.run(["security","find-generic-password","-a","kwl-demo","-s","kwl-demo-maas-key","-w"],capture_output=True,text=True).stdout.strip()
req = urllib.request.Request("https://maas.jointpilot.com/v1/chat/completions", data=json.dumps({"model":"kimi-k3.1-pro","messages":[{"role":"user","content":body}],"max_tokens":32000,**({"reasoning_effort":effort} if effort else {}),"stream":True,"stream_options":{"include_usage":True}}).encode(), headers={"Authorization":"Bearer "+kc,"Content-Type":"application/json"})
t=time.time(); first=None; content=[]; reasoning=0; usage=None; gaps=0; last=time.time()
with urllib.request.urlopen(req, timeout=300, context=ssl.create_default_context()) as r:
    for raw in r:
        line=raw.decode().strip()
        if not line.startswith("data:"): continue
        data=line[5:].strip()
        if data=="[DONE]": break
        now=time.time(); gaps=max(gaps, now-last); last=now
        d=json.loads(data)
        if d.get("usage"): usage=d["usage"]
        for ch in d.get("choices",[]):
            dl=ch.get("delta",{})
            if dl.get("reasoning_content"): reasoning+=len(dl["reasoning_content"]); first=first or now-t
            if dl.get("content"): content.append(dl["content"]); first=first or now-t
open(outp,"w",encoding="utf-8").write("".join(content))
print("secs", round(time.time()-t), "first", round(first or -1,1), "maxgap", round(gaps,1), "reasoning_chars", reasoning, "usage", usage, "chars_in", len(body))
