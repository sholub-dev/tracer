#!/bin/sh
# Builds the app and uploads it to App Store Connect for TestFlight.
set -eu
cd "$(dirname "$0")"
VERSION=$(node -p 'require("../../package.json").version')
# Each upload needs a higher build number than the last one.
BUILD=$(date -u +%Y%m%d.%H%M)
ARCHIVE=build/Tracer-$VERSION-$BUILD.xcarchive

# An App Store Connect API key signs and uploads on its own; without it, xcodebuild needs the Apple ID session in
# Xcode's Accounts settings, which expires.
if [ -n "${ASC_KEY_ID:-}" ]; then
  KEY_PATH=${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}
  [ -f "$KEY_PATH" ] || { echo "No API key file at $KEY_PATH." >&2; exit 1; }
  set -- -authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID}"
else
  echo "ASC_KEY_ID is not set: signing uses the Apple ID in Xcode's Accounts settings." >&2
  set --
fi

pnpm run build
xcodebuild archive -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination generic/platform=iOS -archivePath "$ARCHIVE" -allowProvisioningUpdates "$@" \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates "$@"
echo "Uploaded Tracer $VERSION ($BUILD)."
