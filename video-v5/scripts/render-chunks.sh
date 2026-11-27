#!/bin/bash
# 正片 4K60 分块并行渲染：每块约 500 帧、一个独立的渲染进程（各自的浏览器实例，避免单浏览器的合成瓶颈），P 个进程并行。
# 已存在的块跳过（中断后可续渲）；全部完成后 --assemble 拼接并做母带。用法：P=3 CONC=4 scripts/render-chunks.sh [--assemble]
set -e
cd "$(dirname "$0")/.."
mkdir -p out/chunks out/final
P=${P:-3}; CONC=${CONC:-4}; STEP=${STEP:-500}
TOTAL=$(node -e 'import("./src/timeline.ts").then(m=>console.log(m.DURATION))')
if [ "$1" = "--assemble" ]; then
  : > out/chunks/list.txt
  for ((a=0; a<TOTAL; a+=STEP)); do echo "file 'c$(printf %05d $a).mp4'" >> out/chunks/list.txt; done
  ffmpeg -v error -y -f concat -safe 0 -i out/chunks/list.txt -c copy out/chunks/_video.mp4
  n=$(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 out/chunks/_video.mp4)
  echo "拼接帧数 $n / $TOTAL"
  I=$(ffmpeg -nostats -i public/audio/score.wav -af ebur128 -f null - 2>&1 | awk '/Integrated loudness/{f=1} f&&/I:/{print $2; exit}')
  g=$(python3 -c "print(round(-16 - ($I), 2))")
  echo "响度增益 ${g} dB → −16 LUFS"
  scripts/master.sh out/chunks/_video.mp4 public/audio/score.wav "$g" "out/final/KimiWorkLegal-V5-正片-4K60.mp4"
  exit 0
fi
jobs=()
for ((a=0; a<TOTAL; a+=STEP)); do
  b=$((a+STEP-1)); [ $b -ge $TOTAL ] && b=$((TOTAL-1))
  f="out/chunks/c$(printf %05d $a).mp4"
  [ -f "$f" ] && continue
  jobs+=("$a-$b")
done
export CONC
printf '%s\n' "${jobs[@]}" | xargs -P "$P" -n 1 scripts/render-one-chunk.sh
ls out/chunks | grep -c '^c.*\.mp4$'
