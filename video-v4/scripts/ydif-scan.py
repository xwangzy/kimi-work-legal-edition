#!/usr/bin/env python3
"""单帧突变扫描：逐帧亮度差（ffmpeg signalstats YDIF），报告超过邻域中位数 4 倍且绝对值 > 6 的帧。
用法：python3 scripts/ydif-scan.py <视频> [场景切点秒,...]  —— 场景切点附近 ±2 帧不计（有意的硬切）。"""
import subprocess, sys, statistics
path = sys.argv[1]
cuts = [float(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 and sys.argv[2] else []
out = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", "scale=480:-1,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-", "-f", "null", "-"], capture_output=True, text=True).stdout
vals = []
t = None
for line in out.splitlines():
    if line.startswith("frame:"):
        t = float(line.split("pts_time:")[1])
    elif "YDIF=" in line:
        vals.append((t, float(line.split("=")[1])))
hits = []
for i, (t, v) in enumerate(vals):
    nb = [x[1] for x in vals[max(0, i - 6):i] + vals[i + 1:i + 7]]
    med = statistics.median(nb) if nb else 0
    if v > 6 and v > 4 * max(med, 0.5):
        if any(abs(t - c) < 2.5 / 60 for c in cuts):
            continue
        hits.append((t, v, med))
for t, v, m in hits:
    print(f"{t:8.3f}s  YDIF {v:6.1f}  邻域中位 {m:5.2f}")
print(f"共 {len(hits)} 处（已排除 {len(cuts)} 个场景切点）")
