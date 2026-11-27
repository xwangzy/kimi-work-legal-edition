#!/bin/bash
# 正片按场景分段渲染 4K60（每段一个 H.264 中间文件，crf 10），再无损拼接、母带（scripts/master.sh 统一重新编码 + 响度）。
# 只有改过的场景需要重渲：scripts/render-segments.sh corpus night …；不带参数则渲染缺失的全部场景；FORCE=1 全部重渲。
# 最后：scripts/render-segments.sh --assemble 生成 out/final/KimiWorkLegal-V5-正片-4K60.mp4
set -e
cd "$(dirname "$0")/.."
mkdir -p out/seg out/final
CONC=${CONC:-10}
scenes=$(node -e 'import("./src/timeline.ts").then(m=>console.log(Object.entries(m.SCENES).map(([k,v])=>k+":"+v.from+":"+(v.from+v.dur-1)).join(" ")))')
if [ "$1" = "--assemble" ]; then
  : > out/seg/list.txt
  for sc in $scenes; do k=${sc%%:*}; echo "file '$k.mp4'" >> out/seg/list.txt; done
  ffmpeg -v error -y -f concat -safe 0 -i out/seg/list.txt -c copy out/seg/_video.mp4
  I=$(ffmpeg -nostats -i public/audio/score.wav -af ebur128 -f null - 2>&1 | awk '/Integrated loudness/{f=1} f&&/I:/{print $2; exit}')
  g=$(python3 -c "print(round(-16 - ($I), 2))")
  echo "响度增益 ${g} dB → −16 LUFS"
  scripts/master.sh out/seg/_video.mp4 public/audio/score.wav "$g" "out/final/KimiWorkLegal-V5-正片-4K60.mp4"
  ls -la out/final
  exit 0
fi
for sc in $scenes; do
  k=${sc%%:*}; rest=${sc#*:}; a=${rest%%:*}; b=${rest#*:}
  if [ $# -gt 0 ] && ! printf '%s\n' "$@" | grep -qx "$k"; then continue; fi
  if [ $# -eq 0 ] && [ -z "$FORCE" ] && [ -f "out/seg/$k.mp4" ]; then echo "跳过 $k（已存在）"; continue; fi
  echo "渲染 $k 帧 $a-$b"
  npx remotion render src/index.ts KimiWorkLegalV5 "out/seg/$k.mp4" --frames=$a-$b --scale=2 --codec=h264 --crf=10 --pixel-format=yuv420p --muted --concurrency=$CONC --log=info
done
ls -la out/seg
