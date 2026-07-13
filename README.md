# KinoBridge

KinoBridge is a macOS-first companion for an authenticated Kino Chrome session. It detects the movie's authorized HLS stream, lets the user choose quality/audio/subtitles, plays it in a local player, downloads accessible titles for offline viewing, and converts supported Top/Bottom 3D video to XREAL-compatible Full-SBS.

> **New user? Start with the [complete installation and user guide](docs/installation.md).** It covers installation, first launch, soundtrack and subtitle selection, quality, offline downloads/playback, updates, uninstalling, and 3D conversion.

## What it does

| Feature | Current behavior |
|---|---|
| Authenticated playback | Uses the user's existing `kino.pub` or supported `zerkalo.xyz` Chrome session through a tokenized localhost broker. |
| Persistent controls | Opens one companion window that stays open until minimized or closed. |
| Audio and subtitles | Offers exact detected tracks; defaults to Original audio, then English, with regular English subtitles. |
| Quality | Auto/highest available or a 4K, 1080p, or 720p cap. |
| External players | mpv is the reference player; VLC and IINA are 2D alternatives. |
| Offline viewing | Downloads accessible, non-encrypted streams to validated MKV files and maintains a local offline library. |
| 3D | Converts stable Half/Full Top/Bottom sources to 3840×1080 Full-SBS, including verified dual-eye subtitles in downloaded MKVs. |

## Install summary

The current MVP is installed from source as an unpacked Chrome extension plus a per-user native helper. It is not yet a signed/notarized one-click consumer installer.

```sh
brew install git node ffmpeg mpv
npm install --global pnpm@10.28.2
cd ~
git clone https://github.com/BenPomme/KinoBridge.git
cd KinoBridge
pnpm install --frozen-lockfile
pnpm build
pnpm diagnose
pnpm --filter @kinobridge/native-helper install-host -- --extension-id dkbpgionmjfdebegdnooaacggijpaekc
```

Then load `~/KinoBridge/extension/dist` from `chrome://extensions` using **Developer mode → Load unpacked**. The [complete guide](docs/installation.md) includes every Chrome step and first-use check.

## Supported boundaries

- Apple Silicon and macOS 14+
- Google Chrome with an ordinary authenticated Kino session
- Accessible, non-encrypted HLS streams only
- Half Top/Bottom and Full Top/Bottom input for 3D conversion
- Completed MKV files work offline without Chrome or Kino

KinoBridge does not store passwords, bypass Widevine/FairPlay/other DRM, acquire encryption keys, import arbitrary local 3D files, or guarantee background downloads after Chrome closes.

## Documentation

- [Installation and user guide](docs/installation.md) — start here
- [Offline pipeline and recovery details](docs/offline.md)
- [Testing and live acceptance](docs/testing.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Packaging status](docs/packaging.md)

## Development status

This repository contains the working MVP: Chrome MV3 extension, Native Messaging helper, authenticated loopback broker, HLS inspection, player adapters, automatic per-title stereo analysis, persistent offline queue/library, sanitized fixtures, and automated tests.

Authenticated playback and real 3840×1080 VideoToolbox conversion have been smoke-tested on Apple Silicon. Physical XREAL acceptance, public signing/notarization, and a consumer installer remain release gates.
