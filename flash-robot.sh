#!/usr/bin/env bash
# Build & flash the ROBOT firmware (ESP32, PlatformIO / Arduino).
#
#   ./flash-robot.sh                # build + upload to auto-detected port
#   ./flash-robot.sh --port /dev/cu.usbserial-XXXX
#   ./flash-robot.sh --build-only   # compile without flashing
#   ./flash-robot.sh --monitor      # flash then open serial monitor
#
# Customize robot name / motor pins / Wi-Fi channel in
#   firmware/esp32-robot/platformio.ini  (build_flags).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="${ROOT}/firmware/esp32-robot"

command -v pio >/dev/null 2>&1 || {
  echo "[error] 'pio' not found. Run ./setup.sh first (and ensure ~/.local/bin is on PATH)." >&2
  exit 1
}

PORT_ARGS=()
BUILD_ONLY=0
MONITOR=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)   PORT_ARGS=(--upload-port "$2"); shift 2 ;;
    --build-only) BUILD_ONLY=1; shift ;;
    --monitor|-m) MONITOR=1; shift ;;
    *) echo "[error] unknown arg: $1" >&2; exit 1 ;;
  esac
done

cd "$PROJ"
if (( BUILD_ONLY )); then
  exec pio run
fi

pio run -t upload "${PORT_ARGS[@]}"
if (( MONITOR )); then
  exec pio device monitor
fi
