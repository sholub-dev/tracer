#!/bin/sh
# Uninstall OKO Debug Platform
#
# Usage:
#   gh api repos/sholub1989/oko/contents/uninstall.sh --jq '.content' | base64 -d | sh
#
set -e

OKO_HOME="${HOME}/.oko"

echo ""
echo "  ╔═══════════════════════════════════╗"
echo "  ║       OKO Uninstaller             ║"
echo "  ╚═══════════════════════════════════╝"
echo ""

if [ ! -d "$OKO_HOME" ]; then
  echo "OKO is not installed (${OKO_HOME} not found)."
  exit 0
fi

printf "This will remove ${OKO_HOME} and all data. Continue? [y/N] "
read -r CONFIRM < /dev/tty
case "$CONFIRM" in
  y|Y|yes|YES) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

# Remove install directory
rm -rf "$OKO_HOME"
echo "Removed ${OKO_HOME}"

# Clean up PATH entries from shell rc files
for RC_FILE in "${HOME}/.zshrc" "${HOME}/.bashrc"; do
  if [ -f "$RC_FILE" ] && grep -q '.oko/bin' "$RC_FILE" 2>/dev/null; then
    # Remove the OKO comment and PATH line
    sed -i.bak '/# OKO/d;/.oko\/bin/d' "$RC_FILE"
    rm -f "${RC_FILE}.bak"
    echo "Cleaned PATH from $(basename "$RC_FILE")"
  fi
done

echo ""
echo "OKO has been uninstalled."
echo ""
