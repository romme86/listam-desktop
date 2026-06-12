#!/usr/bin/env bash
# Manage the persistent background seeder for the listam-desktop drive.
# Installs hold the DMG payload: installs fetch the app over the swarm, so at
# least one seeder must be reachable. This registers a LaunchAgent that seeds
# the production channel from this checkout at login and keeps it alive.
#
# Usage: installer/seed-agent.sh [install|uninstall|status]
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=ch.saynode.listam.seed
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PEAR="$HOME/Library/Application Support/pear/bin/pear"
LOG="$HOME/Library/Logs/listam-seed.log"

case "${1:-install}" in
  install)
    [ -x "$PEAR" ] || { echo "error: pear runtime not found at $PEAR" >&2; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PEAR</string>
    <string>seed</string>
    <string>production</string>
    <string>$APP_DIR</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>StandardOutPath</key>  <string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "seeder installed: $LABEL (runs at login, kept alive)"
    echo "log: $LOG"
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "seeder removed"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "not loaded"
    tail -5 "$LOG" 2>/dev/null || true
    ;;
  *)
    echo "usage: $0 [install|uninstall|status]" >&2
    exit 1
    ;;
esac
