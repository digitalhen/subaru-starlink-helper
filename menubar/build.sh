#!/bin/bash
# Build "Subaru Bar.app" — a local, ad-hoc-signed menu bar app.
#
# No Sparkle, no notarization: this is built for the machine it runs on. The
# app is self-contained Swift with no bundled runtime, because the MySubaru
# API is plain form POSTs that URLSession handles natively.
set -e
cd "$(dirname "$0")"

APP="Subaru Bar.app"
rm -rf "$APP" build
mkdir -p build "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "generating app icon…"
swiftc -O -o build/makeicon makeicon.swift -framework AppKit
./build/makeicon build/icon1024.png
ICONSET=build/AppIcon.iconset
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) build/icon1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o build/AppIcon.icns

echo "compiling…"
swiftc -O -o build/SubaruBar SubaruBar.swift \
  -framework AppKit -framework SwiftUI -framework UserNotifications -framework Security

cp build/SubaruBar "$APP/Contents/MacOS/SubaruBar"
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Subaru Bar</string>
	<key>CFBundleDisplayName</key><string>Subaru Bar</string>
	<key>CFBundleExecutable</key><string>SubaruBar</string>
	<key>CFBundleIdentifier</key><string>com.digitalhen.subarubar</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundleIconName</key><string>AppIcon</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<!-- menu bar only, no Dock icon -->
	<key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${APP_VERSION:-1.0}" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${APP_BUILD:-1}" "$APP/Contents/Info.plist"

# Ad-hoc signature. Enough for local use and for the Keychain to bind the item
# to a stable identity; a Developer ID would be needed to distribute this.
codesign --force --deep -s - "$APP"

echo "built: $(pwd)/$APP"
