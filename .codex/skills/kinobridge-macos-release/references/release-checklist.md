# Release checklist

- Pin extension identity and verify the derived ID against the Native Messaging manifest.
- Verify the app and nested Node binary are arm64 and signed by the intended Developer ID.
- Inspect `codesign -dvvv`, `spctl --assess`, and `stapler validate` output.
- Confirm the host manifest is per-user, mode 0600, absolute-path, and restricted to one `allowed_origins` value.
- Confirm diagnostics redact signed queries, cookies, tokens, and authorization values.
- Audit Node, npm dependencies, and Homebrew dependency licenses and update sizes.
- Test install, upgrade, rollback, and uninstall from a clean macOS user account.
