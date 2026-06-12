#!/bin/sh
# Listam appling shell — boots the Listam Pear app via the Pear runtime.
# Template: installer/build-macos.sh bakes __PEAR_LINK__ at build time and
# installs this as Listam.app/Contents/MacOS/Listam.
LINK="__PEAR_LINK__"

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BUNDLE="$(dirname "$(dirname "$SELF_DIR")")"

PEAR=""
for candidate in \
  "$HOME/Library/Application Support/pear/bin/pear" \
  /usr/local/bin/pear \
  "$(command -v pear 2>/dev/null || true)"
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    PEAR="$candidate"
    break
  fi
done

if [ -z "$PEAR" ]; then
  /usr/bin/osascript >/dev/null <<'OSA' || true
set answer to button returned of (display dialog "Listam runs on the Pear runtime, which is not installed yet.

Install Pear from pears.com, then open Listam again." buttons {"Cancel", "Open pears.com"} default button "Open pears.com" with title "Listam" with icon caution)
if answer is "Open pears.com" then do shell script "open https://pears.com"
OSA
  exit 1
fi

START="$(date +%s)"
"$PEAR" run --appling "$BUNDLE" "$LINK" "$@"
RC=$?

# A fast nonzero exit is a launch failure (most likely the one-time trust
# approval Pear requires for a key it has not seen), not a session crash.
if [ "$RC" -ne 0 ] && [ "$(($(date +%s) - START))" -lt 20 ]; then
  /usr/bin/osascript >/dev/null <<OSA || true
display dialog "Listam could not start (Pear runtime exit $RC).

If this is the first run on this machine, approve the app once from Terminal:

pear run $LINK

then open Listam again." buttons {"OK"} default button "OK" with title "Listam" with icon caution
OSA
fi
exit "$RC"
