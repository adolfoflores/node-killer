#!/bin/sh
# Build Node Killer from this checkout and install it in /Applications.
# A local build is not quarantined, so macOS opens it without the Gatekeeper prompt
# that downloaded copies get.
set -e

APP_NAME="Node-Killer"
BUILT_APP="dist/mac-arm64/$APP_NAME.app"
TARGET="/Applications/$APP_NAME.app"

# Only the .app bundle (no .dmg/.zip); signing is skipped and the afterPack hook signs it ad-hoc
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir

# Quit the running copy before replacing it
if pgrep -x "$APP_NAME" >/dev/null; then
  pkill -x "$APP_NAME"
  while pgrep -x "$APP_NAME" >/dev/null; do sleep 0.2; done
fi

rm -rf "$TARGET"
ditto "$BUILT_APP" "$TARGET"
open "$TARGET"
echo "Installed $TARGET"
