#!/bin/sh
set -eu

output="${1:-tests/artifacts/top-bottom-fixture.mp4}"
mkdir -p "$(dirname "$output")"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=red:s=1920x540:r=30:d=3" \
  -f lavfi -i "color=c=blue:s=1920x540:r=30:d=3" \
  -filter_complex "[0:v]drawbox=x=40:y=40:w=320:h=120:color=white:t=16[top];[1:v]drawbox=x=1560:y=380:w=320:h=120:color=yellow:t=16[bottom];[top][bottom]vstack=inputs=2[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p "$output"
printf '%s\n' "$output"
