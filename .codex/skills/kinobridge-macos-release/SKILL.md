---
name: kinobridge-macos-release
description: Build, sign, notarize, staple, and validate the KinoBridge Apple-Silicon native helper and unpacked Chrome extension. Use for packaging, release diagnostics, clean-install QA, or Native Messaging registration changes.
---

# KinoBridge macOS Release

Use this workflow only after the repository QA and live playback gates pass. Keep signing credentials in the macOS keychain; never write identities, passwords, API keys, or notarization credentials into the repository or logs.

## Workflow

1. Run `pnpm qa` and `pnpm test:e2e`.
2. Run `pnpm package:macos` without credentials to inspect the unsigned Apple-Silicon app and extension archives.
3. Review licenses and package size. KinoBridge bundles Node for the helper but leaves FFmpeg, mpv, and VLC external.
4. Set `KINOBRIDGE_SIGN_IDENTITY` to a Developer ID Application identity and `KINOBRIDGE_NOTARY_PROFILE` to a pre-created `notarytool` keychain profile.
5. Run `pnpm package:macos` again. The script signs the nested Node runtime and app with Hardened Runtime, submits the archive, staples it, and validates with `codesign`, `stapler`, and `spctl`.
6. Test Native Messaging registration and uninstall on a clean macOS user account before release.

## Stop conditions

Stop on an x86_64 runtime, unsigned nested code, a failed notarization, mismatched extension ID, overbroad `allowed_origins`, or secrets in logs. Do not weaken Gatekeeper or macOS security settings to make a build pass.

Read [release-checklist.md](references/release-checklist.md) before a public build.
