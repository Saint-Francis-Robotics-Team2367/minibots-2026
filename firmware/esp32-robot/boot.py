# boot.py — runs before main.py on every power-up.
#
# You normally do NOT need to edit this file. The Minibot library sets up
# Wi-Fi/ESP-NOW itself in begin(); we just make sure the board doesn't try to
# auto-connect to a saved Wi-Fi access point (which would fight ESP-NOW for
# the radio channel).

import network

_ap = network.WLAN(network.AP_IF)
_ap.active(False)  # ESP-NOW uses the STA interface only.
