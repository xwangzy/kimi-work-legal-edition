#!/bin/bash
# V5 全部交付物：正片 4K60、30 秒版 4K60、封面（16:9 4K、1:1、3:4）、联合品牌落版静帧。
# 母带：广播范围 BT.709；音轨按 EBU R128 测量后静态增益到 −16 LUFS（网络版），真峰值 ≤ −1.5 dBTP（scripts/master.sh 限幅）；另出 −23 LUFS 广播版音轨。
# 用法：scripts/render-all.sh [main|cut|stills|all]；CONC 控制并发（缺省 10）。
set -e
cd "$(dirname "$0")/.."
what=${1:-all}
mkdir -p out/final
CONC=${CONC:-10}
gain_for() { # $1 wav $2 目标 LUFS → 输出需要的增益 dB
  local I
  I=$(ffmpeg -nostats -i "$1" -af ebur128 -f null - 2>&1 | awk '/Integrated loudness/{f=1} f&&/I:/{print $2; exit}')
  python3 -c "print(round($2 - ($I), 2))"
}
render() { # $1 合成 $2 输出文件名 $3 配乐 wav
  npx remotion render src/index.ts "$1" "out/final/.tmp-$2" --scale=2 --codec=h264 --crf=14 --pixel-format=yuv420p --props='{"audio":true}' --audio-codec=aac --audio-bitrate=320k --concurrency=$CONC --log=error
  local g; g=$(gain_for "$3" -16)
  echo "$2: 响度增益 ${g} dB → −16 LUFS"
  scripts/master.sh "out/final/.tmp-$2" "$3" "$g" "out/final/$2"
  rm -f "out/final/.tmp-$2"
}
if [ "$what" = all ] || [ "$what" = music ]; then node scripts/make-music.mjs && SCORE=cut30 node scripts/make-music.mjs; fi
if [ "$what" = all ] || [ "$what" = main ]; then render KimiWorkLegalV5 "KimiWorkLegal-V5-正片-4K60.mp4" public/audio/score.wav; fi
if [ "$what" = all ] || [ "$what" = cut ]; then render KimiWorkLegalV5-30s "KimiWorkLegal-V5-30秒-4K60.mp4" public/audio/score-cut30.wav; fi
if [ "$what" = all ] || [ "$what" = stills ]; then
  npx remotion still src/index.ts Cover "out/final/KimiWorkLegal-V5-封面-4K.png" --scale=2 --log=error
  npx remotion still src/index.ts Cover-1x1 "out/final/KimiWorkLegal-V5-封面-1x1.png" --scale=2 --log=error
  npx remotion still src/index.ts Cover-3x4 "out/final/KimiWorkLegal-V5-封面-3x4.png" --scale=2 --log=error
  npx remotion still src/index.ts S-finale "out/final/KimiWorkLegal-V5-联合品牌落版-4K.png" --frame=760 --scale=2 --log=error
fi
if [ "$what" = all ] || [ "$what" = broadcast ]; then
  g=$(gain_for public/audio/score.wav -23)
  ffmpeg -v error -y -i public/audio/score.wav -af "volume=${g}dB,alimiter=limit=0.79:level=disabled" -c:a pcm_s24le "out/final/KimiWorkLegal-V5-正片-配乐-广播版-23LUFS.wav"
fi
ls -la out/final
