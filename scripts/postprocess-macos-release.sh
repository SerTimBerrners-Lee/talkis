#!/usr/bin/env bash

set -euo pipefail

VERSION="${1:?usage: postprocess-macos-release.sh <version>}"
APP_NAME="Talk Flow"
APP_IDENTIFIER="com.trixter.talkflow"
BUILD_ROOT="${BUILD_ROOT:-/tmp/talk-flow-target/release/bundle}"
APP_PATH="${BUILD_ROOT}/macos/${APP_NAME}.app"
DMG_PATH="${BUILD_ROOT}/dmg/${APP_NAME}_${VERSION}_aarch64.dmg"
STAGING_DIR="${BUILD_ROOT}/macos/dmg-staging"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "App bundle not found at ${APP_PATH}" >&2
  exit 1
fi

echo "Ad-hoc signing ${APP_PATH} with stable identifier ${APP_IDENTIFIER}"
codesign --force --deep --sign - --identifier "${APP_IDENTIFIER}" "${APP_PATH}"

echo "Rebuilding DMG from signed app bundle"
rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}"
cp -R "${APP_PATH}" "${STAGING_DIR}/"
ln -s /Applications "${STAGING_DIR}/Applications"
rm -f "${DMG_PATH}"

hdiutil create \
  -volname "${APP_NAME}" \
  -srcfolder "${STAGING_DIR}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

echo "Post-processing complete"
codesign -dv --verbose=4 "${APP_PATH}" 2>&1 | sed 's/^/codesign: /'
