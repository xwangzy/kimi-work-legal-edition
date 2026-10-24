#!/bin/bash
# 用法：scripts/sheet.sh <合成ID> <帧1> <帧2> ...  —— 把整场按半分辨率渲染成预览片，再抽出指定帧拼成 3 列联系表（检查用）
# 输出：out/prev/<合成ID>.mp4 与 out/sheets/<合成ID>.png。设 SKIP_RENDER=1 时复用已有预览片。
set -e
cd "$(dirname "$0")/.."
comp=$1; shift
mkdir -p out/prev out/sheets
[ -n "$SKIP_RENDER" ] || npx remotion render src/index.ts "$comp" "out/prev/$comp.mp4" --scale=0.5 --log=error >/dev/null
args=(); fl=""; ins=""; lay=""; i=0
for fr in "$@"; do
  args+=(-i "out/prev/$comp.mp4")
  fl="$fl[$i:v]select=eq(n\,$fr),setpts=PTS-STARTPTS[v$i];"
  ins="$ins[v$i]"; lay="$lay${lay:+|}$(( (i%3)*960 ))_$(( (i/3)*540 ))"; i=$((i+1))
done
ffmpeg -y -loglevel error "${args[@]}" -filter_complex "${fl}${ins}xstack=inputs=$i:layout=$lay:fill=black" -frames:v 1 "out/sheets/$comp.png"
echo "out/sheets/$comp.png"
