# Testing

## Automated

```sh
pnpm qa
```

Tests cover shared validation, HLS classification, Native Messaging framing, safe proxy routing and refresh lineage, exact source-tab binding, persistent companion-window creation/restoration/deduplication, explicit video/audio/subtitle download inputs, duration/track/decode validation, persistent queue restart behavior, local library actions, filter construction, player arguments, filenames, job cancellation, and redaction. Generated HLS integration fixtures prove separate video/audio/WebVTT remuxing and an automatically analyzed VideoToolbox SBS transcode with a dual-eye ASS subtitle. Pixel-level FFmpeg fixtures cover no packing gap, a central gap, outer letterboxing, manual alignment, and eye swapping. Fixtures contain no signed Kino URLs.

## Synthetic stereo

```sh
.codex/skills/kinobridge-media-pipeline/scripts/generate-tb-fixture.sh
```

Use the generated red/blue Top/Bottom file to verify left/right ordering before testing XREAL hardware.

## Live smoke sequence

1. Open an already-authenticated Kino.pub title and start playback.
2. Click the KinoBridge toolbar icon. Confirm its companion window stays open after focusing the Kino tab, lists several candidates without exposing query tokens, and reuses the same window when clicked again.
3. Probe the highest-ranked master candidate.
4. Play through VLC to prove broker authentication, then through mpv to verify tracks.
5. Expire or refresh the page and confirm a recoverable refresh error.
6. Test Top/Bottom-to-SBS on the Mac display, then connect XREAL Air 2 and manually enable SBS mode.
7. Download a short authorized, non-encrypted movie completely. Confirm the expected audio and subtitle languages in the Offline library.
8. Disconnect networking, use **Play** from the Offline library, seek near the end, and verify audio/subtitles.
9. Reconnect, start a second download, close/reopen Chrome, verify the job becomes interrupted, then capture the same title and use **Retry from current Kino tab**.

Never capture passwords, cookies, raw signed URLs, or private browser data in screenshots or test artifacts.
