#!/usr/bin/env bash
# Complete firmware RESET for the ROBOT (ESP32).
#
# Erases the board and reinstalls MicroPython from scratch. The firmware image
# is downloaded + verified automatically on first use. Do this once per robot,
# when upgrading MicroPython, or to recover a board that won't accept uploads.
#
# Usage:
#   ./scripts/reset-robot.sh                 # auto-detect the serial port
#   ./scripts/reset-robot.sh -p /dev/cu.xxx  # target a specific port
#
# After this, run ./scripts/flash-robot.sh to upload your code.
#
# This is a thin wrapper around flash-robot.sh --firmware so all the setup and
# flashing logic lives in one place.
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
  echo "doesn't work. Extract it first, then run scripts/reset-robot.sh from the" >&2
  echo "extracted folder." >&2
  exit 1
fi
exec "${DIR}/flash-robot.sh" --firmware "$@"
