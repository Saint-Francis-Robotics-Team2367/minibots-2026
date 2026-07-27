#!/usr/bin/env bash
# Flash the ROBOT (ESP32, MicroPython).
#
# Two modes:
#   ./scripts/flash-robot.sh --firmware   # ONE-TIME: install MicroPython onto the board
#   ./scripts/flash-robot.sh              # upload student code (main.py + minibot.py) & reboot
#
# Options:
#   --port /-p <PORT>   target a specific serial port (else esptool/mpremote auto-detect)
#   --firmware          erase + write the MicroPython .bin from
#                       firmware/esp32-robot/micropython/ESP32_GENERIC-*.bin
#   --repl              open a live MicroPython prompt (see print() output)
#   --skip-setup        don't check/install esptool + mpremote before flashing
#
# On first run this installs its own tools (esptool + mpremote) into a private
# virtualenv at .venv-flash/ — no separate setup step, nothing installed
# system-wide, and no PATH changes required. The check is idempotent, so later
# runs are instant.
#
# Students normally edit firmware/esp32-robot/main.py, then run ./scripts/flash-robot.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="${ROOT}/firmware/esp32-robot"
MPY_DIR="${PROJ}/micropython"
VENV_DIR="${ROOT}/.venv-flash"

# Pinned MicroPython firmware for the classic ESP32 (auto-downloaded by
# --firmware if not already present in MPY_DIR). Keep in sync with
# firmware/esp32-robot/micropython/README.md.
MPY_BIN_NAME="ESP32_GENERIC-20260406-v1.28.0.bin"
MPY_BIN_URL="https://micropython.org/resources/firmware/${MPY_BIN_NAME}"
MPY_BIN_SHA256="cd7820d02c35d34dd403b44263129c6a511b350aea8446c229890753fe240784"

PORT=""
DO_FIRMWARE=0
DO_REPL=0
SKIP_SETUP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)   PORT="$2"; shift 2 ;;
    --firmware)  DO_FIRMWARE=1; shift ;;
    --repl)      DO_REPL=1; shift ;;
    --skip-setup) SKIP_SETUP=1; shift ;;
    *) echo "[error] unknown arg: $1" >&2; exit 1 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

# Pick a Python to build the venv with (venv module is stdlib in Python 3).
find_python() {
  local c
  for c in python3 python; do
    if have "$c" && "$c" -c 'import sys,venv; sys.exit(0 if sys.version_info>=(3,8) else 1)' >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done
  return 1
}

# Path to the venv's python — this is what we invoke everything through (no PATH
# lookups, no console-script shims, so a $PATH that lacks pip's bin dir is fine).
# The layout differs by OS: POSIX puts it in bin/, Windows (incl. Git Bash) in
# Scripts/python.exe. Resolve to whichever actually exists instead of guessing.
PYBIN=""
resolve_pybin() {
  local p
  for p in "${VENV_DIR}/bin/python" "${VENV_DIR}/bin/python3" \
           "${VENV_DIR}/Scripts/python.exe" "${VENV_DIR}/Scripts/python"; do
    if [[ -x "$p" || -f "$p" ]]; then
      PYBIN="$p"; return 0
    fi
  done
  return 1
}
resolve_pybin || true  # may be empty until the venv is created below

# True if we have a venv python that can import both tools.
tools_ready() { [[ -n "$PYBIN" ]] && "$PYBIN" -c 'import esptool, mpremote' >/dev/null 2>&1; }

# --- ensure flash tools (esptool + mpremote) — first-run setup, then a no-op ---
ensure_tools() {
  tools_ready && return 0

  local py
  py="$(find_python)" || {
    echo "[error] Python 3.8+ not found. Install Python 3 and re-run (needed to install esptool + mpremote)." >&2
    exit 1
  }

  if ! resolve_pybin; then
    echo "[info] Creating tool virtualenv at ${VENV_DIR} (one time)"
    "$py" -m venv "$VENV_DIR" || {
      echo "[error] Failed to create virtualenv at ${VENV_DIR} with '$py -m venv'." >&2
      exit 1
    }
    resolve_pybin || {
      echo "[error] Created ${VENV_DIR} but found no python inside it (looked in bin/ and Scripts/)." >&2
      echo "        Delete ${VENV_DIR} and re-run, or install esptool + mpremote yourself." >&2
      exit 1
    }
  fi

  echo "[info] Installing esptool + mpremote (one time)"
  "$PYBIN" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
  "$PYBIN" -m pip install --upgrade esptool mpremote || {
    echo "[error] Failed to install esptool + mpremote into ${VENV_DIR}." >&2
    echo "        You can retry, or run manually: '$PYBIN -m pip install esptool mpremote'" >&2
    exit 1
  }

  tools_ready || {
    echo "[error] esptool/mpremote still not importable from ${VENV_DIR} after install." >&2
    exit 1
  }
}

(( SKIP_SETUP )) || ensure_tools

tools_ready || {
  echo "[error] esptool + mpremote unavailable. Re-run without --skip-setup to install them." >&2
  exit 1
}

# Invoke the tools as modules through the venv python — never via PATH.
ESPTOOL=("$PYBIN" -m esptool)
MPREMOTE=("$PYBIN" -m mpremote)

# mpremote device selector, e.g. "connect COM5" / "connect /dev/cu.xxx"
MPR_DEV=()
[[ -n "$PORT" ]] && MPR_DEV=(connect "$PORT")

if (( DO_REPL )); then
  exec "${MPREMOTE[@]}" ${MPR_DEV[@]+"${MPR_DEV[@]}"} repl
fi

if (( DO_FIRMWARE )); then
  BIN="$(ls -1 "${MPY_DIR}"/ESP32_GENERIC-*.bin 2>/dev/null | sort | tail -n1 || true)"

  # No firmware image yet? Download the pinned one automatically (verified by
  # SHA256). We fetch through the venv Python so this works the same in
  # PowerShell, Git Bash, macOS and Linux without needing curl/wget on PATH.
  if [[ -z "$BIN" ]]; then
    mkdir -p "$MPY_DIR"
    DEST="${MPY_DIR}/${MPY_BIN_NAME}"
    echo "[info] No firmware image found. Downloading MicroPython ${MPY_BIN_NAME} (one time)"
    if ! "$PYBIN" - "$MPY_BIN_URL" "$DEST" "$MPY_BIN_SHA256" <<'PY'
import sys, hashlib, urllib.request
url, dest, want = sys.argv[1], sys.argv[2], sys.argv[3].lower()
try:
    with urllib.request.urlopen(url, timeout=60) as r, open(dest, "wb") as f:
        data = r.read()
        f.write(data)
except Exception as e:
    print("[error] download failed: %s" % e, file=sys.stderr); sys.exit(1)
got = hashlib.sha256(data).hexdigest()
if got != want:
    import os; os.remove(dest)
    print("[error] SHA256 mismatch: got %s, expected %s" % (got, want), file=sys.stderr)
    sys.exit(1)
print("[info] Downloaded and verified %d bytes" % len(data))
PY
    then
      echo "[error] Could not download the firmware automatically." >&2
      echo "        Download ${MPY_BIN_NAME} from https://micropython.org/download/ESP32_GENERIC/" >&2
      echo "        and place it in ${MPY_DIR} (see its README.md), then re-run." >&2
      exit 1
    fi
    BIN="$DEST"
  fi

  PORT_ARGS=()
  [[ -n "$PORT" ]] && PORT_ARGS=(--port "$PORT")
  echo "[info] Flashing MicroPython: $(basename "$BIN")"
  "${ESPTOOL[@]}" --chip esp32 ${PORT_ARGS[@]+"${PORT_ARGS[@]}"} erase_flash
  "${ESPTOOL[@]}" --chip esp32 ${PORT_ARGS[@]+"${PORT_ARGS[@]}"} write_flash -z 0x1000 "$BIN"
  echo "[info] MicroPython installed. Now run ./scripts/flash-robot.sh to upload your code."
  exit 0
fi

# Default: upload student code and reboot into it.
#
# Opening the serial port resets the ESP32, so mpremote's Ctrl-C to break into
# the REPL races against the robot's boot + Wi-Fi/ESP-NOW init (during which
# Python can't be interrupted). When it loses that race you get
# "could not enter raw repl". Retrying re-runs the race and one attempt lands
# while the board is interruptible, so a small bounded retry loop is reliable.
echo "[info] Uploading main.py + minibot.py"
UPLOAD_TRIES=5
uploaded=0
for (( try=1; try<=UPLOAD_TRIES; try++ )); do
  if "${MPREMOTE[@]}" ${MPR_DEV[@]+"${MPR_DEV[@]}"} fs cp "${PROJ}/minibot.py" "${PROJ}/main.py" : ; then
    uploaded=1
    break
  fi
  if (( try < UPLOAD_TRIES )); then
    echo "[warn] Couldn't reach the board (attempt ${try}/${UPLOAD_TRIES}); the running program may be blocking the REPL. Retrying..." >&2
    sleep 1
  fi
done

if (( ! uploaded )); then
  echo "[error] Could not upload after ${UPLOAD_TRIES} tries: mpremote can't interrupt the program running on the robot." >&2
  echo "        Try again — if it keeps failing, hold the board's BOOT button while you start this script," >&2
  echo "        or reflash the MicroPython runtime with:  ./scripts/flash-robot.sh --firmware" >&2
  exit 1
fi

"${MPREMOTE[@]}" ${MPR_DEV[@]+"${MPR_DEV[@]}"} reset
echo "[info] Uploaded and reset. Use --repl to watch output."
