#!/usr/bin/env bash
# scripts/mc-shot.sh —— 从虚拟屏（默认 :98）抓一帧，缩到 960 宽。
# 用法: bash scripts/mc-shot.sh [输出路径] [--display=:98] [--size=1280x720]
set -euo pipefail

OUT=/tmp/mc-client/frame.png
if [ $# -gt 0 ] && [[ "$1" != --* ]]; then OUT=$1; shift; fi
DISP=${MC_DISPLAY:-:98}
SIZE=${MC_CAPTURE_SIZE:-1280x720}
WIDTH=${MC_SHOT_WIDTH:-960}

for arg in "$@"; do
  case "$arg" in
    --display=*) DISP=${arg#*=} ;;
    --size=*) SIZE=${arg#*=} ;;
  esac
done

mkdir -p "$(dirname "$OUT")"
xdpyinfo -display "$DISP" >/dev/null 2>&1 || { echo "[shot] 虚拟屏 $DISP 不在（先跑 mc-client-headless.sh）"; exit 1; }
ffmpeg -hide_banner -loglevel error -y \
  -f x11grab -video_size "$SIZE" -i "$DISP+0,0" \
  -frames:v 1 -vf "scale=$WIDTH:-1" "$OUT"
[ -s "$OUT" ] || { echo "[shot] 抓帧失败"; exit 1; }
echo "$OUT"
