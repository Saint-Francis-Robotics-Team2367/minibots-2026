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
# On first run this installs its own tools (esptool + mpremote via pip) — no
# separate setup step. The check is idempotent, so later runs are instant.
#
# Students normally edit firmware/esp32-robot/main.py, then run ./scripts/flash-robot.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="${ROOT}/firmware/esp32-robot"
MPY_DIR="${PROJ}/micropython"

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

OS="$(uname -s)"
have() { command -v "$1" >/dev/null 2>&1; }
have_esptool() { have esptool.py || have esptool; }

# --- ensure flash tools (esptool + mpremote) — first-run setup, then a no-op ---
ensure_tools() {
  if have_esptool && have mpremote; then
    return
  fi
  command -v python3 >/dev/null 2>&1 || {
    echo "[error] python3 not found. Install Python 3 and re-run (needed to install esptool + mpremote)." >&2
    exit 1
  }
  echo "[info] Installing esptool + mpremote via pip (one time)"
  python3 -m pip install --user --upgrade esptool mpremote \
    || { echo "[error] pip install esptool mpremote failed. Try: python3 -m pip install --user esptool mpremote" >&2; exit 1; }

  # pip's --user scripts may not be on PATH in this shell yet; add the usual dir
  # so the freshly-installed tools are usable without opening a new terminal.
  if ! have mpremote; then
    USER_BIN="$(python3 -c 'import site,os; print(os.path.join(site.getuserbase(), "bin"))' 2>/dev/null || true)"
    [[ -n "$USER_BIN" && -d "$USER_BIN" ]] && export PATH="$USER_BIN:$PATH"
  fi
  if ! have mpremote; then
    echo "[error] 'mpremote' installed but not on PATH. Add your pip user bin dir to PATH, e.g.:" >&2
    case "$OS" in
      Darwin) echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" >&2 ;;
      *)      echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" >&2 ;;
    esac
    exit 1
  fi
}

(( SKIP_SETUP )) || ensure_tools

have_esptool || { echo "[error] 'esptool' not found (try without --skip-setup)." >&2; exit 1; }
have mpremote || { echo "[error] 'mpremote' not found (try without --skip-setup)." >&2; exit 1; }
ESPTOOL="$(command -v esptool.py || command -v esptool)"

# mpremote device selector, e.g. "connect COM5" / "connect /dev/cu.xxx"
MPR_DEV=()
[[ -n "$PORT" ]] && MPR_DEV=(connect "$PORT")

if (( DO_REPL )); then
  exec mpremote "${MPR_DEV[@]}" repl
fi

if (( DO_FIRMWARE )); then
  BIN="$(ls -1 "${MPY_DIR}"/ESP32_GENERIC-*.bin 2>/dev/null | sort | tail -n1 || true)"
  [[ -n "$BIN" ]] || {
    echo "[error] No ESP32_GENERIC-*.bin in ${MPY_DIR}." >&2
    echo "        Download it from https://micropython.org/download/ESP32_GENERIC/" >&2
    echo "        (see ${MPY_DIR}/README.md) and place it there." >&2
    exit 1
  }
  PORT_ARGS=()
  [[ -n "$PORT" ]] && PORT_ARGS=(--port "$PORT")
  echo "[info] Flashing MicroPython: $(basename "$BIN")"
  "$ESPTOOL" --chip esp32 "${PORT_ARGS[@]}" erase_flash
  "$ESPTOOL" --chip esp32 "${PORT_ARGS[@]}" write_flash -z 0x1000 "$BIN"
  echo "[info] MicroPython installed. Now run ./scripts/flash-robot.sh to upload your code."
  exit 0
fi

# Default: upload student code and reboot into it.
echo "[info] Uploading main.py + minibot.py"
mpremote "${MPR_DEV[@]}" fs cp "${PROJ}/minibot.py" "${PROJ}/main.py" :
mpremote "${MPR_DEV[@]}" reset
echo "[info] Uploaded and reset. Use --repl to watch output."
