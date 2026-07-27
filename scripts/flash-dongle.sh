#!/usr/bin/env bash
# Build & flash the DONGLE firmware (ESP32-S3, ESP-IDF).
#
#   ./scripts/flash-dongle.sh               # build + flash to auto-detected port
#   ./scripts/flash-dongle.sh --port /dev/cu.usbmodem101
#   ./scripts/flash-dongle.sh --build-only  # compile without flashing
#   ./scripts/flash-dongle.sh --monitor     # flash then open serial monitor
#
# ESP-IDF is auto-sourced from ./.esp-idf (installed by ./scripts/setup.sh). To use a
# system ESP-IDF instead, set IDF_PATH before running.
#
# USB download mode (if flashing fails): hold BOOT, press+release RESET,
# release BOOT, then re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="${ROOT}/firmware/esp32s3-dongle"

# --- locate & source ESP-IDF ---
if ! command -v idf.py >/dev/null 2>&1; then
  IDF_EXPORT=""
  if [[ -n "${IDF_PATH:-}" && -f "${IDF_PATH}/export.sh" ]]; then
    IDF_EXPORT="${IDF_PATH}/export.sh"
  elif [[ -f "${ROOT}/.esp-idf/export.sh" ]]; then
    IDF_EXPORT="${ROOT}/.esp-idf/export.sh"
  fi
  if [[ -z "$IDF_EXPORT" ]]; then
    echo "[error] ESP-IDF not found. Run ./scripts/setup.sh first, or set IDF_PATH." >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . "$IDF_EXPORT"
fi

PORT_ARGS=()
BUILD_ONLY=0
DO_MONITOR=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)    PORT_ARGS=(-p "$2"); shift 2 ;;
    --build-only) BUILD_ONLY=1; shift ;;
    --monitor|-m) DO_MONITOR=1; shift ;;
    *) echo "[error] unknown arg: $1" >&2; exit 1 ;;
  esac
done

cd "$PROJ"
idf.py set-target esp32s3   # no-op once configured; ensures fresh clones build
idf.py build

if (( BUILD_ONLY )); then
  exit 0
fi

TARGETS=(flash)
(( DO_MONITOR )) && TARGETS+=(monitor)
exec idf.py "${PORT_ARGS[@]}" "${TARGETS[@]}"
