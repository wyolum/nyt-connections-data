#!/bin/bash
# Nightly NYT Connections scrape + commit + push, intended to be run by launchd
# on the Mac mini. Self-contained: derives the repo path from its own location,
# augments PATH for Homebrew node, locks against overlapping runs, and logs.
set -uo pipefail

# --- locate repo (this script lives in <repo>/local/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
LOCK_DIR="$SCRIPT_DIR/.lock"
mkdir -p "$LOG_DIR"

# launchd runs with a minimal PATH; make sure node/npm/git are findable.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S %z')] $*"; }

# --- single-instance lock (mkdir is atomic) ---
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "Another run holds the lock ($LOCK_DIR); exiting."
    exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

cd "$REPO_DIR" || { log "Cannot cd to $REPO_DIR"; exit 1; }

log "=== Starting nightly scrape in $REPO_DIR ==="

# Get latest (autostash protects any stray local edits).
git pull --rebase --autostash || log "WARNING: git pull failed; continuing with local copy."

# Ensure deps exist (first run, or lockfile changed).
if [ ! -d "scraper/node_modules" ]; then
    log "Installing node dependencies..."
    ( cd scraper && npm ci ) || { log "npm ci failed"; exit 1; }
    log "Installing Playwright Chromium..."
    ( cd scraper && npx playwright install chromium ) || { log "playwright install failed"; exit 1; }
fi

# Run the scraper.
if ! node scraper/scrape.mjs; then
    log "Scraper failed. See failure.png if present."
    exit 1
fi

# Commit + push only if data changed.
git config user.name "wyolum-bot" >/dev/null 2>&1 || true
git config user.email "wyolum-bot@users.noreply.github.com" >/dev/null 2>&1 || true
git add docs/data/*.json
if git diff --cached --quiet; then
    log "No data changes to commit."
else
    git commit -m "Update Connections data (local)" && git push && log "Pushed updated data."
fi

log "=== Done ==="
