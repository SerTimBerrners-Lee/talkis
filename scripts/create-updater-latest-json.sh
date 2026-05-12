#!/usr/bin/env bash

set -euo pipefail

VERSION="${1:?usage: create-updater-latest-json.sh <version> <release-tag>}"
RELEASE_TAG="${2:?usage: create-updater-latest-json.sh <version> <release-tag>}"
REPOSITORY="${GITHUB_REPOSITORY:-SerTimBerrners-Lee/talkis}"
BUILD_ROOT="${BUILD_ROOT:-src-tauri/target/release/bundle}"
LATEST_JSON_PATH="${BUILD_ROOT}/latest.json"
REQUIRED_PLATFORMS="${TALKIS_REQUIRED_UPDATER_PLATFORMS:-}"

if [[ ! -d "${BUILD_ROOT}" ]]; then
  echo "Build root not found: ${BUILD_ROOT}" >&2
  exit 1
fi

PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

python3 - "$BUILD_ROOT" "$LATEST_JSON_PATH" "$VERSION" "$PUB_DATE" "$REPOSITORY" "$RELEASE_TAG" "$REQUIRED_PLATFORMS" <<'PY'
import json
from pathlib import Path
import sys

build_root, path, version, pub_date, repository, release_tag, required_platforms = sys.argv[1:]
root = Path(build_root)

platform_specs = {
    "darwin-aarch64": ["*.app.tar.gz"],
    "windows-x86_64": ["*.exe", "*.msi"],
    "linux-x86_64": ["*.AppImage"],
}

def find_artifact(patterns):
    for pattern in patterns:
        matches = sorted(
            candidate
            for candidate in root.rglob(pattern)
            if candidate.is_file()
            and not candidate.name.endswith(".sig")
        )
        if matches:
            return matches[0]
    return None

platforms = {}

for platform, patterns in platform_specs.items():
    artifact = find_artifact(patterns)
    if artifact is None:
        continue

    signature_path = artifact.with_name(f"{artifact.name}.sig")
    if not signature_path.is_file():
        raise SystemExit(f"Updater signature not found for {platform}: {signature_path}")

    signature = signature_path.read_text(encoding="utf-8").strip()
    url = f"https://github.com/{repository}/releases/download/{release_tag}/{artifact.name}"
    platforms[platform] = {
        "signature": signature,
        "url": url,
    }

required = [item.strip() for item in required_platforms.split(",") if item.strip()]
missing = [platform for platform in required if platform not in platforms]
if missing:
    raise SystemExit(f"Missing required updater platforms: {', '.join(missing)}")

if not platforms:
    raise SystemExit(f"No updater artifacts found in {root}")

payload = {
    "version": version,
    "pub_date": pub_date,
    "platforms": platforms,
}

with open(path, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

echo "Created updater metadata at ${LATEST_JSON_PATH}"
