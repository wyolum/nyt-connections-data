#!/bin/bash
# One-time installer (run ON THE MAC MINI). Generates a launchd LaunchAgent that
# runs the nightly scrape, and schedules the mini to wake for it.
#
# Usage:  bash local/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.wyolum.nyt-connections"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Scrape time (local mini time). NYT publishes the new puzzle at 03:00 ET.
HOUR=3
MINUTE=10

mkdir -p "$HOME/Library/LaunchAgents" "$SCRIPT_DIR/logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT_DIR/run-scrape.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>$HOUR</integer>
        <key>Minute</key><integer>$MINUTE</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/logs/launchd.err.log</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF

echo "Wrote $PLIST"

# (Re)load the agent.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Loaded launchd agent '$LABEL' (fires daily at $(printf '%02d:%02d' "$HOUR" "$MINUTE") local time)."

# Schedule a wake a few minutes before, so the mini is awake to run the job.
# Requires sudo. If the mini never sleeps, this is harmless.
WAKE_HOUR=$HOUR
WAKE_MINUTE=$((MINUTE - 3))
if [ "$WAKE_MINUTE" -lt 0 ]; then WAKE_MINUTE=0; fi
echo
echo "To wake the mini for the run (recommended if it sleeps), run:"
echo "  sudo pmset repeat wakeorpoweron MTWRFSU $(printf '%02d:%02d:00' "$WAKE_HOUR" "$WAKE_MINUTE")"
echo
echo "Done. Test it now with:   bash $SCRIPT_DIR/run-scrape.sh"
echo "Tail logs with:           tail -f $SCRIPT_DIR/logs/*.log"
