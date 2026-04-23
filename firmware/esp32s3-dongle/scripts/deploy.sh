#!/usr/bin/env bash
# Build the dongle firmware and flash to a connected ESP32-S3 (USB serial or USB-JTAG/serial).
# Usage: from anywhere, or: idf.py build && cmake --build build --target deploy
#
# Requires: IDF in PATH, or set IDF_PATH and this script will source export.sh
# Optional: ESPPORT=/dev/cu.usbmodem101  (or idf.py auto-detects a single port)

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v idf.py >/dev/null 2>&1; then
  if [[ -z "${IDF_PATH:-}" || ! -f "${IDF_PATH}/export.sh" ]]; then
    echo "idf.py not found. Set IDF_PATH to your ESP-IDF tree and run:" >&2
    echo "  . \"\${IDF_PATH}/export.sh\"" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . "${IDF_PATH}/export.sh"
fi

PORT_ARGS=()
if [[ -n "${ESPPORT:-}" ]]; then
  PORT_ARGS=(-p "$ESPPORT")
fi

idf.py build
if ((${#PORT_ARGS[@]} > 0)); then
  exec idf.py "${PORT_ARGS[@]}" flash "$@"
else
  exec idf.py flash "$@"
fi
