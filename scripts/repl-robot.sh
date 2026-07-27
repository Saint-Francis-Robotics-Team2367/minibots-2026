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
exec "${DIR}/flash-robot.sh" --repl "$@"
