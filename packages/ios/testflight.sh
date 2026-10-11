#!/bin/sh
# Builds the app and uploads it to App Store Connect for TestFlight.
set -eu
cd "$(dirname "$0")"
VERSION=$(node -p 'require("../../package.json").version')
# Each upload needs a higher build number than the last one.
BUILD=$(date -u +%Y%m%d.%H%M)
ARCHIVE=build/Tracer-$VERSION-$BUILD.xcarchive

pnpm run build
xcodebuild archive -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination generic/platform=iOS -archivePath "$ARCHIVE" -allowProvisioningUpdates \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates
echo "Uploaded Tracer $VERSION ($BUILD)."
