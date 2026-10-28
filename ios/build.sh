#!/usr/bin/env bash
# Builds an unsigned shapez CE .ipa on Linux (or macOS) without Xcode.
# Needs: node/npm/java/ffmpeg for the game, clang + lld (LLVM 15+) for the app, python3 + Pillow for icons.
#   ios/build.sh              full build
#   ios/build.sh --skip-web   reuse the existing build/ folder
# Sign and install the result with Feather, Sideloadly, AltStore, etc.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/ios"
MINOS="16.4"
SDK_VERSION="26.5"
SDK="${IOS_SDK:-$IOS/.sdk/iPhoneOS$SDK_VERSION.sdk}"

if [[ ! -d "$SDK" ]]; then
    echo "==> Fetching iPhoneOS$SDK_VERSION.sdk (headers + .tbd stubs only)"
    rm -rf "$IOS/.sdk"
    git clone -q --depth 1 --filter=blob:none --sparse https://github.com/xybp888/iOS-SDKs.git "$IOS/.sdk"
    git -C "$IOS/.sdk" sparse-checkout set --no-cone "/iPhoneOS$SDK_VERSION.sdk/"
fi

if [[ "${1:-}" != "--skip-web" ]]; then
    echo "==> Building the game"
    (cd "$ROOT" && npx gulp --cwd gulp build.standalone.full)
fi
[[ -f "$ROOT/build/index.html" ]] || { echo "build/ is missing, run without --skip-web"; exit 1; }

VERSION="$(node -p "require('$ROOT/package.json').version")"
BUILD="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || date +%Y%m%d)"
OUT="$ROOT/build_output/ios"
APP="$OUT/Payload/shapez.app"
rm -rf "$OUT" && mkdir -p "$APP"

echo "==> Compiling the app (arm64, iOS $MINOS+, SDK $SDK_VERSION)"
clang -target "arm64-apple-ios$MINOS" -isysroot "$SDK" -iframework "$SDK/System/Library/SubFrameworks" \
    -fobjc-arc -O2 -Wall -Wno-unused-parameter \
    -fuse-ld=lld -Wl,-dead_strip -Wl,-headerpad_max_install_names -Wl,-adhoc_codesign \
    -framework Foundation -framework UIKit -framework WebKit -framework CoreGraphics \
    -framework AVFoundation -framework UniformTypeIdentifiers \
    -o "$APP/shapez" "$IOS/main.m"

echo "==> Assembling shapez.app"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" -e "s/__SDK__/$SDK_VERSION/g" -e "s/__MINOS__/$MINOS/" \
    "$IOS/Info.plist" > "$APP/Info.plist"
printf 'APPL????' > "$APP/PkgInfo"
python3 "$IOS/make_icons.py" "$ROOT/electron/favicon.png" "$APP"
rm "$APP/AppIcon1024.png"
cp -R "$ROOT/build" "$APP/www"
cp "$ROOT/LICENSE" "$APP/LICENSE"

echo "==> Packaging"
IPA="$ROOT/build_output/shapez-ce-$VERSION-ios.ipa"
rm -f "$IPA"
# Media is already compressed, store it as is
(cd "$OUT" && zip -qr -X -9 -n .mp3:.webm:.png:.woff2 "$IPA" Payload)
echo "==> $IPA ($(du -h "$IPA" | cut -f1))"
