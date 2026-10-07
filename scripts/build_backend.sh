#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
PYINSTALLER_CONFIG_DIR="$PWD/.cache/pyinstaller" .venv/bin/pyinstaller --noconfirm --clean --name quotecompare-backend --onedir \
  --distpath artifacts --workpath .pyinstaller/build --specpath .pyinstaller \
  --paths . --add-data "$PWD/docs/technical/QuoteCompare-openapi-v2.json:docs/technical" \
  --add-data "$PWD/docs/technical/database-schema-v2.sql:docs/technical" \
  --collect-all pypdfium2 --collect-all reportlab \
  --hidden-import keyring.backends.macOS --hidden-import Vision --hidden-import Quartz \
  backend/main.py
