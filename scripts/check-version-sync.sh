#!/usr/bin/env bash

set -euo pipefail

PKG_VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
CARGO_VERSION=$(grep '^version' src-tauri/Cargo.toml | head -1 | sed 's/.*"\(.*\)"/\1/')
TAURI_VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")

echo "package.json:       $PKG_VERSION"
echo "Cargo.toml:         $CARGO_VERSION"
echo "tauri.conf.json:    $TAURI_VERSION"

if [ "$PKG_VERSION" != "$CARGO_VERSION" ] || [ "$PKG_VERSION" != "$TAURI_VERSION" ]; then
  echo ""
  echo "ERROR: Version mismatch detected!"
  exit 1
fi

echo ""
echo "All versions match: $PKG_VERSION"
