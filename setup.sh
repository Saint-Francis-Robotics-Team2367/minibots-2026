#!/usr/bin/env bash
# =============================================================================
# minibots-2026 — one-shot toolchain bootstrap (macOS / Linux)
#
#   git clone <repo> && cd minibots-2026 && ./setup.sh
#
# Installs everything needed to build & flash BOTH firmwares from a fresh
# machine:
#   * PlatformIO Core  -> robot firmware (firmware/esp32-robot, Arduino)
#   * ESP-IDF v5.3.2   -> dongle firmware (firmware/esp32s3-dongle, ESP32-S3)
#
# ESP-IDF is cloned into ./.esp-idf (repo-local, git-ignored). Re-running is
# safe and idempotent. After this finishes, use:
#   ./flash-robot.sh      ./flash-dongle.sh
# =============================================================================
set -euo pipefail

# --- version pin (keep in sync with firmware/esp32s3-dongle/dependencies.lock) ---
IDF_VERSION="v5.3.2"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDF_DIR="${ROOT}/.esp-idf"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"

# -----------------------------------------------------------------------------
# 0. Prerequisites: git, python3, cmake (for ESP-IDF)
# -----------------------------------------------------------------------------
info "Checking prerequisites"
command -v git     >/dev/null 2>&1 || die "git not found. Install git and re-run."
command -v python3 >/dev/null 2>&1 || die "python3 not found. Install Python 3.9+ and re-run."

# ESP-IDF v5.3.2 (2024) is tested against Python 3.9-3.12; its pinned tooling can
# fail to install on 3.13+. Require the supported range, recommend 3.11.
PY_VER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
PY_MAJOR="${PY_VER%%.*}"; PY_MINOR="${PY_VER#*.}"
if [[ "${MINICORE_SKIP_PYCHECK:-0}" == "1" ]]; then
  warn "Skipping Python version check (MINICORE_SKIP_PYCHECK=1); using ${PY_VER}."
elif [[ "$PY_MAJOR" -ne 3 || "$PY_MINOR" -lt 9 || "$PY_MINOR" -gt 12 ]]; then
  die "Python ${PY_VER} is not supported by ESP-IDF v${IDF_VERSION#v}.
       Use Python 3.9-3.12 (3.11 recommended). ESP-IDF installs its own venv, so
       3.11 only needs to be on PATH here — it need not be your system default.
       macOS:   brew install python@3.11   (then re-run with python3.11)
       Windows: install 3.11 from https://python.org
       Override at your own risk: set MINICORE_SKIP_PYCHECK=1"
fi
info "Python ${PY_VER} OK"

if ! command -v cmake >/dev/null 2>&1; then
  warn "cmake not found — required by ESP-IDF."
  case "$OS" in
    Darwin) warn "Install with: brew install cmake ninja dfu-util" ;;
    Linux)  warn "Install with: sudo apt-get install -y cmake ninja-build dfu-util (or your distro's equivalent)" ;;
  esac
fi

# -----------------------------------------------------------------------------
# 1. PlatformIO (robot firmware)
# -----------------------------------------------------------------------------
if command -v pio >/dev/null 2>&1; then
  info "PlatformIO already installed: $(pio --version)"
else
  info "Installing PlatformIO Core via pip"
  python3 -m pip install --user --upgrade platformio \
    || die "pip install platformio failed. Try: python3 -m pip install --user platformio"
  if ! command -v pio >/dev/null 2>&1; then
    warn "'pio' is not on PATH yet. Add your user bin dir to PATH, e.g.:"
    case "$OS" in
      Darwin) warn "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
      Linux)  warn "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
    esac
  fi
fi

# -----------------------------------------------------------------------------
# 2. ESP-IDF (dongle firmware) — clone pinned version + run installer
# -----------------------------------------------------------------------------
if [[ -d "${IDF_DIR}/.git" ]]; then
  CURRENT="$(git -C "${IDF_DIR}" describe --tags 2>/dev/null || echo unknown)"
  info "ESP-IDF already present at .esp-idf (${CURRENT})"
  if [[ "${CURRENT}" != "${IDF_VERSION}" ]]; then
    warn "Installed ESP-IDF is ${CURRENT}, project expects ${IDF_VERSION}."
    warn "Delete .esp-idf and re-run to switch versions."
  fi
else
  info "Cloning ESP-IDF ${IDF_VERSION} into .esp-idf (shallow; ~a few hundred MB)"
  # --shallow-submodules: depth-1 for every submodule (mbedtls, esptool, ...),
  #   not just the main repo -> avoids downloading full submodule history.
  # -j: fetch submodules in parallel. This still pulls all submodules ESP-IDF
  #   declares; skipping specific ones (mqtt, unity, ...) risks breaking the
  #   build since Wi-Fi/TLS/USB pull in shared components transitively.
  git clone --branch "${IDF_VERSION}" --depth 1 \
    --recurse-submodules --shallow-submodules -j 8 \
    https://github.com/espressif/esp-idf.git "${IDF_DIR}" \
    || die "ESP-IDF clone failed."
fi

info "Installing ESP-IDF tools for esp32s3 (compiler, openocd, etc.)"
"${IDF_DIR}/install.sh" esp32s3 || die "ESP-IDF install.sh failed."

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
echo
bold "Setup complete."
echo
echo "Build & flash the robot (ESP32, PlatformIO):"
echo "    ./flash-robot.sh"
echo
echo "Build & flash the dongle (ESP32-S3, ESP-IDF):"
echo "    ./flash-dongle.sh"
echo
echo "The dongle scripts auto-source ESP-IDF from .esp-idf — no manual export needed."
