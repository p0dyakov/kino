#!/bin/bash
# Rebuild Kinostream.app: engine binary + exported UI + icon + Info.plist
# Usage: scripts/bundle.sh   (run from repo root; builds app/out and engine first if missing)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/Kinostream.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/ui"

# launcher
cat > "$APP/Contents/MacOS/Kinostream" <<'EOF'
#!/bin/bash
cd "$(dirname "$0")/../Resources"
exec ../MacOS/ksengine --app --ui "$PWD/ui"
EOF
chmod +x "$APP/Contents/MacOS/Kinostream"

cp "$ROOT/engine/build/ksengine" "$APP/Contents/MacOS/ksengine"
cp -R "$ROOT/app/out/." "$APP/Contents/Resources/ui/"
cp "$ROOT/scripts/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
[ -f "$ROOT/engine/xray-torrent.json" ] && cp "$ROOT/engine/xray-torrent.json" "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Kinostream</string>
  <key>CFBundleIdentifier</key><string>dev.kinostream.app</string>
  <key>CFBundleName</key><string>Kinostream</string>
  <key>CFBundleDisplayName</key><string>Kinostream</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIconName</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

codesign -f -s - "$APP" >/dev/null 2>&1
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1
echo "Built $APP"
