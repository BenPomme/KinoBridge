---
name: kinobridge-media-pipeline
description: Build, diagnose, and validate KinoBridge authenticated HLS playback, probing, Top-Bottom to Side-by-Side conversion, XREAL output, and offline remux or transcode behavior using mpv, FFmpeg, ffprobe, and VLC.
---

# KinoBridge Media Pipeline

1. Read `references/pipeline.md` before changing player, filter, broker, or download behavior.
2. Run `scripts/check-tools.sh` before media integration tests.
3. Use `scripts/generate-tb-fixture.sh <output>` to create a synthetic eye-order fixture when needed.
4. Reproduce failures with sanitized local fixtures before using a signed Kino URL.
5. Never print, persist, or place signed URLs, cookies, or authorization headers in test snapshots.
6. Use the loopback broker for authenticated playback and downloads; never turn it into an arbitrary URL proxy.
7. Use argument arrays with `shell: false`; validate enums, dimensions, output paths, and filenames before spawning.
8. Keep remux and SBS transcode paths separate. Remux must not decode video.
9. Write downloads to a temporary sibling file, validate with ffprobe, and rename atomically only after success.
10. Run helper tests, root tests, synthetic pixel/metadata checks, and dependency diagnostics before live playback.
