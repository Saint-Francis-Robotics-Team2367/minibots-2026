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
exec "${DIR}/flash-robot.sh" --firmware "$@"
