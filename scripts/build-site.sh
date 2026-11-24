#!/usr/bin/env bash
# Builds the GitHub Pages site: main branch at the root, dev branch at /dev/.
# Usage: scripts/build-site.sh <main-checkout> <dev-checkout> <out-dir>
set -euo pipefail
MAIN="$1"; DEV="$2"; OUT="$3"
rm -rf "$OUT"; mkdir -p "$OUT"
copy() { (cd "$1" && tar --exclude=.git --exclude=.github --exclude=scripts --exclude=tests -cf - .) | (cd "$2" && tar -xf -); }
copy "$MAIN" "$OUT"
rm -rf "$OUT/dev"   # never let a folder named dev in main shadow the dev copy
mkdir -p "$OUT/dev"
copy "$DEV" "$OUT/dev"
# Dev copy gets its own name and icons so it's easy to tell apart on the home screen.
mv "$OUT/dev/manifest.dev.json" "$OUT/dev/manifest.json"
cp "$OUT/dev/icons/dev/"*.png "$OUT/dev/icons/"
sed -i 's|<meta name="apple-mobile-web-app-title" content="Lift Log">|<meta name="apple-mobile-web-app-title" content="Lift DEV">|; s|<title>Lift Log</title>|<title>Lift Log DEV</title>|' "$OUT/dev/index.html"
grep -q 'content="Lift DEV"' "$OUT/dev/index.html"
touch "$OUT/.nojekyll"
echo "Built $OUT (live from $MAIN, dev from $DEV)"
