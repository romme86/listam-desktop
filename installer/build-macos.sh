#!/usr/bin/env bash
# Build a macOS installer for listam-desktop.
#
# Stages the app to a Pear channel, builds a Listam.app appling shell that
# boots it with `pear run --appling`, ad-hoc signs the bundle, and wraps it
# in a drag-install DMG. See installer/README.md for the distribution model.
#
# Usage: installer/build-macos.sh [--channel <name>] [--release] [--skip-stage]
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER_DIR="$APP_DIR/installer"
DIST="$INSTALLER_DIR/dist"
BUILD="$DIST/build"

CHANNEL=production
RELEASE=0
SKIP_STAGE=0
NATIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --release) RELEASE=1; shift ;;
    --skip-stage) SKIP_STAGE=1; shift ;;
    --native) NATIVE=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

# --ignore REPLACES Pear's default ignore list, so the defaults (.git etc.)
# must be restated here. Keep in sync with pear.stage.ignore in package.json.
STAGE_IGNORE="/.git,/.github,/.gitignore,/.DS_Store,/test,/design-guide,/installer,/listam-desktop-secrets.json"

PEAR=""
for candidate in "$HOME/Library/Application Support/pear/bin/pear" /usr/local/bin/pear; do
  [ -x "$candidate" ] && PEAR="$candidate" && break
done
[ -n "$PEAR" ] || PEAR="$(command -v pear || true)"
[ -n "$PEAR" ] || { echo "error: pear runtime not found — install from https://pears.com" >&2; exit 1; }

[ -d "$APP_DIR/node_modules" ] || { echo "error: $APP_DIR/node_modules missing — run npm install in listam-desktop first" >&2; exit 1; }

VERSION="$(node -p "require('$APP_DIR/package.json').version")"
mkdir -p "$BUILD"

# -- stage the app drive ------------------------------------------------------
STAGE_LOG="$DIST/stage-$CHANNEL.jsonl"
if [ "$SKIP_STAGE" -eq 1 ]; then
  echo "== skipping stage, reading link from a dry-run"
  "$PEAR" stage "$CHANNEL" "$APP_DIR" --json --no-ask --dry-run --ignore "$STAGE_IGNORE" > "$STAGE_LOG"
else
  echo "== staging $APP_DIR -> channel '$CHANNEL'"
  "$PEAR" stage "$CHANNEL" "$APP_DIR" --json --no-ask --ignore "$STAGE_IGNORE" > "$STAGE_LOG"
fi
LINK="$(grep -oE 'pear://[a-z0-9]{40,}' "$STAGE_LOG" | head -1)"
[ -n "$LINK" ] || { echo "error: could not parse pear:// link from $STAGE_LOG" >&2; exit 1; }
echo "   link: $LINK"

if [ "$RELEASE" -eq 1 ]; then
  echo "== marking release on '$CHANNEL'"
  "$PEAR" release "$CHANNEL" "$APP_DIR" --json >> "$STAGE_LOG"
fi

# -- app icon -----------------------------------------------------------------
ICNS="$APP_DIR/assets/listam.icns"
if [ ! -f "$ICNS" ] || [ "$APP_DIR/assets/icon.png" -nt "$ICNS" ]; then
  echo "== generating $ICNS"
  MASTER="$BUILD/icon-master.png"
  ICONSET="$BUILD/listam.iconset"
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  swift "$INSTALLER_DIR/make-icns.swift" "$APP_DIR/assets/icon.png" "$MASTER"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$MASTER" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z "$((s * 2))" "$((s * 2))" "$MASTER" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$ICNS"
fi

# -- appling shell bundle -------------------------------------------------------
APP_BUNDLE="$BUILD/Listam.app"
rm -rf "$APP_BUNDLE"
if [ "$NATIVE" -eq 1 ]; then
  # Native shell built from installer/appling (cmake-pear / libappling). It is
  # already signed with its entitlements by the cmake build — do not re-sign.
  NATIVE_BUNDLE="$INSTALLER_DIR/appling/build/Listam.app"
  [ -d "$NATIVE_BUNDLE" ] || {
    echo "error: $NATIVE_BUNDLE not built — see installer/README.md (native shell)" >&2
    exit 1
  }
  # no grep -q: with pipefail it would SIGPIPE strings and fail the pipeline
  strings "$NATIVE_BUNDLE/Contents/MacOS/Listam" 2>/dev/null | grep -x "${LINK#pear://}" >/dev/null || {
    echo "error: native appling does not embed the '$CHANNEL' key (${LINK#pear://})" >&2
    echo "       rebuild it with -DLISTAM_ID=<key> — see installer/README.md" >&2
    exit 1
  }
  echo "== using native appling $NATIVE_BUNDLE"
  cp -R "$NATIVE_BUNDLE" "$APP_BUNDLE"
else
  echo "== assembling $APP_BUNDLE (script shell)"
  mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
  cp "$ICNS" "$APP_BUNDLE/Contents/Resources/listam.icns"
  sed "s|__PEAR_LINK__|$LINK|" "$INSTALLER_DIR/launcher.sh" > "$APP_BUNDLE/Contents/MacOS/Listam"
  chmod +x "$APP_BUNDLE/Contents/MacOS/Listam"

  cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>             <string>Listam</string>
  <key>CFBundleDisplayName</key>      <string>Listam</string>
  <key>CFBundleIdentifier</key>       <string>ch.saynode.listam.desktop</string>
  <key>CFBundleExecutable</key>       <string>Listam</string>
  <key>CFBundleIconFile</key>         <string>listam</string>
  <key>CFBundlePackageType</key>      <string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key>          <string>$VERSION</string>
  <key>LSMinimumSystemVersion</key>   <string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key>  <true/>
</dict>
</plist>
PLIST

  if command -v codesign >/dev/null; then
    codesign --force --deep --sign - "$APP_BUNDLE" 2>/dev/null \
      || echo "warn: ad-hoc codesign failed (bundle left unsigned)"
  fi
fi

# -- DMG ------------------------------------------------------------------------
DMG="$DIST/Listam-$VERSION-$CHANNEL.dmg"
echo "== building $DMG"
DMG_ROOT="$BUILD/dmg-root"
rm -rf "$DMG_ROOT" && mkdir -p "$DMG_ROOT"
cp -R "$APP_BUNDLE" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"
rm -f "$DMG"
hdiutil create -volname "Listam" -srcfolder "$DMG_ROOT" -ov -format UDZO "$DMG" >/dev/null

echo
echo "done."
echo "  installer : $DMG ($(du -h "$DMG" | cut -f1 | tr -d ' '))"
echo "  app link  : $LINK"
echo "  channel   : $CHANNEL ($([ "$RELEASE" -eq 1 ] && echo 'release marked' || echo 'staged only — pass --release to mark'))"
echo
echo "Installs fetch the app over the swarm: keep a seeder running, e.g."
echo "  pear seed $CHANNEL \"$APP_DIR\""
