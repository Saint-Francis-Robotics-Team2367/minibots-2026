#!/usr/bin/env bash
# Build & flash the DONGLE firmware (ESP32-S3, ESP-IDF).
#
#   ./scripts/flash-dongle.sh               # build + flash to auto-detected port
#   ./scripts/flash-dongle.sh --port /dev/cu.usbmodem101
#   ./scripts/flash-dongle.sh --build-only  # compile without flashing
#   ./scripts/flash-dongle.sh --monitor     # flash then open serial monitor
#   ./scripts/flash-dongle.sh --skip-setup  # assume ESP-IDF is already installed/sourced
#
# On first run this installs its own toolchain: it clones the pinned ESP-IDF
# v5.3.2 into ./.esp-idf (repo-local, git-ignored) and runs its installer — no
# separate setup step. Later runs just source that SDK and are fast. To use a
# system ESP-IDF instead, set IDF_PATH before running.
#
# USB download mode (if flashing fails): hold BOOT, press+release RESET,
# release BOOT, then re-run.
set -euo pipefail

# --- version pin (keep in sync with firmware/esp32s3-dongle/dependencies.lock) ---
IDF_VERSION="v5.3.2"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="${ROOT}/firmware/esp32s3-dongle"
IDF_DIR="${ROOT}/.esp-idf"

PORT_ARGS=()
BUILD_ONLY=0
DO_MONITOR=0
SKIP_SETUP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)    PORT_ARGS=(-p "$2"); shift 2 ;;
    --build-only) BUILD_ONLY=1; shift ;;
    --monitor|-m) DO_MONITOR=1; shift ;;
    --skip-setup) SKIP_SETUP=1; shift ;;
    *) echo "[error] unknown arg: $1" >&2; exit 1 ;;
  esac
done

OS="$(uname -s)"
info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- ensure the repo-local ESP-IDF exists (first-run setup, then a no-op) ---
# Only runs when idf.py isn't already on PATH and no system IDF_PATH is set.
ensure_idf() {
  command -v git >/dev/null 2>&1 || die "git not found. Install git and re-run."

  # ESP-IDF v5.3.2 (2024) is tested against Python 3.9-3.12; its pinned tooling can
  # fail to install on 3.13+. Require the supported range, recommend 3.11.
  #
  # Probe each candidate by running it and prefer a supported version, rather than
  # committing to whatever owns the bare `python3` name: on an up-to-date macOS or
  # distro that is often 3.13+, while a perfectly good python3.11 sits right beside
  # it. Newest-supported-first so the closest-to-current interpreter wins.
  PYTHON=""
  py_ver=""
  py_working=""
  py_working_ver=""
  for cand in python3.12 python3.11 python3.10 python3.9 python3 python; do
    command -v "$cand" >/dev/null 2>&1 || continue
    v="$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || continue
    [[ "$v" =~ ^3\.[0-9]+$ ]] || continue
    [[ -n "$py_working" ]] || { py_working="$cand"; py_working_ver="$v"; }
    minor="${v#*.}"
    if (( minor >= 9 && minor <= 12 )); then PYTHON="$cand"; py_ver="$v"; break; fi
  done

  if [[ "${MINICORE_SKIP_PYCHECK:-0}" == "1" && -z "$PYTHON" && -n "$py_working" ]]; then
    PYTHON="$py_working"; py_ver="$py_working_ver"
    warn "Skipping Python version check (MINICORE_SKIP_PYCHECK=1); using ${py_ver} (${PYTHON})."
  elif [[ -z "$PYTHON" ]]; then
    # No auto-install here, unlike the Windows scripts: every mechanism available
    # on this side is either privileged (apt/dnf need sudo) or reshapes a package
    # manager the user owns (brew), and doing that unasked is worse than asking.
    hint="       macOS:   brew install python@3.11
       Debian/Ubuntu: sudo apt-get install -y python3.11 python3.11-venv"
    if [[ -n "$py_working" ]]; then
      die "Python ${py_working_ver} (${py_working}) is not supported by ESP-IDF v${IDF_VERSION#v}.
       Use Python 3.9-3.12 (3.11 recommended); it only needs to be installed, not
       your default — this script finds python3.11 on PATH by name.
${hint}
       Override at your own risk: set MINICORE_SKIP_PYCHECK=1"
    fi
    die "No working Python found. Install Python 3.9-3.12 (3.11 recommended) and re-run.
${hint}"
  fi
  info "Using Python ${py_ver} (${PYTHON})"

  # ESP-IDF's install.sh runs bare `python3` from PATH rather than the interpreter
  # chosen above, so give it a directory where `python3` IS that interpreter.
  # Without this, selecting python3.11 here would still hand ESP-IDF whatever
  # too-new python3 happens to be first on PATH.
  if [[ "$PYTHON" != "python3" ]]; then
    PY_SHIM_DIR="$(mktemp -d)"
    ln -sf "$(command -v "$PYTHON")" "${PY_SHIM_DIR}/python3"
    export PATH="${PY_SHIM_DIR}:${PATH}"
  fi

  if ! command -v cmake >/dev/null 2>&1; then
    warn "cmake not found — required by ESP-IDF."
    case "$OS" in
      Darwin) warn "Install with: brew install cmake ninja dfu-util" ;;
      Linux)  warn "Install with: sudo apt-get install -y cmake ninja-build dfu-util (or your distro's equivalent)" ;;
    esac
  fi

  if [[ -d "${IDF_DIR}/.git" ]]; then
    local current
    current="$(git -C "${IDF_DIR}" describe --tags 2>/dev/null || echo unknown)"
    info "ESP-IDF already present at .esp-idf (${current})"
    if [[ "${current}" != "${IDF_VERSION}" ]]; then
      warn "Installed ESP-IDF is ${current}, project expects ${IDF_VERSION}."
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
}

# --- locate & source ESP-IDF (installing it on first run) ---
if ! command -v idf.py >/dev/null 2>&1; then
  IDF_EXPORT=""
  if [[ -n "${IDF_PATH:-}" && -f "${IDF_PATH}/export.sh" ]]; then
    IDF_EXPORT="${IDF_PATH}/export.sh"
  else
    if [[ ! -f "${IDF_DIR}/export.sh" ]]; then
      (( SKIP_SETUP )) && die "ESP-IDF not found and --skip-setup given. Set IDF_PATH or drop --skip-setup."
      ensure_idf
    fi
    IDF_EXPORT="${IDF_DIR}/export.sh"
  fi
  [[ -f "$IDF_EXPORT" ]] || die "ESP-IDF export script not found at ${IDF_EXPORT}."
  # shellcheck source=/dev/null
  . "$IDF_EXPORT"
fi

cd "$PROJ"
idf.py set-target esp32s3   # no-op once configured; ensures fresh clones build
idf.py build

if (( BUILD_ONLY )); then
  exit 0
fi

TARGETS=(flash)
(( DO_MONITOR )) && TARGETS+=(monitor)
exec idf.py "${PORT_ARGS[@]}" "${TARGETS[@]}"
