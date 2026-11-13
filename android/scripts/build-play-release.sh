#!/usr/bin/env bash
# Universal Harness release build (v1.0.0).
#
# Cross-platform signing: credentials come from environment variables only
# (UH_KEYSTORE_PATH, UH_KEYSTORE_PASSWORD, UH_KEY_ALIAS, UH_KEY_PASSWORD).
# The old macOS Keychain lookup and /Users/jarves/... hardcode are gone; the
# Gradle fallback keystore covers builds without credentials.
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
version_code="${1:-6}"
version_name="${2:-1.0.0}"

if [[ -n "${UH_KEYSTORE_PATH:-}" && ! -f "$UH_KEYSTORE_PATH" ]]; then
  echo "Release keystore not found: $UH_KEYSTORE_PATH" >&2
  exit 1
fi
if [[ -z "${UH_KEYSTORE_PATH:-}" ]]; then
  echo "UH_KEYSTORE_PATH not set; the automatic fallback keystore will sign the APKs (not for Play upload)." >&2
fi

cd "$project_dir"
export UH_KEYSTORE_PATH UH_KEYSTORE_PASSWORD UH_KEY_ALIAS UH_KEY_PASSWORD
./gradlew \
  -PplayBuild=true \
  -PappVersionCode="$version_code" \
  -PappVersionName="$version_name" \
  playReadinessCheck testOnlineDebugUnitTest assembleOnlineRelease bundleOnlineRelease

echo "Signed online bundle: $project_dir/app/build/outputs/bundle/onlineRelease/app-online-release.aab"
echo "Signed online APK: $project_dir/app/build/outputs/apk/online/release/app-online-release.apk"
