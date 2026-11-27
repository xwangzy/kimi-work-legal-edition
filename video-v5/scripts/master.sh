#!/bin/bash
# 母带：把 Remotion 输出（JPEG 帧 → yuvj420p 全范围）转为广播范围 yuv420p、BT.709 标记，并换上响度母带音轨（−16 LUFS / ≤ −1.5 dBTP，静态增益 + 峰值限制，不做动态压缩）。
# 用法：scripts/master.sh <Remotion 输出> <配乐 wav> <增益 dB> <交付文件>
set -e
src=$1; wav=$2; gain=$3; dst=$4
tmpwav="$(dirname "$dst")/.master-$$.wav"
ffmpeg -v error -y -i "$wav" -af "volume=${gain}dB,aresample=192000,alimiter=limit=0.79:attack=3:release=60:level=disabled,aresample=48000" -c:a pcm_s24le "$tmpwav"
ffmpeg -v error -y -i "$src" -i "$tmpwav" -map 0:v:0 -map 1:a:0 \
  -vf "scale=in_range=pc:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p" \
  -c:v libx264 -preset slow -crf 14 -profile:v high -level 5.2 -g 120 -bf 3 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 320k -ar 48000 -shortest -movflags +faststart "$dst.tmp.mp4"
# 把 BT.709 原色 / 传递特性 / 矩阵与“有限范围”写进 H.264 码流（容器标记之外，播放器以码流 VUI 为准）
ffmpeg -v error -y -i "$dst.tmp.mp4" -c copy -bsf:v h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0 -movflags +faststart "$dst"
rm -f "$dst.tmp.mp4"
rm -f "$tmpwav"
