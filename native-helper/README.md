# KinoBridge native helper

The helper is a Node.js Native Messaging host. It validates versioned messages from the Chrome extension, inspects HLS manifests, serves authorized streams through an ephemeral loopback broker, controls media players, and manages a persistent single-worker offline queue and local library.

## Commands

- `hello`: returns the helper/protocol version and dependency diagnostics.
- `probe`: accepts `{ candidate }` and returns a parsed `StreamDescriptor`.
- `play`: accepts `{ descriptor, options }`; the envelope ID becomes the job ID.
- `download`: accepts `{ descriptor, options }`; the envelope ID becomes the job ID.
- `cancel`: accepts `{ jobId }`.
- `status`: accepts `{ jobId? }`.
- `refreshResponse`: accepts `{ jobId, candidate }` and updates the active broker after a `refreshRequired` event.
- `offlineRetry` and `offlineRemove`: restart an interrupted item with a fresh descriptor or remove a non-running queue record.
- `libraryPlay`, `libraryReveal`, and `libraryDelete`: act only on a registered validated local media entry.

All messages use Chrome's four-byte little-endian length prefix. Messages larger than 1 MiB are rejected. Standard output is reserved for protocol frames; sanitized diagnostics go to standard error.

## Security boundaries

- The broker binds to `127.0.0.1` on an ephemeral port and uses a 256-bit random session capability.
- The initial candidate determines the single allowed HTTPS origin. Manifest references and redirects cannot escape it.
- Upstream URLs and browser access headers remain in helper memory. Rewritten player URLs reveal neither signed upstream URLs nor cookies.
- Processes are started by absolute allowlisted paths with argument arrays and `shell: false`.
- Download filenames are normalized, contained within the selected directory, collision-suffixed, written to a random temporary file, validated for container/codec/geometry/profile where applicable plus expected tracks/languages/duration and start/end decoding, and installed without overwriting through an atomic hard link.
- Video, preferred audio, and preferred subtitles are separate localhost-only FFmpeg inputs. Upstream signed URLs never appear in process arguments. SBS MKV downloads transform the selected subtitle into a temporary ASS track with one centered, clipped event per eye; temporary subtitle files are removed after completion or failure.
- Selected video and external audio/subtitle playlists are inspected through the authenticated localhost broker for encryption before FFmpeg starts. Exact track IDs take precedence; two- and three-letter ISO language aliases are normalized and an unavailable request fails instead of silently selecting another language. Remux validation checks advertised source codec/geometry while preserving the source's otherwise-unadvertised profile; SBS VideoToolbox output pins and validates H.264 High or HEVC Main.
- Queue/library state persists without descriptors or access context. Unfinished jobs become interrupted after helper restart and require a fresh authorized Kino capture.

## Local QA

```sh
pnpm --filter @kinobridge/shared build
pnpm --filter @kinobridge/native-helper check
pnpm --filter @kinobridge/native-helper test
pnpm --filter @kinobridge/native-helper build
pnpm --filter @kinobridge/native-helper diagnose
```

FFmpeg/ffprobe/mpv are detected in standard Homebrew locations. VLC and IINA are detected in `/Applications`. The current SBS filter converts Top/Bottom video to Full-SBS with independent eye alignment. Offline remuxing resolves the preferred audio/subtitle tracks explicitly and embeds the selected subtitle when requested.
