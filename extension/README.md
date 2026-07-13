# KinoBridge Chrome extension

Build with `pnpm --filter @kinobridge/extension build`, then load `extension/dist` from `chrome://extensions` in Developer mode.

The manifest's public key fixes the development extension ID to `dkbpgionmjfdebegdnooaacggijpaekc`. The native host must allow exactly `chrome-extension://dkbpgionmjfdebegdnooaacggijpaekc/`.

KinoBridge initially has host access only to `kino.pub` and its subdomains. Click **Enable Kino CDN detection** once to grant optional HTTPS request observation for CDN-hosted HLS playlists. Observation remains restricted in code to HTTPS `.m3u8` requests initiated by an active Kino.pub tab. Manual playlist additions request access only to the pasted URL's origin.

Signed URLs, Cookie, Referer, User-Agent, candidates, and parsed stream descriptors are stored only in `chrome.storage.session` with access restricted to trusted extension contexts. They are never shown in the popup or written to persistent extension storage.
