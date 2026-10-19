#!/usr/bin/env bash
# Build LyN-X into a single standalone Linux executable (bundles Node runtime + acorn).
# Uses Bun's --compile. Output: ./lynx  (no Node install needed to run it).
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required to build the standalone binary."
  echo "Install it (user-local, no root):"
  echo "  curl -fsSL https://bun.sh/install | bash   &&   source ~/.bashrc"
  exit 1
fi

# ensure acorn is available for bundling
[ -d node_modules/acorn ] || bun install

echo "[*] building standalone ./lynx (linux-x64) ..."
bun build ./lyn-x.js --compile --minify --target=bun-linux-x64 --outfile lynx

chmod +x lynx
echo "[*] done -> $(pwd)/lynx"
echo "    try:  ./lynx tests/test.js --raw"
echo "          ./lynx page.html --recurse"
echo "          ./lynx https://example.com/app.js"
