#!/bin/sh
# Install OKO Debug Platform
#
# Usage (requires gh CLI, works for both private and public repos):
#   gh api repos/sholub1989/oko/contents/install.sh --jq '.content' | base64 -d | sh
#
set -e

REPO="sholub1989/oko"
OKO_HOME="${HOME}/.oko"

echo ""
echo "  ╔═══════════════════════════════════╗"
echo "  ║       OKO Installer               ║"
echo "  ╚═══════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but not installed."
  echo "Install Node.js 20+ from https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ is required (found v$(node --version))."
  echo "Install Node.js 20+ from https://nodejs.org"
  exit 1
fi

# Check gh CLI (needed for private repo)
if ! command -v gh >/dev/null 2>&1; then
  echo "Error: GitHub CLI (gh) is required but not installed."
  echo "Install from https://cli.github.com"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: GitHub CLI is not authenticated."
  echo "Run: gh auth login"
  exit 1
fi

echo "Fetching latest release..."
RELEASE_INFO=$(gh api "repos/${REPO}/releases/latest" --jq '.tag_name + " " + .assets[0].url' < /dev/null 2>/dev/null) || {
  echo "Error: Could not fetch releases. Check your access to ${REPO}."
  exit 1
}

TAG=$(echo "$RELEASE_INFO" | cut -d' ' -f1)
ASSET_URL=$(echo "$RELEASE_INFO" | cut -d' ' -f2)

if [ -z "$TAG" ] || [ -z "$ASSET_URL" ]; then
  echo "Error: No releases found for ${REPO}."
  exit 1
fi

echo "Installing OKO ${TAG}..."

# Create directory structure
mkdir -p "${OKO_HOME}/app" "${OKO_HOME}/data" "${OKO_HOME}/bin"

# Download and extract
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

gh api "$ASSET_URL" -H "Accept: application/octet-stream" < /dev/null > "${TMPDIR}/oko.tar.gz"
tar -xzf "${TMPDIR}/oko.tar.gz" -C "${OKO_HOME}/app"

# Install production dependencies and rebuild native modules for this Node version
echo "Installing dependencies..."
cd "${OKO_HOME}/app"
npm install --production --no-audit --no-fund
npm rebuild

# Write version
echo "$TAG" | sed 's/^v//' > "${OKO_HOME}/.version"

# Create launcher script
cat > "${OKO_HOME}/bin/oko" << 'LAUNCHER'
#!/bin/sh
OKO_HOME="${HOME}/.oko"
export OKO_HOME
SERVER="${OKO_HOME}/app/dist/index.js"
cd "$HOME"

# Rebuild native modules if compiled for a different Node version
node -e "require('${OKO_HOME}/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node')" 2>/dev/null || (
  echo "Rebuilding native modules for Node $(node --version)..."
  cd "${OKO_HOME}/app" && npm rebuild --silent
)

while true; do
  node "$SERVER" "$@"
  EXIT_CODE=$?
  [ "$EXIT_CODE" -ne 75 ] && exit $EXIT_CODE
  echo ""
  echo "Restarting after update..."
  echo ""
done
LAUNCHER
chmod +x "${OKO_HOME}/bin/oko"

# Add to PATH
OKO_BIN_PATH='export PATH="$HOME/.oko/bin:$PATH"'
ADDED_PATH=false

for RC_FILE in "${HOME}/.zshrc" "${HOME}/.bashrc"; do
  if [ -f "$RC_FILE" ]; then
    if ! grep -q '.oko/bin' "$RC_FILE" 2>/dev/null; then
      echo "" >> "$RC_FILE"
      echo "# OKO" >> "$RC_FILE"
      echo "$OKO_BIN_PATH" >> "$RC_FILE"
      ADDED_PATH=true
    fi
  fi
done

echo ""
echo "OKO ${TAG} installed successfully!"
echo ""
echo "Run 'oko' to start the platform."
if [ "$ADDED_PATH" = true ]; then
  echo "(You may need to restart your shell or run: source ~/.zshrc)"
fi
echo ""
