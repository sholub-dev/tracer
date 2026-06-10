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
  echo "ERROR: release.sh is for local use only (opens the version-bump PR)."
  echo "npm publish + GitHub release are handled by .github/workflows/release.yml when the bump merges to master."
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

sync_master() {
  git checkout master --quiet
  git pull --ff-only --quiet origin master
}

sync_master

BRANCH="chore/release-${VERSION}"
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "ERROR: branch ${BRANCH} already exists. Delete with: git branch -D ${BRANCH}"
  exit 1
fi

git checkout -b "$BRANCH" --quiet
pnpm version "$VERSION" --no-git-tag-version >/dev/null
git add package.json
git commit -m "v${VERSION}" --quiet
git push -u origin "$BRANCH" --quiet

PR_URL=$(gh pr create --title "v${VERSION}" --body "Bump version to ${VERSION}.")
echo ""
echo "Opened ${PR_URL}"
echo ""
echo "Merge the PR — CI will publish v${VERSION} to npm, tag it, and create the GitHub Release."

git checkout master --quiet
