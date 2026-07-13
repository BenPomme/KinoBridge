# Packaging and release

The development MVP uses an unpacked extension, a user-scoped Native Messaging manifest, and Homebrew-installed media tools.

Run `pnpm package:macos` for an unsigned Apple-Silicon development app and extension archive. The package embeds the current Node runtime for a self-contained Native Messaging helper; FFmpeg and mpv remain external Homebrew dependencies. Set `KINOBRIDGE_SIGN_IDENTITY` and `KINOBRIDGE_NOTARY_PROFILE` only when release credentials are available in the keychain.

Before distribution:

1. Fix the extension identity and host `allowed_origins`.
2. Decide whether media binaries remain external or are bundled after license review.
3. Wrap the helper in a macOS app/installer and sign every nested executable with Developer ID and Hardened Runtime.
4. Submit with `notarytool`, staple the ticket, and validate with `spctl` and `codesign`.
5. Test clean install, update, uninstall, Chrome host discovery, and sanitized diagnostics on a second account.

Developer ID credentials, notarization profile, and updater signing keys must remain outside the repository.
