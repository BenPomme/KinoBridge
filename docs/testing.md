# Testing

## Automated

```sh
pnpm qa
```

Tests cover shared validation, HLS classification, Native Messaging framing, safe proxy routing, filter construction, player arguments, filenames, job cancellation, and redaction. Fixtures contain no signed Kino URLs.

## Synthetic stereo

```sh
.codex/skills/kinobridge-media-pipeline/scripts/generate-tb-fixture.sh
```

Use the generated red/blue Top/Bottom file to verify left/right ordering before testing XREAL hardware.

## Live smoke sequence

1. Open an already-authenticated Kino.pub title and start playback.
2. Confirm the popup lists several candidates without exposing query tokens.
3. Probe the highest-ranked master candidate.
4. Play through VLC to prove broker authentication, then through mpv to verify tracks.
5. Expire or refresh the page and confirm a recoverable refresh error.
6. Test Top/Bottom-to-SBS on the Mac display, then connect XREAL Air 2 and manually enable SBS mode.

Never capture passwords, cookies, raw signed URLs, or private browser data in screenshots or test artifacts.
