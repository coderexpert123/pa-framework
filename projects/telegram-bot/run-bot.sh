#!/usr/bin/env bash
# POSIX bot launcher — sibling to run-bot.ps1 for Linux/macOS.
# Usage: bash run-bot.sh   (or mark executable: chmod +x run-bot.sh && ./run-bot.sh)
set -euo pipefail

PA_HOME="${PA_HOME:-$HOME/.pa}"
LOG_DIR="$PA_HOME/logs"
LOG_FILE="$LOG_DIR/telegram-bot.log"
# Rotation threshold and destination MUST match pa/src/lib/archive-files.ts
# (RUNTIME_ARCHIVE_MAX_BYTES = 5MB; ~/.pa/archive/<stamp>-<basename>) so the
# archive-prune maintenance job governs these shards, and run-bot.ps1's policy.
# Rotating HERE — not in the bot — is load-bearing: the node process holds this
# file open through shell redirection, so it can only be rotated while the bot
# is down. Do NOT simply delete this block: bot-log-rotation-check restarts the
# bot at 5MB, so with no launcher-side rotation the bot would restart every
# minute forever. AI-100 W2.
MAX_BYTES=$((5 * 1024 * 1024))
ARCHIVE_DIR="$PA_HOME/archive"

mkdir -p "$LOG_DIR"

# Rotate log if over MAX_BYTES
if [ -f "$LOG_FILE" ]; then
  size=$(wc -c < "$LOG_FILE")
  if [ "$size" -gt "$MAX_BYTES" ]; then
    mkdir -p "$ARCHIVE_DIR"
    mv "$LOG_FILE" "$ARCHIVE_DIR/$(date +%Y-%m-%d-%H%M%S)-telegram-bot.log"
  fi
fi

# UV_THREADPOOL_SIZE=16 (AI-096): fs and dns.lookup share libuv's threadpool —
# raising it decouples DNS from fs pressure (the coupling that took all
# networking down on 2026-07-04). Matches run-bot.ps1 / run-bot-hidden.vbs.
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/dist/main.js" >> "$LOG_FILE" 2>&1
