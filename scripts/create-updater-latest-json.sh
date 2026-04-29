#!/usr/bin/env bash

set -euo pipefail

VERSION="${1:?usage: create-updater-latest-json.sh <version> <release-tag>}"
RELEASE_TAG="${2:?usage: create-updater-latest-json.sh <version> <release-tag>}"
REPOSITORY="${GITHUB_REPOSITORY:-SerTimBerrners-Lee/talkis}"
BUILD_ROOT="${BUILD_ROOT:-src-tauri/target/release/bundle}"
MACOS_BUNDLE_DIR="${BUILD_ROOT}/macos"
LATEST_JSON_PATH="${BUILD_ROOT}/latest.json"

UPDATER_ARCHIVE="$(find "${MACOS_BUNDLE_DIR}" -maxdepth 1 -type f -name "*.app.tar.gz" | head -n 1)"

if [[ -z "${UPDATER_ARCHIVE}" ]]; then
  echo "Updater archive not found in ${MACOS_BUNDLE_DIR}" >&2
  exit 1
fi

SIGNATURE_PATH="${UPDATER_ARCHIVE}.sig"

if [[ ! -f "${SIGNATURE_PATH}" ]]; then
  echo "Updater signature not found at ${SIGNATURE_PATH}" >&2
  exit 1
fi

UPDATER_FILE="$(basename "${UPDATER_ARCHIVE}")"
SIGNATURE="$(tr -d '\n' < "${SIGNATURE_PATH}")"
URL="https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/${UPDATER_FILE}"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

python3 - "$LATEST_JSON_PATH" "$VERSION" "$PUB_DATE" "$SIGNATURE" "$URL" <<'PY'
import json
import sys

path, version, pub_date, signature, url = sys.argv[1:]
payload = {
    "version": version,
    "pub_date": pub_date,
    "platforms": {
        "darwin-aarch64": {
            "signature": signature,
            "url": url,
        },
    },
}

with open(path, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

echo "Created updater metadata at ${LATEST_JSON_PATH}"
