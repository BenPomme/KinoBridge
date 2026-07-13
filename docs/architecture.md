# Architecture

```text
Kino.pub tab
  -> MV3 request observer and popup
  -> versioned Native Messaging protocol
  -> Kino adapter and HLS inspector
  -> tokenized loopback access broker
  -> mpv / VLC / FFmpeg
```

The extension owns browser/tab association and transient request context. The helper owns HLS parsing, allowed-origin enforcement, player processes, stereo transforms, jobs, and validation. Shared Zod schemas reject invalid protocol messages at both boundaries.

Signed URLs and cookies remain in `chrome.storage.session` and helper memory. The helper exposes only random localhost broker URLs to media processes. Preferences may be stored persistently, but access context may not.

The service worker keeps a native port while jobs are active and reconstructs candidate state after restart. Every candidate belongs to a top-frame navigation generation, preventing an old episode playlist from being reused after navigation.
