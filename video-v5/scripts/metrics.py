#!/usr/bin/env python3
"""节奏与明暗的量化（与 docs/00a 历史复盘同口径的近似）：
- 接近静止的秒数：64×36 灰度缩略图，每 1/8 秒帧差（0–255 平均绝对差）一秒内求和 < 1.5 记为静止；
- 明暗：每秒平均亮度 < 70 为暗，> 140 为亮；统计明暗翻转次数（暗↔亮，中间灰不计）；
- 画面转换：0.5 秒窗口帧差和超过阈值记一次转换。
用法：python3 scripts/metrics.py <视频>"""
import subprocess, sys

path = sys.argv[1]
w, h = 64, 36
cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", f"fps=8,scale={w}:{h},format=gray", "-f", "rawvideo", "-"]
raw = subprocess.run(cmd, capture_output=True).stdout
n = len(raw) // (w * h)
frames = [raw[i * w * h:(i + 1) * w * h] for i in range(n)]
diffs = [0.0]
for i in range(1, n):
    a, b = frames[i - 1], frames[i]
    diffs.append(sum(abs(a[k] - b[k]) for k in range(0, w * h, 1)) / (w * h))
secs = n // 8
static = 0
lum = []
for s in range(secs):
    d = sum(diffs[s * 8 + 1:(s + 1) * 8])
    if d < 1.5:
        static += 1
    fr = frames[s * 8 + 4]
    lum.append(sum(fr) / len(fr))
state = None
flips = 0
dark = light = 0
for y in lum:
    st = "d" if y < 70 else "l" if y > 140 else None
    if st == "d":
        dark += 1
    if st == "l":
        light += 1
    if st and state and st != state:
        flips += 1
    if st:
        state = st
trans = 0
i = 0
while i + 4 <= n:
    if sum(diffs[i:i + 4]) > 40:
        trans += 1
        i += 8
    else:
        i += 4
print(f"时长 {secs} s；接近静止 {static} s（{static / secs * 100:.0f}%）；暗 {dark} s / 亮 {light} s；明暗翻转 {flips} 次；画面转换约 {trans} 次（ASL≈{secs / max(1, trans):.1f} s）")
