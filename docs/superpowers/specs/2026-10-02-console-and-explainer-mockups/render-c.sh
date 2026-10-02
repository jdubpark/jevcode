#!/usr/bin/env bash
# Renders the S-0 (phase C, gate H3) mockups to PNG with headless Chrome. Usage: bash render-c.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT
shot() { # <png> <url> <width> [height]
  rm -f "$1"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" --window-size="$3,${4:-948}" --virtual-time-budget=2000 --screenshot="$1" "$2" >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 120); do
    [ -s "$1" ] && break
    sleep 0.5
  done
  sleep 1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  test -s "$1" || { echo "no screenshot: $1" >&2; exit 1; }
}
for name in c-brief-story c-console-summary c-decision-inspector c-map-overlay; do
  for width in 1440 1000; do
    shot "$DIR/$name-$width.png" "file://$DIR/$name.html" "$width"
  done
done
echo "RENDER_OK $(ls "$DIR"/c-*.png | wc -l | tr -d ' ') png"
