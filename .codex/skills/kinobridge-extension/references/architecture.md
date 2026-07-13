# KinoBridge extension invariants

## Capture

- Restrict primary tab matching to `https://kino.pub/*` and its subdomains.
- Observe `.m3u8` requests with `webRequest`; attach `tabId`, `requestId`, initiator, timestamp, page URL, and the current navigation generation.
- Join access headers by `requestId`. Request `extraHeaders` only for `Referer` and `Cookie`; Chrome does not expose `Authorization` here.
- Keep unknown CDN permissions explicit and reviewable. Do not silently add `<all_urls>`.

## Classification

- Reject obvious subtitle candidates containing `/subtitles/` or `.srt/` only for ranking, not collection.
- Let the helper fetch and parse playlist contents. Prefer a playlist with variants or media groups over leaf playlists.
- Clear stale candidates after a top-frame navigation generation changes.

## Messaging and storage

- Keep one `runtime.connectNative("com.kinobridge.helper")` port in the service worker and reconnect with bounded backoff.
- Validate protocol version and message shape on both sides.
- Keep secrets in `chrome.storage.session`. Redact query tokens, cookies, and headers from logs and rendered errors.
- Expect popup closure and service-worker termination; no critical state may live only in a global variable.

## QA

- Cover subtitle-first traffic, multiple variants, cached requests, redirects, service-worker restart, native-host disconnect, and expired URLs.
- Load the unpacked `dist/` extension only after automated checks pass.
