#!/usr/bin/env bash
# Unpack the shipped archives into the layout the analysis scripts expect.
# Needs: zstd, tar. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"
command -v zstd >/dev/null || { echo "zstd is required (apt-get install zstd)"; exit 1; }

mkdir -p crawler/out/tools results security-study/tracker-lists sdk-study/out/sdk

echo "[*] crawl ground truth + index"
zstd -dc data/ground-truth.tar.zst | tar -x -C crawler/out
zstd -dc data/js-index.csv.zst  > crawler/out/js-index.csv
zstd -dc data/crawl-log.csv.zst > crawler/out/crawl-log.csv

echo "[*] cached per-tool outputs (132,646 scripts x 4 tools)"
for t in lynx linkfinder jsluice relwarc; do
  zstd -dc "data/tools-$t.tar.zst" | tar -x -C crawler/out/tools
done

echo "[*] derived result tables"
zstd -dc data/probes.tar.zst   | tar -x -C results
zstd -dc data/perf.tar.zst     | tar -x -C results
zstd -dc data/coverage.tar.zst | tar -x -C results

echo "[*] tracker blocklists (normalized)"
zstd -dc data/tracker-lists-normalized.tar.zst | tar -x -C security-study/tracker-lists

echo "[*] SDK specs + version pins"
zstd -dc data/sdk-specs.tar.zst | tar -x -C sdk-study/out/sdk

cat <<'EOF'

Done. What you now have:
  crawler/out/ground-truth/   dynamic crawl ground truth, one .jsonl per domain
  crawler/out/tools/<tool>/   cached per-script tool output (no tool re-run needed)
  crawler/out/js-index.csv    URL -> content hash
  results/                    probe, perf and coverage tables
  sdk-study/out/sdk/          per-SDK OpenAPI spec + pinned package.json

NOT shipped: crawler/out/js/ (the 132,646-script corpus, ~9 GB).
Analyses that only need to know WHICH scripts were in the corpus fall back automatically.
Analyses that need the script bodies will say so and exit; see README "Re-running data collection".
EOF
