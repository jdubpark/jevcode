#!/usr/bin/env bash
# Renders the P-0 mockups (gate H2) to PNG with headless Chrome. Usage: bash render-p0.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT
# Chrome writes the PNG within seconds but can linger afterwards (its updater), so wait for the file, then stop it.
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
for width in 1440 1000; do
  for state in default zoomed selected pending; do
    name="map"
    [ "$state" = default ] || name="map-$state"
    shot "$DIR/$name-$width.png" "file://$DIR/map.html?state=$state" "$width"
  done
  shot "$DIR/brief-architecture-$width.png" "file://$DIR/brief-architecture.html" "$width" 1900
done
echo "RENDER_OK $(ls "$DIR"/map*-1440.png "$DIR"/map*-1000.png "$DIR"/brief-architecture-*.png | wc -l | tr -d ' ') png"
