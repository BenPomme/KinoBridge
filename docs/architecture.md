# Architecture

```text
Kino.pub tab
  -> MV3 request observer and persistent companion window
  -> versioned Native Messaging protocol
  -> Kino adapter and HLS inspector
  -> tokenized loopback access broker
  -> mpv / VLC / FFmpeg
```

The extension owns browser/tab association and transient request context. The helper owns HLS parsing, allowed-origin enforcement, player processes, stereo transforms, jobs, and validation. Shared Zod schemas reject invalid protocol messages at both boundaries.

Signed URLs and cookies remain in `chrome.storage.session` and helper memory. The helper exposes only random localhost broker URLs to media processes. Preferences may be stored persistently, but access context may not.

The service worker keeps a native port while jobs are active and reconstructs candidate state after restart. The companion window is bound to an exact Kino source-tab ID in session storage and is rediscovered by its exact extension URL after worker restart. Every candidate belongs to a top-frame navigation generation, preventing an old episode playlist from being reused after navigation.

Offline downloads run through a persistent single-worker FIFO queue. Only safe source identity, preferences, progress, output paths, and validated library metadata are written under Application Support; descriptors, signed URLs, cookies, and headers stay in memory. A helper restart marks unfinished work interrupted and requires a fresh descriptor from the matching Kino page before restarting.
