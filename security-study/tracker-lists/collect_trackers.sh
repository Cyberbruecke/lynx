#!/usr/bin/env bash
# Download raw tracker/ad blocklists into raw/, then normalize to the common eTLD+1
# schema. Re-running is idempotent (downloads refresh, normalize re-parses).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw

echo "[*] DuckDuckGo Tracker Radar (shallow clone; structured per-domain JSON + owner/category)..."
if [ -d raw/tracker-radar/.git ]; then
  git -C raw/tracker-radar pull -q --depth 1 || true
else
  git clone --depth 1 https://github.com/duckduckgo/tracker-radar.git raw/tracker-radar
fi

echo "[*] Ghostery TrackerDB (latest release trackerdb.json; domain->org/category)..."
GH_URL=$(curl -sL https://api.github.com/repos/ghostery/trackerdb/releases/latest \
  | python3 -c "import json,sys;print(next(a['browser_download_url'] for a in json.load(sys.stdin)['assets'] if a['name']=='trackerdb.json'))")
curl -fSL "$GH_URL" -o raw/ghostery-trackerdb.json

echo "[*] Classic filter lists (Adblock syntax)..."
curl -fSL "https://easylist.to/easylist/easyprivacy.txt" -o raw/easyprivacy.txt
curl -fSL "https://easylist.to/easylist/easylist.txt"    -o raw/easylist.txt
curl -fSL "https://filters.adtidy.org/extension/chromium/filters/3.txt" -o raw/adguard-tracking.txt || \
  echo "    (AdGuard tracking list failed — optional, skipping)"
curl -fSL "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext" \
  -o raw/pgl-yoyo.txt || echo "    (Peter Lowe list failed — optional, skipping)"

echo "[*] Raw sources in raw/. Normalizing to eTLD+1 ..."
python3 "$(dirname "$0")/normalize.py"
