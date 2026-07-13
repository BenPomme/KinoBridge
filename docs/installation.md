# KinoBridge installation and user guide

This is the complete beginner guide for installing KinoBridge on a Mac and using it for normal playback, language and subtitle selection, offline downloads, and 3D conversion.

## Quick navigation

- [Install KinoBridge](#install-kinobridge)
- [First launch](#5-first-launch)
- [Choose soundtrack and subtitles](#choose-soundtrack-and-subtitles)
- [Choose quality](#choose-quality)
- [Download and watch offline](#download-and-watch-offline)
- [Convert and download a 3D movie](#convert-and-download-a-3d-movie)
- [Update KinoBridge](#update-kinobridge)
- [Uninstall KinoBridge](#uninstall-kinobridge)
- [Troubleshooting](#troubleshooting)

## What KinoBridge does

KinoBridge connects an already-authenticated Kino page in Google Chrome to local media tools on your Mac.

It can:

- detect the authorized HLS stream for the open Kino movie or episode;
- let you choose the exact video quality, soundtrack, and subtitle track;
- play the stream in mpv, with VLC and IINA available as 2D alternatives;
- download an accessible, non-encrypted stream as a validated local MKV;
- play completed downloads without Kino, Chrome, or an internet connection;
- convert supported Half/Full Top/Bottom 3D streams into 3840×1080 Full-SBS for XREAL.

It does **not** store your Kino password, bypass DRM, extract licenses, or download encrypted streams.

> [!IMPORTANT]
> KinoBridge is currently a development MVP, not a signed consumer release. Installation uses an unpacked Chrome extension and a per-user native helper. There is no notarized DMG/PKG, Chrome Web Store release, automatic updater, or self-contained offline installer yet.

## Requirements

- Apple Silicon Mac with macOS 14 or newer
- Google Chrome
- An ordinary authenticated Kino account/session
- Homebrew
- Git and Node.js 20 or newer
- pnpm 10
- FFmpeg/ffprobe and mpv
- Optional: VLC or IINA for 2D playback
- Enough free storage for completed movies; 4K and 3840×1080 SBS files can be large

If Homebrew is not installed, follow the current instructions at [brew.sh](https://brew.sh/). Chrome documents the unpacked-extension workflow in its [official extension tutorial](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).

## Install KinoBridge

### 1. Install the required tools

Open **Terminal** and run:

```sh
brew install git node ffmpeg mpv
npm install --global pnpm@10.28.2
```

Optional 2D fallback players:

```sh
brew install --cask vlc
```

The repository pins pnpm 10.28.2. Installing that version avoids differences between pnpm major versions.

### 2. Download and build KinoBridge

These commands keep the source in `~/KinoBridge`. Do not move or delete that folder while Chrome is using the unpacked extension.

```sh
cd ~
git clone https://github.com/BenPomme/KinoBridge.git
cd KinoBridge
pnpm install --frozen-lockfile
pnpm build
pnpm diagnose
```

`pnpm diagnose` should report `ffmpeg`, `ffprobe`, and `mpv` as available. VLC and IINA may be unavailable if you do not intend to use them.

### 3. Install the native helper

Run this exact command from `~/KinoBridge`:

```sh
pnpm --filter @kinobridge/native-helper install-host -- --extension-id dkbpgionmjfdebegdnooaacggijpaekc
```

This installs the helper only for your macOS user:

- helper: `~/Library/Application Support/KinoBridge/`
- Chrome registration: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kinobridge.helper.json`
- sanitized log: `~/Library/Logs/KinoBridge/helper.log`

Node must remain installed because the development helper launcher records the Node executable used during installation.

### 4. Load the Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `~/KinoBridge/extension/dist`.
   - In the macOS folder picker, press **Command–Shift–G**, paste the path, and press Return.
5. Confirm that Chrome displays this KinoBridge ID:

   ```text
   dkbpgionmjfdebegdnooaacggijpaekc
   ```

6. Open Chrome's Extensions menu and pin KinoBridge to the toolbar.

If the displayed ID is different, rerun the helper command with the ID shown by Chrome, then click **Reload** on the KinoBridge extension card.

### 5. First launch

1. Sign in normally to `kino.pub` or the currently supported `zerkalo.xyz` mirror. KinoBridge never asks for your password.
2. Open a movie or episode page.
3. Click the pinned KinoBridge toolbar icon.
4. On first use, click **Enable Kino CDN detection** and approve Chrome's prompt.
5. Wait for **Stream inspected and ready**.

KinoBridge normally captures the stream automatically. It may briefly start the Kino player muted and perform one cache-bypassing reload. You do not normally need to play five seconds manually.

The KinoBridge companion is a persistent window. It stays open when you click elsewhere. Use **Minimize** or the yellow macOS window button to reduce it; clicking the toolbar icon again restores the same window.

## Normal playback

1. Open the authenticated Kino title and launch KinoBridge from that tab.
2. Wait for **Stream inspected and ready**.
3. Leave the detected master/video entry selected under **Playlist** unless troubleshooting requires another candidate.
4. Choose **Quality**, **Player**, **Soundtrack**, and **Subtitles**.
5. For a normal movie, use **Input 3D: 2D** or **Auto** and **Output: Normal**.
6. Click **Play externally**.

mpv is the reference/default player. VLC and IINA are currently 2D alternatives; they do not perform KinoBridge's live XREAL conversion.

## Choose soundtrack and subtitles

### Soundtrack

Use the **Soundtrack** dropdown to select the exact track shown by Kino whenever possible.

- **Automatic: Original, then English** first looks for a track explicitly named Original, then English.
- An exact dropdown choice overrides the automatic fallback.
- Under **Advanced settings**, `original,en` is the default comma-separated fallback order.
- You can use another order such as `fr,en` or `es,en`.

If an explicitly selected track disappears after a stream refresh, KinoBridge fails the job instead of silently substituting Russian audio or another language.

### Subtitles

Use the **Subtitles** dropdown to select the exact desired subtitle track.

- Automatic selection prefers regular English subtitles.
- **Enable subtitles** turns subtitles on or off.
- **Forced subtitles only** restricts selection to tracks marked forced.
- **Embed subtitles in download** places the selected subtitle inside the MKV.
- The default advanced subtitle fallback is `en`.

Turning off **Embed subtitles in download** currently produces no embedded subtitle and no sidecar subtitle file.

## Choose quality

| Quality | Behavior |
|---|---|
| **Auto** | Uses the highest advertised rendition available to the inspected stream. |
| **4K** | Uses the best rendition at or below 2160p when available. |
| **1080p** | Uses the best rendition at or below 1080p when available. |
| **720p** | Uses the best rendition at or below 720p when available. |

The quality selection never upscales the source. If Kino does not advertise a rendition at or below the selected cap, KinoBridge currently leaves automatic selection in place.

For Full Top/Bottom 3D, use **Auto** or **4K**: the combined stacked frame may be 2160 pixels high even though each eye is 1080p.

## Download and watch offline

Here, “offline” means watching a completed local movie without internet. Installing KinoBridge and downloading dependencies still require internet access.

### Download a normal 2D movie

1. Open the authenticated Kino title and wait for **Stream inspected and ready**.
2. Select the exact **Soundtrack**, **Subtitles**, and **Quality**.
3. Confirm **Output: Normal**.
4. Under **Advanced settings**:
   - **Output folder** defaults to `~/Downloads`. The folder must already exist.
   - **Filename** defaults to the Kino movie title.
   - **Download codec** should be **Original (remux)** for original-quality 2D video without re-encoding.
   - Leave **Embed subtitles in download** enabled if you want the selected subtitle inside the MKV.
5. Click **Download MKV**.
6. Keep Chrome open and keep the matching Kino title tab available until the download completes. KinoBridge may need that tab to refresh expiring access.
7. Wait for the job to reach 100% and pass final validation.

KinoBridge writes a hidden partial file, validates the result, and only then installs the visible MKV. It never overwrites an existing movie; it creates names such as `Movie (2).mkv` when needed.

Multiple jobs are processed one at a time in the order they were added.

### Watch without internet

After completion, the title appears under **Offline library**:

- **Play** opens the validated local file in the selected player.
- **Reveal** selects it in Finder.
- **Delete** asks for confirmation and deletes the registered local file.

Once the MKV is complete, it no longer requires Chrome, Kino, or an internet connection.

### Cancel, retry, and remove

- Use **Cancel active job** or a queue card's **Cancel** button to stop a job and remove its partial files.
- Failed, canceled, or interrupted jobs show **Retry from current Kino tab**.
- For retry, reopen the exact same Kino title, wait for a fresh inspected stream, then click retry.
- V1 retries from the beginning; it does not resume individual HLS segments.
- Retry preserves the original language, subtitle, quality, filename, and conversion settings.
- **Remove** deletes a queue record only. It does not delete a completed library movie.

See [Offline downloads](offline.md) for implementation details and recovery behavior.

## Convert and download a 3D movie

KinoBridge currently converts **Half Top/Bottom** and **Full Top/Bottom** video into **3840×1080 Full Side-by-Side**, suitable for XREAL Air 2 SBS mode.

It does not currently convert Half-SBS, Full-SBS, frame-packed Blu-ray 3D/MVC, anaglyph, VR180/360, or arbitrary local video files. A Full-SBS file may be played as-is with **Output: Normal**, but KinoBridge does not currently normalize or import it.

### Identify the Top/Bottom format

- **Half Top/Bottom**: commonly one 1920×1080 frame containing two vertically compressed eye images.
- **Full Top/Bottom**: commonly one 1920×2160 frame containing two full-resolution 1920×1080 eye images.

A title containing `3D` automatically receives the Half-TB/XREAL preset. If the source is Full-TB—or the title is not labelled 3D—select the correct input manually. **Auto** does not currently distinguish Half-TB from Full-TB.

### Recommended XREAL settings

| Setting | Recommended value |
|---|---|
| Player | mpv |
| Input 3D | Half Top/Bottom or Full Top/Bottom |
| Output | XREAL Full-SBS |
| Eye order | Left first |
| Output width | 3840 |
| Output height | 1080 |
| Aspect correction | 1 |
| Horizontal alignment | 0 |
| Vertical alignment | 0 |
| Zoom | 1 |
| Download codec | H.264 VideoToolbox |
| Output folder | `~/Downloads` |
| Filename | Automatically supplied movie title |

Selecting Half-TB, Full-TB, or XREAL Full-SBS applies the normal XREAL defaults automatically.

### Preview 3D

1. Select the correct Top/Bottom input, **XREAL Full-SBS**, **mpv**, and the desired quality.
2. Select the exact soundtrack and subtitle.
3. Click **Play externally**.
4. When mpv opens, physically enable SBS mode on the XREAL glasses.

Preview before a long download to confirm the source layout and eye order. If depth looks inverted or uncomfortable, change **Eye order** to **Right first**.

Dual-eye subtitle layout is currently verified for downloaded SBS MKVs. Live 3D preview attaches the source subtitle normally, so readable duplicated subtitles in both eyes are not yet guaranteed during live playback.

### Download 3D

1. Select the exact soundtrack and subtitle.
2. Keep **Enable subtitles** and **Embed subtitles in download** enabled.
3. Choose **Half Top/Bottom** or **Full Top/Bottom** and **XREAL Full-SBS**.
4. Use **H.264 VideoToolbox** for the default compatible output. HEVC VideoToolbox is also available. **Original (remux)** cannot perform 3D conversion.
5. Click **Download MKV** and keep Chrome plus the matching Kino tab open.

The job first reports **Analyzing this movie's 3D geometry automatically…**. KinoBridge samples several scenes from that movie, detects only stable packing borders, restores the selected Half/Full-TB aspect ratio, independently centers both eyes, and then transcodes to Full-SBS. No movie-specific calibration or manual five-second playback is used.

Leave alignment and zoom at `0`/`1` unless a preview still shows a real mismatch. If needed, change horizontal or vertical alignment by only a few pixels, preview again, and reverse the sign if the result becomes worse. If geometry is unsafe or inconsistent, KinoBridge stops instead of guessing and cutting the image.

For downloaded 3D MKVs, KinoBridge converts the selected subtitle into two synchronized, centered copies—one within each eye—so text is not split across the SBS seam.

The completed file is already 3840×1080 Full-SBS. Play it from **Offline library**, enable its embedded subtitle track if necessary, and switch the XREAL glasses to SBS mode. No second conversion is required.

## Update KinoBridge

Do not update during an active download.

```sh
cd ~/KinoBridge
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm diagnose
pnpm --filter @kinobridge/native-helper install-host -- --extension-id dkbpgionmjfdebegdnooaacggijpaekc
```

Then open `chrome://extensions` and click **Reload** on KinoBridge. Your completed MKV files are not modified.

## Uninstall KinoBridge

First cancel active downloads. Removing KinoBridge does not automatically delete completed movies in `~/Downloads` or another chosen output folder.

1. Remove KinoBridge from `chrome://extensions`.
2. In Terminal, remove the per-user helper and registration:

   ```sh
   rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kinobridge.helper.json"
   rm -rf "$HOME/Library/Application Support/KinoBridge"
   rm -rf "$HOME/Library/Logs/KinoBridge"
   ```

3. Delete `~/KinoBridge` in Finder if you no longer need the source.

Do not automatically uninstall Homebrew dependencies; other applications may use them.

## Troubleshooting

### Native helper unavailable

From `~/KinoBridge`, run:

```sh
pnpm diagnose
pnpm --filter @kinobridge/native-helper install-host -- --extension-id dkbpgionmjfdebegdnooaacggijpaekc
```

Then reload KinoBridge at `chrome://extensions`. Restart Chrome if it still holds an old helper connection.

### No playlist detected

- Confirm you are authenticated and on the movie/episode page.
- Confirm **Enable Kino CDN detection** was granted.
- Click the Kino page once if Chrome blocks automatic playback, then reopen KinoBridge.
- Reload the Kino title and wait for **Stream inspected and ready**.

### Wrong or missing language/subtitle

Choose an exact displayed rendition instead of relying on fallback text. KinoBridge intentionally fails instead of silently substituting a different language.

### Download interrupted

Open the exact same Kino title, wait for a fresh inspected stream, and click **Retry from current Kino tab**. The job restarts from zero.

### 3D image is stretched or still Top/Bottom

- Confirm **Output: XREAL Full-SBS** and **Player: mpv**.
- A badly stretched image usually means Half-TB versus Full-TB was selected incorrectly.
- If depth is reversed, swap **Eye order**.
- Keep manual alignment at zero unless a small correction is genuinely needed.

### 3D subtitles are split or unreadable

Select the subtitle explicitly, keep subtitle embedding enabled, and create a new download with the current KinoBridge version. Older converted files are not modified automatically. Use a completed download for the verified dual-eye subtitle layout.

### DRM or encryption error

The stream is unsupported by design. KinoBridge does not bypass encryption or acquire DRM keys/licenses.

## Safety and legal boundary

KinoBridge operates only on streams available through the user's ordinary authenticated session. Signed URLs, cookies, and request headers are transient and are not written into the offline library. Use downloads only where the Kino terms and applicable local rules allow them.
