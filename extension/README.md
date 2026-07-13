# KinoBridge Chrome extension

For end-user installation and operation, follow the repository's [complete installation and user guide](../docs/installation.md).

Build with `pnpm --filter @kinobridge/extension build`, then load `extension/dist` from `chrome://extensions` in Developer mode.

Clicking the toolbar action opens one persistent KinoBridge companion window. It stays open when focus moves back to Chrome, VLC, or mpv; use the window's yellow macOS control or the in-app **Minimize** button to reduce it. Clicking the toolbar action again restores and focuses the same window instead of creating a duplicate. Closing the window is respected until the user explicitly opens KinoBridge again.

The manifest's public key fixes the development extension ID to `dkbpgionmjfdebegdnooaacggijpaekc`. The native host must allow exactly `chrome-extension://dkbpgionmjfdebegdnooaacggijpaekc/`.

KinoBridge initially has host access only to `kino.pub` and its subdomains. Click **Enable Kino CDN detection** once to grant optional HTTPS request observation for CDN-hosted HLS playlists. Observation remains restricted in code to HTTPS `.m3u8` requests initiated by an active Kino.pub tab. Manual playlist additions request access only to the pasted URL's origin.

Signed URLs, Cookie, Referer, User-Agent, candidates, and parsed stream descriptors are stored only in `chrome.storage.session` with access restricted to trusted extension contexts. They are never shown in the companion window or written to persistent extension storage. The companion is bound to the exact Kino tab that opened it so focusing the widget cannot retarget media actions to itself or another browser tab.
