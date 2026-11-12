# 列出上游可用的型号，并对给定型号各发一次最小请求量一下输出速度（token/秒）。密钥只从钥匙串读进本进程内存，不打印、不落盘。
# 用法：python3 -I eval/probe-models.py [型号 …]
import json, ssl, subprocess, sys, time, urllib.error, urllib.request

key = subprocess.run(["security", "find-generic-password", "-a", "kwl-demo", "-s", "kwl-demo-maas-key", "-w"], capture_output=True, text=True).stdout.strip()
base = "https://maas.jointpilot.com/v1"

def req(path, body=None):
    r = urllib.request.Request(base + path, data=json.dumps(body).encode() if body else None, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    t = time.time()
    try:
        with urllib.request.urlopen(r, timeout=180, context=ssl.create_default_context()) as resp:
            return resp.status, json.loads(resp.read()), time.time() - t
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300].decode(errors="replace").replace(key, "***"), time.time() - t

st, data, dt = req("/models")
print("型号列表", st, [m["id"] for m in data.get("data", [])] if st == 200 else data)
for model in sys.argv[1:]:
    st, data, dt = req("/chat/completions", {"model": model, "messages": [{"role": "user", "content": "用大约八百字说明买卖合同中所有权保留条款的要点，分条写。"}], "max_tokens": 1500})
    if st != 200:
        print(model, "失败", st, str(data)[:200])
        continue
    u = data.get("usage", {})
    out = u.get("completion_tokens", 0)
    print(f"{model}：{dt:.1f} 秒，输出 {out} token（含推理），{out / dt:.0f} token/秒（含首字等待）；返回型号 {data.get('model')}")
