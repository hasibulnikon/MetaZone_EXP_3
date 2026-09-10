#!/bin/bash
# Stage 8: builds a standalone onefile Linux binary. Verified in this
# project's sandbox (see CHANGELOG.md's Stage 8 entry) -- real build,
# real launch, real screenshot of working UI, run standalone from a
# directory with no source tree present.
#
# Requires (Linux): python3-gi, gir1.2-webkit2-4.1, gir1.2-gtk-3.0
# already installed system-wide (same runtime deps as running from
# source -- PyInstaller bundles Python + pure-Python deps, but GTK/
# WebKitGTK themselves are expected on the target system, not bundled).
set -e
cd "$(dirname "$0")/.."

pip install --break-system-packages -r requirements.txt
pip install --break-system-packages pyinstaller

rm -rf build dist MetaZone.spec

python3 -m PyInstaller --onefile --name MetaZone \
  --add-data "frontend:frontend" \
  --add-data "backend:backend" \
  --collect-all Pillow \
  app.py

echo ""
echo "Built: dist/MetaZone"
echo "Place a real 'exiftool' binary next to dist/MetaZone for the"
echo "Meta Embedder to work (find_exiftool() looks there -- same"
echo "resolution rule as the original app, see core/utils.py)."
