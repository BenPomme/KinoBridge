---
name: kinobridge-extension
description: Build, diagnose, and test the KinoBridge Chrome Manifest V3 extension and its Native Messaging boundary. Use for KinoBridge playlist detection, tab and navigation association, transient access context, service-worker lifecycle, popup behavior, or native-host communication.
---

# KinoBridge Extension

1. Read `references/architecture.md` and `references/upstream.md` before changing capture, storage, or messaging behavior.
2. Keep Kino-specific extraction outside shared media-engine code.
3. Treat every URL, title, header, stored value, and native message as untrusted input.
4. Store signed URLs and cookies only in `chrome.storage.session`; store preferences without access context in `chrome.storage.local`.
5. Register MV3 listeners synchronously and reconstruct state after service-worker restart.
6. Observe all playlist candidates for the current navigation. Never treat the first `.m3u8` request as the master playlist.
7. Pass access context to the helper only after an explicit Play or Download action.
8. Render popup values with `textContent` or created DOM nodes. Do not use `innerHTML`, remote code, or inline event handlers.
9. Run `pnpm --filter @kinobridge/extension check` and `pnpm --filter @kinobridge/extension build` after changes, then run the root test suite.
10. Use sanitized fixtures or the local authenticated test server for automation. Reserve a real Kino session for user-authorized smoke tests.
