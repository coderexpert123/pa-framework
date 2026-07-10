#!/usr/bin/env bash
# POSIX bot launcher — sibling to run-bot.ps1 for Linux/macOS.
# Usage: bash run-bot.sh   (or mark executable: chmod +x run-bot.sh && ./run-bot.sh)
set -euo pipefail

PA_HOME="${PA_HOME:-$HOME/.pa}"
LOG_DIR="$PA_HOME/logs"
LOG_FILE="$LOG_DIR/telegram-bot.log"
MAX_BYTES=$((2 * 1024 * 1024))   # 2 MB — matches run-bot.ps1

mkdir -p "$LOG_DIR"

# Rotate log if over MAX_BYTES
if [ -f "$LOG_FILE" ]; then
  size=$(wc -c < "$LOG_FILE")
  if [ "$size" -gt "$MAX_BYTES" ]; then
    [ -f "$LOG_FILE.1" ] && rm -f "$LOG_FILE.1"
    mv "$LOG_FILE" "$LOG_FILE.1"
  fi
fi

# UV_THREADPOOL_SIZE=16 (AI-096): fs and dns.lookup share libuv's threadpool —
# raising it decouples DNS from fs pressure (the coupling that took all
# networking down on 2026-07-04). Matches run-bot.ps1 / run-bot-hidden.vbs.
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/dist/main.js" >> "$LOG_FILE" 2>&1
