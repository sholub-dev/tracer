#!/usr/bin/env bash
set -euo pipefail

VERSION="$1"
VERSION="${VERSION#v}"  # strip leading v if present

if [ -z "$VERSION" ]; then
  echo "Usage: pnpm release <version>"
  echo "Example: pnpm release 0.2.0"
  exit 1
fi

# Update package.json version
node -e "
  const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
  pkg.version = '$VERSION';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Commit, tag, push — all in one shot
git add package.json
git commit -m "v${VERSION}"
git tag "v${VERSION}"
git push origin master --tags

echo "Released v${VERSION}"
