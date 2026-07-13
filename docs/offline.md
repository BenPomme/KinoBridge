# Offline downloads

KinoBridge downloads an authorized, non-encrypted Kino HLS title into a normal local MKV. After validation and atomic completion, the file no longer depends on Chrome, Kino, the access broker, or an internet connection.

## Download flow

1. Open the movie's Kino page while authenticated.
2. Reload the page, play for several seconds, and pause so KinoBridge captures a fresh master playlist and access context.
3. Open KinoBridge. Select the quality, audio/subtitle language order, output folder, filename, and codec.
4. Use **Original (remux)** to preserve source video without re-encoding. SBS output requires H.264 or HEVC VideoToolbox.
5. Click **Download MKV** and keep Chrome open while the job is active. Multiple movies form a FIFO queue and one download runs at a time.
6. KinoBridge downloads explicit video, preferred audio, and preferred subtitle inputs through localhost-only capability URLs.
7. Before completion, KinoBridge verifies the requested container, video codec and geometry, expected video/audio/subtitle streams and languages, checks duration tolerance, and decodes samples near the beginning and end. SBS transcodes additionally verify their encoder profile and exact output dimensions.
8. The validated temporary file is installed atomically and appears in **Offline library**.

## Expired stream access

If a signed HLS resource expires, the broker keeps the existing localhost resource stable and requests fresh access. KinoBridge rejects the expired candidate instead of immediately reusing it. The popup asks you to press Play in the matching Kino tab; a newly observed video/master candidate refreshes the master-to-variant-to-segment lineage and the failed request is retried once.

## Restart recovery

Signed URLs, cookies, and headers are never persisted. Queue and library metadata are stored with user-only permissions in `~/Library/Application Support/KinoBridge/offline-state.json`.

If Chrome or the helper stops during a download, unfinished jobs become **interrupted** and orphaned KinoBridge partial files are cleaned. Open the same Kino title, capture a fresh stream, and choose **Retry from current Kino tab**. V1 restarts that movie from the beginning; it does not resume at a segment boundary.

## Offline library

- **Play** opens the validated local file in mpv, VLC, or IINA and works without internet.
- **Reveal** selects the exact file in Finder.
- **Delete** asks for confirmation, deletes only the exact registered regular MKV/MP4, and removes its library record.
- Removing a completed queue record does not delete its library file.

## Boundaries

- Encrypted or DRM-protected HLS is rejected. KinoBridge does not extract keys or licenses.
- The selected video playlist and every selected external audio/subtitle playlist are checked for encryption before FFmpeg starts.
- Original remux preserves the source encoding profile. Because an HLS master does not reliably advertise that profile, remux validation checks the advertised source codec and geometry but does not require a named source profile. VideoToolbox SBS output is pinned and validated as H.264 High or HEVC Main.
- Chrome must remain open for an active download to receive refreshed authorization.
- A completed MKV is an ordinary local file; KinoBridge does not implement streaming-service DRM licenses or expiration.
- Ensure local storage and the user's Kino terms permit the intended download.
