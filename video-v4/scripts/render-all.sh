#!/bin/bash
# 全部交付物：正片 4K60、30 秒版 4K60、封面、联合品牌落版静帧。母带见 scripts/master.sh：广播范围 BT.709，音轨 −16 LUFS、≤ −1.5 dBTP（静态增益 + 峰值限制；增益在配乐改动后需按 ebur128 重新测定）。
# 用法：scripts/render-all.sh [main|cut|stills|all]（缺省 all）；CONC 控制并发（缺省 10）。
set -e
cd "$(dirname "$0")/.."
what=${1:-all}
mkdir -p out/final
CONC=${CONC:-10}
render() { # $1 合成 $2 输出 $3 配乐 wav $4 增益 dB（使整片 −16 LUFS）
  npx remotion render src/index.ts "$1" "out/final/.tmp-$2" --scale=2 --codec=h264 --crf=15 --pixel-format=yuv420p --audio-codec=aac --audio-bitrate=320k --concurrency=$CONC --log=error
  scripts/master.sh "out/final/.tmp-$2" "$3" "$4" "out/final/$2"
  rm -f "out/final/.tmp-$2"
}
[ "$what" = all ] || [ "$what" = music ] && npm run music
if [ "$what" = all ] || [ "$what" = main ]; then render KimiWorkLegalV4 "KimiWorkLegal-V4-正片-4K60.mp4" public/audio/score.wav 3.57; fi
if [ "$what" = all ] || [ "$what" = cut ]; then render KimiWorkLegalV4-30s "KimiWorkLegal-V4-30秒-4K60.mp4" public/audio/score-cut30.wav 0.81; fi
if [ "$what" = all ] || [ "$what" = stills ]; then
  npx remotion still src/index.ts Cover "out/final/KimiWorkLegal-V4-封面-4K.png" --scale=2 --log=error
  npx remotion still src/index.ts S-partner "out/final/KimiWorkLegal-V4-联合品牌落版-4K.png" --frame=440 --scale=2 --log=error
  npx remotion still src/index.ts Cover-1x1 "out/final/KimiWorkLegal-V4-封面-1x1.png" --scale=2 --log=error
  npx remotion still src/index.ts Cover-3x4 "out/final/KimiWorkLegal-V4-封面-3x4.png" --scale=2 --log=error
fi
ls -la out/final
