#!/usr/bin/env bash
# Rebuild everything from the raw GeoLife files: about four minutes on a laptop.
set -euo pipefail
cd "$(dirname "$0")"
PY=.venv/bin/python
[ -d "data/raw/Geolife Trajectories 1.3" ] || { echo "Download GeoLife 1.3 into data/raw first (see README)"; exit 1; }
$PY pipeline/ingest.py
(cd transform && ../.venv/bin/dbt build --profiles-dir .)
$PY analysis/modes.py
$PY pipeline/export.py
echo "Done. Preview: python3 -m http.server --directory docs 8123"
