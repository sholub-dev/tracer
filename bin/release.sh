#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
VERSION="${VERSION#v}"

if [ -z "$VERSION" ]; then
  echo "Usage: pnpm release <version>"
  echo "Example: pnpm release 0.2.0"
  exit 1
fi

if [ -n "${CI:-}" ]; then
  echo "ERROR: release.sh is for local use only (opens the version-bump PR and tags the merged release)."
  echo "npm publish + GitHub release are handled by .github/workflows/release.yml on tag push."
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI is required (https://cli.github.com/)."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: working tree has uncommitted changes."
  exit 1
fi

git fetch origin master --quiet
git checkout master --quiet
git pull --ff-only --quiet

BRANCH="chore/release-${VERSION}"
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "ERROR: branch ${BRANCH} already exists locally."
  exit 1
fi

git checkout -b "$BRANCH"

node -e "
  const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
  if (pkg.version === '$VERSION') {
    console.error('ERROR: package.json is already at version $VERSION.');
    process.exit(1);
  }
  pkg.version = '$VERSION';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

git add package.json
git commit -m "v${VERSION}" --quiet
git push -u origin "$BRANCH" --quiet

PR_URL=$(gh pr create --title "v${VERSION}" --body "Version bump.")
echo ""
echo "Opened ${PR_URL}"
echo ""
echo "Merge the PR, then press Enter to tag v${VERSION} and trigger the release workflow."
echo "(Ctrl-C to abort; you can tag manually later with: git checkout master && git pull && git tag v${VERSION} && git push origin v${VERSION})"
read -r

git checkout master --quiet
git pull --ff-only --quiet

MERGED_VERSION=$(node -e "console.log(require('./package.json').version)")
if [ "$MERGED_VERSION" != "$VERSION" ]; then
  echo "ERROR: package.json on master is at ${MERGED_VERSION}, expected ${VERSION}. Did the PR merge?"
  exit 1
fi

git tag "v${VERSION}"
git push origin "v${VERSION}" --quiet

echo ""
echo "Tagged v${VERSION} — CI will publish to npm and create the GitHub Release."
