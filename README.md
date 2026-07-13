# KinoBridge

KinoBridge is a macOS-first bridge from an authenticated Kino Chrome tab (`kino.pub` or its `zerkalo.xyz` service mirror) to local media players. It detects HLS playlists, resolves tracks through a native helper, plays through mpv or VLC, converts Top/Bottom stereo video to Side-by-Side, and downloads accessible streams into a persistent local offline library without bypassing DRM.

## Status

This repository contains the development MVP: MV3 extension, Native Messaging helper, authenticated loopback broker, HLS inspection, player adapters, stereo filters, persistent offline queue/library, fixtures, and tests. Authenticated Kino playback has been smoke-tested with VLC and mpv, including 3840×1080 Full-SBS output on the Mac display. The offline pipeline is covered by a generated HLS integration test with separate video, audio, and subtitles; full-title acceptance remains a user-selected live test. Physical XREAL SBS-mode acceptance and distribution signing still require user hardware and a Developer ID identity that are deliberately not stored in the repository.

## Quick start

```sh
pnpm install
brew install ffmpeg mpv
pnpm qa
pnpm build
pnpm diagnose
```

Then install the native host with the generated extension ID and load `extension/dist` as an unpacked extension. See `docs/installation.md` and `docs/testing.md`.

See `docs/offline.md` for the download, restart, library, and offline-playback flow.

## Safety boundary

KinoBridge reuses only the current authorized browser session. It does not store passwords or bypass Widevine, FairPlay, or another DRM system. Downloads are offered only when FFmpeg can access the stream normally.
