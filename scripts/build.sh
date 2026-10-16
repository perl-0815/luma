#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/.build"
APP="$BUILD/Luma.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web" "$BUILD/module-cache"
if [[ ! -x "$APP/Contents/MacOS/Luma" || "$ROOT/native/main.swift" -nt "$APP/Contents/MacOS/Luma" || "$0" -nt "$APP/Contents/MacOS/Luma" ]]; then
  xcrun swiftc "$ROOT/native/main.swift" -o "$APP/Contents/MacOS/Luma" \
    -target "$(uname -m)-apple-macosx12.0" \
    -module-cache-path "$BUILD/module-cache" -framework AppKit -framework WebKit -O
fi
cp "$ROOT"/web/* "$APP/Contents/Resources/web/"
ICON="$APP/Contents/Resources/Luma.icns"
if [[ ! -f "$ICON" || "$ROOT/scripts/render_icon.swift" -nt "$ICON" || "$ROOT/web/mark.svg" -nt "$ICON" ]]; then
  xcrun swift -module-cache-path "$BUILD/module-cache" "$ROOT/scripts/render_icon.swift" "$BUILD/Luma.iconset" >/dev/null
  /usr/bin/iconutil -c icns "$BUILD/Luma.iconset" -o "$ICON"
fi
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Luma</string>
<key>CFBundleDisplayName</key><string>Luma</string>
<key>CFBundleIdentifier</key><string>local.kozyutu.codex-luma</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleExecutable</key><string>Luma</string>
<key>CFBundleIconFile</key><string>Luma.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSSupportsAutomaticTermination</key><false/>
</dict></plist>
PLIST
printf '%s\n' "$APP"
