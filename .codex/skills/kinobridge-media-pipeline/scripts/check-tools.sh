#!/bin/sh
set -eu

missing=0
for tool in ffmpeg ffprobe mpv; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '%s: %s\n' "$tool" "$(command -v "$tool")"
  else
    printf '%s: missing\n' "$tool" >&2
    missing=1
  fi
done

vlc="/Applications/VLC.app/Contents/MacOS/VLC"
if [ -x "$vlc" ]; then
  printf 'vlc: %s\n' "$vlc"
else
  printf 'vlc: missing\n' >&2
fi

exit "$missing"
