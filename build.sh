#!/usr/bin/env bash
# Builds both distributable formats for OwlPods.
#   dist/owlpods-N.zip       — manual install: archive contains the folder
#                              owlpods@leonidperkin/ (unzip straight into
#                              ~/.local/share/gnome-shell/extensions/)
#   dist/owlpods-ego-N.zip   — extensions.gnome.org upload: metadata.json
#                              must sit at the ARCHIVE ROOT (no folder
#                              wrapper) or the site rejects the bundle.
# Requirements: glib-compile-schemas, python3 (zip CLI is not required).
set -euo pipefail
cd "$(dirname "$0")"

UUID="owlpods@leonidperkin"
VERSION=$(python3 -c "import json; print(json.load(open('metadata.json'))['version'])")
STAGE="dist/stage/$UUID"

rm -rf dist
mkdir -p "$STAGE"
cp -r extension.js prefs.js metadata.json stylesheet.css src schemas assets "$STAGE/"
glib-compile-schemas "$STAGE/schemas/"

archive() {
    python3 - "$1" "$2" <<'PY'
import zipfile, os, sys
src_root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirs, files in os.walk(src_root):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(dirpath, f)
            zf.write(full, os.path.relpath(full, src_root))
print("built", out)
PY
}

# 1) Manual install format: folder named after the uuid at archive root.
archive "dist/stage" "dist/owlpods-v${VERSION}.zip"

# 2) EGO format: metadata.json at the archive root, same file set.
archive "$STAGE" "dist/owlpods-ego-v${VERSION}.zip"

rm -rf dist/stage
echo "=== dist/owlpods-v${VERSION}.zip (manual install)"
echo "=== dist/owlpods-ego-v${VERSION}.zip (EGO upload)"
