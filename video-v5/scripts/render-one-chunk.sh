#!/bin/bash
# 渲染一个分块：scripts/render-one-chunk.sh <起帧-止帧>（由 render-chunks.sh 调用）
cd "$(dirname "$0")/.."
r=$1; a=${r%-*}
f="out/chunks/c$(printf %05d $a).mp4"
npx remotion render src/index.ts KimiWorkLegalV5 "$f.tmp.mp4" --frames=$r --scale=2 --codec=h264 --crf=10 --pixel-format=yuv420p --muted --concurrency=${CONC:-4} --timeout=120000 --log=error && mv "$f.tmp.mp4" "$f" && echo "完成 $r $(date +%H:%M:%S)"
