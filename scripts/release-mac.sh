#!/bin/sh
# Builds the Mac release (DMG, zip, SHA256SUMS) on this Mac, with Pro bundled. pro/ is local only,
# so releases can't be built in CI: a build without it would ship without Pro.
set -eu
cd "$(dirname "$0")/.."
[ -f pro/main/pro.mjs ] || { echo "pro/ is missing: the build would ship without Pro" >&2; exit 1; }

npm test
(cd pro && npm test)

# keywatch for both chip types: the app is universal, and Macs without Xcode can't build it.
swiftc -O -target arm64-apple-macos12 pro/native/keywatch.swift -o /tmp/keywatch-arm64
swiftc -O -target x86_64-apple-macos12 pro/native/keywatch.swift -o /tmp/keywatch-x64
lipo -create /tmp/keywatch-arm64 /tmp/keywatch-x64 -output pro/native/bin/keywatch

cd app
rm -rf dist
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --universal --publish never

APP=dist/mac-universal/Earpiece.app
for f in main/pro.mjs node_modules/node-pty/package.json node_modules/@xterm/xterm/lib/xterm.js; do
  [ -f "$APP/Contents/Resources/pro/$f" ] || { echo "Pro is incomplete in the built app: $f is missing" >&2; exit 1; }
done
lipo "$APP/Contents/Resources/pro/native/bin/keywatch" -verify_arch arm64 x86_64
codesign --verify --deep --strict --verbose=2 "$APP"
(cd dist && shasum -a 256 *.dmg *.zip | tee SHA256SUMS)

V=$(node -p "require('./package.json').version")
echo
echo "Built $V. To publish:"
echo "gh release create app-v$V app/dist/*.dmg app/dist/*.zip app/dist/SHA256SUMS --title \"Earpiece $V\" --latest"
