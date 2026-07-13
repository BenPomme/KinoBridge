# Development installation

## Requirements

- Apple Silicon Mac running macOS 14 or newer
- Node.js 20+, pnpm 10+, Homebrew, and Google Chrome
- VLC for fallback testing
- FFmpeg/ffprobe and mpv for the reference pipeline

```sh
brew install ffmpeg mpv
pnpm install
pnpm qa
pnpm build
```

Run the native-host installer printed by `pnpm --filter @kinobridge/native-helper install-host -- --extension-id <id>`. The installer bundles the helper into `~/Library/Application Support/KinoBridge/` (Chrome's sandbox cannot launch it from Documents), then writes the user-scoped manifest below `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` with the installed helper's absolute path and the exact extension origin.

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extension/dist`. Installing an unpacked extension is a user-confirmed UI action. Copy the displayed extension ID into the native-host installer, rebuild/reinstall the host if it changes, and reload Chrome.

Pin KinoBridge from Chrome's Extensions menu. Click its toolbar icon while viewing a Kino title to open the persistent companion window. The same window remains open across focus changes and is restored—rather than duplicated—when the toolbar icon is clicked again.

Run `pnpm diagnose` whenever Chrome reports that the native host is missing.

For a packaged helper, register its app executable instead of the development launcher:

```sh
pnpm --filter @kinobridge/native-helper install-host -- --extension-id <id> --host-path /Applications/KinoBridgeHelper.app/Contents/MacOS/KinoBridgeHelper
```
