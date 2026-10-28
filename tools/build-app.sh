#!/bin/sh
# Builds the FLOORBALL IQ app (Expo, ~/Developer/floorball-iq) as static web files into app/.
# The site lives at https://<user>.github.io/floorball-iq/, so the app is served under /floorball-iq/app.
set -e
SITE="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP_DIR:-$HOME/Developer/floorball-iq}"
cd "$APP"
rm -rf "$SITE/app"
EXPO_SITE_BASE=/floorball-iq/app npx expo export --platform web --output-dir "$SITE/app" --clear
# Single-page app: GitHub Pages answers unknown paths with 404.html, so a reload
# on /floorball-iq/app/progress still opens the app (the router reads the URL).
cp "$SITE/app/index.html" "$SITE/404.html"
# GitHub Pages: no Jekyll processing (it would hide the _expo folder).
touch "$SITE/.nojekyll"
echo "App built into $SITE/app from commit $(git rev-parse --short HEAD)$(git diff --quiet || echo ' (+ uncommitted changes)')"
