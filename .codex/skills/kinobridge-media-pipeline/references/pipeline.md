# KinoBridge media pipeline

## Authentication broker

- Bind to `127.0.0.1` on an ephemeral port.
- Generate a high-entropy token for each registered stream.
- Accept upstream URLs only when their HTTPS origin has already been derived from the selected candidate or a parsed child playlist.
- Inject the minimum browser context required upstream and rewrite playlist URIs back through the same tokenized route.
- Do not log raw upstream URLs, query strings, cookies, or request headers.

## Playback

- Use VLC only as a simple 2D fallback and authentication smoke test.
- Use mpv as the reference player with a permission-restricted JSON IPC socket.
- Normal output uses direct decode with language preferences and optional external subtitles.
- Top/Bottom output uses split, per-eye crop, scale, optional eye swap, and horizontal stack.
- For SBS subtitles, render before eye splitting so the subtitle appears identically in both eyes.

## Downloads

- Original-quality default: select streams and remux to MKV with codec copy.
- SBS output: filter video and encode with `h264_videotoolbox` or `hevc_videotoolbox`; copy compatible audio.
- Parse FFmpeg progress from machine-readable output, support cancellation, remove partial files, and validate the final stream map with ffprobe.
- Stop on DRM or unsupported encryption. Never acquire keys outside normal HLS access.

## Acceptance

- Synthetic fixture proves eye order, 3840x1080 geometry, and subtitle duplication.
- Apple Silicon benchmark maintains real-time 1080p playback without unbounded buffering.
- Real Kino and XREAL tests occur only in an already-authenticated user session.
