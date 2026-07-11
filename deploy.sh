#!/usr/bin/env bash
# Build for GitHub Pages (served at /spagpRacer/) and push the built site to the
# gh-pages branch. Run: npm run deploy
set -euo pipefail

REPO="git@github.com:N1tr029/spagpRacer.git"
BASE="/spagpRacer/"

npm run build -- --base="$BASE"
touch dist/.nojekyll

TMP="$(mktemp -d)"
cp -R dist/. "$TMP/"
git -C "$TMP" init -q
git -C "$TMP" add -A
git -C "$TMP" -c user.name="N1tr029" -c user.email="214513847+N1tr029@users.noreply.github.com" \
  commit -qm "Deploy $(git rev-parse --short HEAD 2>/dev/null || echo build)"
git -C "$TMP" push -f "$REPO" HEAD:gh-pages
rm -rf "$TMP"

echo "Deployed → https://n1tr029.github.io/spagpRacer/"
