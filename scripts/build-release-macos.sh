#!/usr/bin/env bash

set -euo pipefail

export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
export TALKIS_STT_RELEASE=1

bun scripts/build-release.mjs macos
