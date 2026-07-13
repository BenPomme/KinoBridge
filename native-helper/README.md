# KinoBridge native helper

The helper is a Node.js Native Messaging host. It validates versioned messages from the Chrome extension, inspects HLS manifests, serves authorized streams through an ephemeral loopback broker, controls media players, and manages cancellable offline jobs.

## Commands

- `hello`: returns the helper/protocol version and dependency diagnostics.
- `probe`: accepts `{ candidate }` and returns a parsed `StreamDescriptor`.
- `play`: accepts `{ descriptor, options }`; the envelope ID becomes the job ID.
- `download`: accepts `{ descriptor, options }`; the envelope ID becomes the job ID.
- `cancel`: accepts `{ jobId }`.
- `status`: accepts `{ jobId? }`.
- `refreshResponse`: accepts `{ jobId, candidate }` and updates the active broker after a `refreshRequired` event.

All messages use Chrome's four-byte little-endian length prefix. Messages larger than 1 MiB are rejected. Standard output is reserved for protocol frames; sanitized diagnostics go to standard error.

## Security boundaries

- The broker binds to `127.0.0.1` on an ephemeral port and uses a 256-bit random session capability.
- The initial candidate determines the single allowed HTTPS origin. Manifest references and redirects cannot escape it.
- Upstream URLs and browser access headers remain in helper memory. Rewritten player URLs reveal neither signed upstream URLs nor cookies.
- Processes are started by absolute allowlisted paths with argument arrays and `shell: false`.
- Download filenames are normalized, contained within the selected directory, collision-suffixed, written to a random temporary file, validated with ffprobe, and installed without overwriting through an atomic hard link.

## Local QA

```sh
pnpm --filter @kinobridge/shared build
pnpm --filter @kinobridge/native-helper check
pnpm --filter @kinobridge/native-helper test
pnpm --filter @kinobridge/native-helper build
pnpm --filter @kinobridge/native-helper diagnose
```

FFmpeg/ffprobe/mpv are detected in standard Homebrew locations. VLC and IINA are detected in `/Applications`. The current SBS filter converts Top/Bottom video to Full-SBS; resolving and burning duplicate per-eye external subtitles is intentionally left to the extension/helper track-selection integration rather than guessing a subtitle stream.
