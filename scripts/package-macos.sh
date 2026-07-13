#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RELEASE_DIR="$ROOT/release"
APP="$RELEASE_DIR/KinoBridgeHelper.app"
CONTENTS="$APP/Contents"
IDENTITY=${KINOBRIDGE_SIGN_IDENTITY:-}
NOTARY_PROFILE=${KINOBRIDGE_NOTARY_PROFILE:-}

cd "$ROOT"
pnpm qa
pnpm test:e2e
node native-helper/scripts/build-bundle.mjs

rm -rf "$RELEASE_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$RELEASE_DIR/extension"
cp packaging/Info.plist "$CONTENTS/Info.plist"
cp packaging/KinoBridgeHelper "$CONTENTS/MacOS/KinoBridgeHelper"
cp native-helper/dist/native-host.bundle.mjs "$CONTENTS/Resources/native-host.bundle.mjs"
cp "$(node -p 'process.execPath')" "$CONTENTS/Resources/node"
chmod 755 "$CONTENTS/MacOS/KinoBridgeHelper" "$CONTENTS/Resources/node"
cp -R extension/dist/. "$RELEASE_DIR/extension/"

file "$CONTENTS/Resources/node" | grep -q 'arm64' || { echo "Bundled Node runtime is not Apple Silicon" >&2; exit 1; }
ditto -c -k --sequesterRsrc --keepParent "$RELEASE_DIR/extension" "$RELEASE_DIR/KinoBridge-extension.zip"

if [ -z "$IDENTITY" ]; then
  echo "Created unsigned development package at $APP"
  echo "Set KINOBRIDGE_SIGN_IDENTITY and KINOBRIDGE_NOTARY_PROFILE for release signing."
  exit 0
fi

codesign --force --timestamp --options runtime --entitlements packaging/entitlements.plist --sign "$IDENTITY" "$CONTENTS/Resources/node"
codesign --force --deep --timestamp --options runtime --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

ditto -c -k --sequesterRsrc --keepParent "$APP" "$RELEASE_DIR/KinoBridgeHelper-notarization.zip"
if [ -z "$NOTARY_PROFILE" ]; then
  echo "Signed package created; set KINOBRIDGE_NOTARY_PROFILE to submit it." >&2
  exit 2
fi

xcrun notarytool submit "$RELEASE_DIR/KinoBridgeHelper-notarization.zip" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$RELEASE_DIR/KinoBridgeHelper.zip"
echo "Signed and notarized package created at $RELEASE_DIR/KinoBridgeHelper.zip"
