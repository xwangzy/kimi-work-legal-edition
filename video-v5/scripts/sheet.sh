#!/bin/bash
# 用法：scripts/sheet.sh <合成ID> <帧1> <帧2> ...  —— 把整场按 1/2 分辨率渲染成预览片（缓存在 out/prev），再抽出指定帧拼成 3 列联系表
# 输出 out/sheets/<合成ID>.png。SKIP_RENDER=1 复用已有预览片；SCALE 覆盖缩放（缺省 0.5）。
set -e
cd "$(dirname "$0")/.."
comp=$1; shift
mkdir -p out/prev out/sheets
[ -n "$SKIP_RENDER" ] || npx remotion render src/index.ts "$comp" "out/prev/$comp.mp4" --scale=${SCALE:-0.5} --log=error --concurrency=${CONC:-12} --muted >/dev/null
TW=$(python3 -c "print(round(1920*${SCALE:-0.5}))"); TH=$(python3 -c "print(round(1080*${SCALE:-0.5}))")
args=(); fl=""; ins=""; lay=""; i=0
for fr in "$@"; do
  args+=(-i "out/prev/$comp.mp4")
  fl="$fl[$i:v]select=eq(n\,$fr),setpts=PTS-STARTPTS[v$i];"
  ins="$ins[v$i]"; lay="$lay${lay:+|}$(( (i%3)*TW ))_$(( (i/3)*TH ))"; i=$((i+1))
done
ffmpeg -y -loglevel error "${args[@]}" -filter_complex "${fl}${ins}xstack=inputs=$i:layout=$lay:fill=black" -frames:v 1 "out/sheets/$comp.png"
echo "out/sheets/$comp.png"
