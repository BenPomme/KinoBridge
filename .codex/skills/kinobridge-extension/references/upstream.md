# Reviewed upstream guidance

The project skill adapts selected Manifest V3 guidance from `samber/cc-skills` `chrome-extension` version 1.0.2 at commit `cdac7110979e37988d6f2d373d602378cf5ca03a` (MIT).

Retained guidance:

- Register service-worker listeners synchronously.
- Persist restart-critical state in `chrome.storage.session`.
- Use a typed protocol and literal `true` for asynchronous runtime message responses.
- Bundle all extension code locally and avoid `eval`, remote code, and inline handlers.
- Test with service-worker DevTools closed and explicitly verify restart recovery.
- Keep permissions as narrow and explainable as the feature permits.

KinoBridge-specific corrections and additions:

- `webRequest` remains valid for passive observation in MV3; only blocking behavior is broadly restricted.
- KinoBridge needs explicit Kino and discovered CDN host access to observe subresource playlists.
- The Native Messaging boundary, HLS candidate association, sensitive header handling, and helper protocol are project-specific and take precedence over generic examples.
- Do not use generic page-to-content-script bridges or `declarativeNetRequest`; they are unnecessary for playlist observation.

Upstream source: https://github.com/samber/cc-skills/tree/cdac7110979e37988d6f2d373d602378cf5ca03a/skills/chrome-extension
