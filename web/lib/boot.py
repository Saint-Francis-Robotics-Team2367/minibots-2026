# boot.py — runs before main.py on every power-up.
#
# You normally do NOT need to edit this file. It does two jobs:
#
#   1. A brief, interruptible pause so you can always upload new code.
#      main.py runs a tight `while True` loop with the radio active, which
#      leaves no gap for the tools to break in — so fresh uploads would fail
#      with "could not enter raw repl". This pause gives mpremote (used by
#      scripts/flash-robot.*) a guaranteed window to interrupt the board and
#      drop to the REPL before main.py starts. If nothing interrupts it, the
#      robot just carries on after ~1.5 s.
#
#   2. Makes sure the board doesn't auto-connect to a saved Wi-Fi access point
#      (which would fight ESP-NOW for the radio channel). The Minibot library
#      sets up Wi-Fi/ESP-NOW itself in begin().

import sys
import time

# --- upload window: interruptible so `flash-robot` can always get in ---------
_BOOT_PAUSE_MS = 1500
try:
    print("[boot] Starting in %d ms — press Ctrl-C now to stop for upload." % _BOOT_PAUSE_MS)
    time.sleep_ms(_BOOT_PAUSE_MS)
except KeyboardInterrupt:
    # A tool (or a person) interrupted us. Skip main.py and stay at the REPL so
    # code can be uploaded; SystemExit halts startup without running main.py.
    print("[boot] Interrupted — dropping to REPL (main.py skipped).")
    raise SystemExit

import network

_ap = network.WLAN(network.AP_IF)
_ap.active(False)  # ESP-NOW uses the STA interface only.
