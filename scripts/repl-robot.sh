#!/usr/bin/env bash
# Open a live MicroPython REPL on the ROBOT (ESP32).
#
# Gives you an interactive Python prompt on the board so you can see print()
# output and poke at things live. Press Ctrl-] (or Ctrl-X) to exit the REPL.
#
# Usage:
#   ./scripts/repl-robot.sh                  # auto-detect the serial port
#   ./scripts/repl-robot.sh -p /dev/cu.xxx   # target a specific port
#
# This is a thin wrapper around flash-robot.sh --repl so all the setup logic
# lives in one place.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Name the missing sibling and lead with the usual cause: running straight out
# of a .zip (or copying this wrapper out on its own) leaves flash-robot.sh
# nowhere near it, and "No such file or directory" alone doesn't say that.
if [[ ! -f "${DIR}/flash-robot.sh" ]]; then
  echo "[error] Can't find flash-robot.sh next to this script:" >&2
  echo "        ${DIR}/flash-robot.sh" >&2
  echo "" >&2
  echo "Did you extract the ZIP? Running these scripts from inside the archive" >&2
  echo "doesn't work. Extract it first, then run scripts/repl-robot.sh from the" >&2
  echo "extracted folder." >&2
  exit 1
fi
exec "${DIR}/flash-robot.sh" --repl "$@"
