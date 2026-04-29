#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  if [[ ! -f "${TAURI_SIGNING_PRIVATE_KEY_PATH}" ]]; then
    echo "TAURI_SIGNING_PRIVATE_KEY_PATH does not point to a file: ${TAURI_SIGNING_PRIVATE_KEY_PATH}" >&2
    exit 1
  fi

  export TAURI_SIGNING_PRIVATE_KEY
  TAURI_SIGNING_PRIVATE_KEY="$(cat "${TAURI_SIGNING_PRIVATE_KEY_PATH}")"
fi

bun run prepare:ffmpeg-sidecar
bun run tauri build
bun run postprocess:macos-release
