"""ESP-NOW communication module for MiniCore robot framework.

Handles all wireless communication with the driver station: message dispatch,
calibration persistence, enable/failsafe state machine.

Wire protocol: firmware/common/minicore_protocol.h is the single source of truth
for every packet layout here.
"""

import json
import os
import struct
import time

import espnow
import network

# --- Protocol constants (keep in sync with firmware/common/minicore_protocol.h) ---
MC_MSG_JOYSTICK = 0x01
MC_MSG_ENABLE = 0x02
MC_MSG_HEARTBEAT = 0x03
MC_MSG_DISCOVERY_REQ = 0x04
MC_MSG_DISCOVERY_RESP = 0x05
MC_MSG_SET_NEUTRAL = 0x06
MC_MSG_NEUTRAL_ACK = 0x07
MC_MSG_SET_SPEED_LIMIT = 0x08
MC_MSG_SPEED_LIMIT_ACK = 0x09

MC_ROBOT_ID_MAX = 16
MC_HEARTBEAT_INTERVAL_MS = 1000
MC_MOTOR_TIMEOUT_MS = 250

# The enable flag expires unless the driver station keeps re-asserting it. Without
# this, "enabled" is a latch the robot holds forever: a robot that is out of range
# or powered down at the moment the station disables never hears it, and comes
# back still enabled. The station re-broadcasts enable ~every 500 ms while armed,
# so this tolerates several consecutive lost broadcasts (ESP-NOW broadcasts are
# unacknowledged) before standing the robot down.
MC_ENABLE_TIMEOUT_MS = 3000

_BROADCAST = b"\xff\xff\xff\xff\xff\xff"

# struct formats (little-endian, packed). Sizes are asserted below.
# fmt: off
_FMT_JOYSTICK = "<BBhhhhhhH8s"   # 24 bytes
_FMT_ENABLE = "<BB6s"            # 8 bytes
_FMT_HEARTBEAT = "<B6sB16sBB"    # 26 bytes
_FMT_DISCOVERY_REQ = "<BB"       # 2 bytes
_FMT_DISCOVERY_RESP = "<B6sB16s" # 24 bytes
_FMT_SET_NEUTRAL = "<B6sHH"      # 11 bytes
_FMT_NEUTRAL_ACK = "<B6sHHB"     # 12 bytes
_FMT_SET_SPEED_LIMIT = "<BH"     # 3 bytes
_FMT_SPEED_LIMIT_ACK = "<B6sH"   # 9 bytes
# fmt: on

assert struct.calcsize(_FMT_JOYSTICK) == 24
assert struct.calcsize(_FMT_ENABLE) == 8
assert struct.calcsize(_FMT_HEARTBEAT) == 26
assert struct.calcsize(_FMT_DISCOVERY_REQ) == 2
assert struct.calcsize(_FMT_DISCOVERY_RESP) == 24
assert struct.calcsize(_FMT_SET_NEUTRAL) == 11
assert struct.calcsize(_FMT_NEUTRAL_ACK) == 12
assert struct.calcsize(_FMT_SET_SPEED_LIMIT) == 3
assert struct.calcsize(_FMT_SPEED_LIMIT_ACK) == 9

# Remote neutral trim (driver station "Apply")
# Clamp for a neutral pulse arriving over the air: the full 1-2 ms RC window, so
# the station can express any neutral the ESC spec allows.
# Keep in sync with MC_NEUTRAL_TRIM_* in firmware/common/minicore_policy.h
_NEUTRAL_TRIM_MIN_US = 1000
_NEUTRAL_TRIM_MAX_US = 2000

# Where a station-applied calibration is saved so it survives a reset
_CALIB_PATH = "calib.json"

# How many heartbeats after boot also carry an unsolicited calibration announce.
_CALIB_ANNOUNCE_COUNT = 3

# Global speed limit cap
_SPEED_LIMIT_MIN = 0.10
_SPEED_LIMIT_MAX = 1.00


def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class CommModule:
    """Handles all ESP-NOW communication with the driver station."""

    # Type hints for all instance attributes
    _robot_id: str
    _channel: int
    _sta: object
    _espnow: espnow.ESPNow | None
    _mac: bytes
    _dongle_mac: bytes | None
    _enabled: bool
    # No annotation on the tick fields: time.ticks_ms() returns an opaque
    # counter, not an int (it is free to wrap), so only ticks_diff() may be
    # used on these. Annotating them "int" is what made int(ticks_ms()) look
    # necessary, and int() is exactly what the opaque type refuses.
    _calib_stored: bool
    _calib_announce_left: int
    _neutral_left_us: int
    _neutral_right_us: int
    _speed_limit: float
    # Joystick state (raw int16 axes, -32767..32767; neutral 0)
    _axis_lx: int
    _axis_ly: int
    _axis_rx: int
    _axis_ry: int
    _axis_lt: int
    _axis_rt: int
    _buttons: int

    def __init__(self, robot_id: str, channel: int, neutral_left_us: int = 1500, neutral_right_us: int = 1500):
        """Initialize the communication module.

        Args:
            robot_id: Unique identifier for the robot (max 16 characters)
            channel: ESP-NOW channel
            neutral_left_us: Neutral pulse width for left motor (default: 1500 us)
            neutral_right_us: Neutral pulse width for right motor (default: 1500 us)
        """
        assert len(robot_id) <= MC_ROBOT_ID_MAX, "robot_id %r is %d characters; max is %d" % (
            robot_id,
            len(robot_id),
            MC_ROBOT_ID_MAX,
        )
        self._robot_id = robot_id
        self._channel = channel

        # Joystick state (raw int16 axes)
        self._axis_lx = 0
        self._axis_ly = 0
        self._axis_rx = 0
        self._axis_ry = 0
        self._axis_lt = 0
        self._axis_rt = 0
        self._buttons = 0

        self._enabled = False
        now = time.ticks_ms()
        self._last_enable_ms = now
        self._last_joystick_ms = now
        self._last_hb_ms = now

        # Calibration state
        self._calib_stored = True
        self._calib_announce_left = _CALIB_ANNOUNCE_COUNT
        self._neutral_left_us = _clamp(neutral_left_us, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)
        self._neutral_right_us = _clamp(neutral_right_us, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)

        # WiFi and ESP-NOW
        self._sta = None
        self._espnow = None
        self._mac = b"\x00" * 6
        self._dongle_mac = None  # learned lazily from first received frame

        # Speed limit (unrestricted until a station says otherwise)
        self._speed_limit = _SPEED_LIMIT_MAX

    def begin(self):
        """Bring up Wi-Fi and ESP-NOW. Call once before update()."""
        self._load_calibration()

        # Wi-Fi STA on the shared channel (no AP association; ESP-NOW only).
        self._sta = network.WLAN(network.STA_IF)
        self._sta.active(True)
        self._sta.disconnect()
        try:
            self._sta.config(channel=self._channel)
        except OSError:
            # Some ports require the channel be set via ESP-NOW peer instead
            pass
        self._mac = self._sta.config("mac")

        self._espnow = espnow.ESPNow()
        self._espnow.active(True)
        # Broadcast peer is required before we can send heartbeats/discovery.
        self._add_peer(_BROADCAST)

        now = time.ticks_ms()
        self._last_joystick_ms = now
        self._last_enable_ms = now
        self._last_hb_ms = now

    def update(self, now) -> dict:
        """Process inbound messages, handle timeouts, send heartbeats.

        Call this at the top of your loop before reading inputs or driving motors.

        Args:
            now: A time.ticks_ms() value. Only compared with ticks_diff(),
                never used as a plain integer.

        Returns:
            A dict with status info:
            {
                "enabled": bool,
                "joystick_stale": bool,
            }
        """
        # Drain all pending ESP-NOW frames without blocking.
        while True:
            assert self._espnow
            mac, msg = self._espnow.irecv(0)
            if mac is None:
                break
            if msg:
                self._handle(mac, bytes(msg))

        # Let the enable flag lapse if the station has gone quiet.
        if self._enabled and time.ticks_diff(now, self._last_enable_ms) > MC_ENABLE_TIMEOUT_MS:
            self._enabled = False

        # Check if joystick input is stale
        joystick_stale = time.ticks_diff(now, self._last_joystick_ms) > MC_MOTOR_TIMEOUT_MS

        # Drop the cached axes on the same condition that stops the motors, so a
        # main.py driving straight from the sticks cannot be handed the
        # last-known (possibly full-throttle) values from before the link
        # dropped -- it would undo the stop on the very next line. The axes live
        # here, so the zeroing has to happen here; Minibot.update() can only see
        # the flags this returns.
        if not self._enabled or joystick_stale:
            self._zero_inputs()

        # Heartbeat so the dongle/web UI knows we're alive.
        if time.ticks_diff(now, self._last_hb_ms) >= MC_HEARTBEAT_INTERVAL_MS:
            self._last_hb_ms = now
            self._send_heartbeat()
            # Ride the first few heartbeats with our calibration
            if self._calib_announce_left > 0:
                self._calib_announce_left -= 1
                self._send_neutral_ack(self._link_target())

        return {
            "enabled": self._enabled,
            "joystick_stale": joystick_stale,
        }

    # --- Getters -----------------------------------------------------------------

    def is_enabled(self) -> bool:
        """Check if robot is enabled by driver station."""
        return self._enabled

    def is_connected_to_dongle(self) -> bool:
        """Check if we have heard from the dongle (discovered its MAC)."""
        return self._dongle_mac is not None

    def get_robot_id(self) -> str:
        """Return the robot id."""
        return self._robot_id

    def get_joystick_axes(self):
        """Return current joystick input as tuple (lx, ly, rx, ry, lt, rt, buttons)."""
        return (self._axis_lx, self._axis_ly, self._axis_rx, self._axis_ry, self._axis_lt, self._axis_rt, self._buttons)

    def get_left_x(self) -> int:
        return self._axis_lx

    def get_left_y(self) -> int:
        return self._axis_ly

    def get_right_x(self) -> int:
        return self._axis_rx

    def get_right_y(self) -> int:
        return self._axis_ry

    def get_left_trigger(self) -> int:
        return self._axis_lt

    def get_right_trigger(self) -> int:
        return self._axis_rt

    def get_buttons(self) -> int:
        return self._buttons

    def get_neutral_left_us(self) -> int:
        return self._neutral_left_us

    def get_neutral_right_us(self) -> int:
        return self._neutral_right_us

    def get_speed_limit(self) -> float:
        return self._speed_limit

    # --- Setters -----------------------------------------------------------------

    def set_neutral(self, left_us: int, right_us: int) -> bool:
        """Update neutral pulse widths. Returns True if saved to disk."""
        self._neutral_left_us = _clamp(left_us, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)
        self._neutral_right_us = _clamp(right_us, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)
        return self._save_calibration()

    def set_speed_limit(self, limit_milli: int) -> None:
        """Update speed limit from driver station."""
        self._speed_limit = _clamp(limit_milli / 1000.0, _SPEED_LIMIT_MIN, _SPEED_LIMIT_MAX)

    def clear_calibration(self) -> bool:
        """Forget the saved calibration; defaults win at the next boot."""
        try:
            os.remove(_CALIB_PATH)
            return True
        except OSError:
            return False

    # --- Internals ---------------------------------------------------------------

    def _zero_inputs(self):
        self._axis_lx = 0
        self._axis_ly = 0
        self._axis_rx = 0
        self._axis_ry = 0
        self._axis_lt = 0
        self._axis_rt = 0
        self._buttons = 0

    def _add_peer(self, mac):
        try:
            assert self._espnow
            self._espnow.add_peer(mac, channel=self._channel)
        except OSError:
            # Already added — ESP-NOW raises if the peer exists.
            pass

    def _send(self, mac, payload):
        self._add_peer(mac)
        try:
            assert self._espnow
            self._espnow.send(mac, payload)
        except OSError:
            pass

    def _handle(self, mac, data):
        if len(data) < 1:
            return
        # Learn the dongle's MAC from the first frame we hear.
        if self._dongle_mac is None:
            self._dongle_mac = bytes(mac)
            self._calib_announce_left = _CALIB_ANNOUNCE_COUNT

        msg_type = data[0]
        if msg_type == MC_MSG_SET_NEUTRAL:
            self._handle_set_neutral(mac, data)
        elif msg_type == MC_MSG_SET_SPEED_LIMIT:
            self._handle_set_speed_limit(mac, data)
        elif msg_type == MC_MSG_DISCOVERY_REQ:
            self._send_discovery_resp(mac)
            self._send_neutral_ack(mac)
            self._send_speed_limit_ack(mac)
        elif msg_type == MC_MSG_ENABLE:
            self._handle_enable(data)
        elif msg_type == MC_MSG_JOYSTICK:
            self._handle_joystick(data)

    def _handle_enable(self, data):
        if len(data) < struct.calcsize(_FMT_ENABLE):
            return
        _, enabled, target_mac = struct.unpack(_FMT_ENABLE, data[: struct.calcsize(_FMT_ENABLE)])
        if target_mac == _BROADCAST or target_mac == self._mac:
            self._enabled = enabled != 0
            if self._enabled:
                self._last_enable_ms = time.ticks_ms()

    def _handle_joystick(self, data):
        n = struct.calcsize(_FMT_JOYSTICK)
        if len(data) < n:
            return
        (_, _seq, lx, ly, rx, ry, lt, rt, buttons, _aux) = struct.unpack(_FMT_JOYSTICK, data[:n])
        self._axis_lx = lx
        self._axis_ly = ly
        self._axis_rx = rx
        self._axis_ry = ry
        self._axis_lt = lt
        self._axis_rt = rt
        self._buttons = buttons
        self._last_joystick_ms = time.ticks_ms()

    def _handle_set_neutral(self, mac, data):
        n = struct.calcsize(_FMT_SET_NEUTRAL)
        if len(data) < n:
            return
        _, target_mac, left_us, right_us = struct.unpack(_FMT_SET_NEUTRAL, data[:n])
        # Addressed to us specifically -- a broadcast is refused outright
        if target_mac != self._mac:
            return

        self._neutral_left_us = _clamp(left_us, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)
        self._neutral_right_us = _clamp(right_us, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)

        self._calib_stored = self._save_calibration()
        self._send_neutral_ack(mac)

    def _handle_set_speed_limit(self, mac, data):
        n = struct.calcsize(_FMT_SET_SPEED_LIMIT)
        if len(data) < n:
            return
        _, limit_milli = struct.unpack(_FMT_SET_SPEED_LIMIT, data[:n])

        self._speed_limit = _clamp(limit_milli / 1000.0, _SPEED_LIMIT_MIN, _SPEED_LIMIT_MAX)
        self._send_speed_limit_ack(mac)

    def _load_calibration(self):
        """Apply a saved station calibration over the defaults, if present."""
        try:
            with open(_CALIB_PATH) as f:
                saved = json.load(f)
            left = int(saved["nl"])
            right = int(saved["nr"])
        except (OSError, ValueError, KeyError, TypeError):
            return
        self._neutral_left_us = _clamp(left, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)
        self._neutral_right_us = _clamp(right, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)
        self._calib_stored = True

    def _save_calibration(self) -> bool:
        """Persist the current neutrals. True if they will survive a reset."""
        try:
            with open(_CALIB_PATH, "w") as f:
                json.dump({"nl": self._neutral_left_us, "nr": self._neutral_right_us}, f)
            return True
        except OSError:
            return False

    def _link_target(self) -> bytes:
        """Where robot -> station frames go: the dongle once we have heard from
        it, else broadcast."""
        return self._dongle_mac if self._dongle_mac is not None else _BROADCAST

    def _send_neutral_ack(self, target):
        """Report the neutrals actually in force (post-clamp) to the station."""
        ack = struct.pack(
            _FMT_NEUTRAL_ACK,
            MC_MSG_NEUTRAL_ACK,
            self._mac,
            self._neutral_left_us,
            self._neutral_right_us,
            1 if self._calib_stored else 0,
        )
        self._send(target, ack)

    def _send_speed_limit_ack(self, target):
        """Report the speed limit actually in force (post-clamp) to the station."""
        ack = struct.pack(
            _FMT_SPEED_LIMIT_ACK,
            MC_MSG_SPEED_LIMIT_ACK,
            self._mac,
            int(round(self._speed_limit * 1000.0)),
        )
        self._send(target, ack)

    def _send_discovery_resp(self, mac):
        name = self._robot_id.encode()[:MC_ROBOT_ID_MAX]
        resp = struct.pack(
            _FMT_DISCOVERY_RESP,
            MC_MSG_DISCOVERY_RESP,
            self._mac,
            len(name),
            name,  # struct pads/truncates to 16 bytes
        )
        self._send(mac, resp)

    def _send_heartbeat(self):
        name = self._robot_id.encode()[:MC_ROBOT_ID_MAX]
        hb = struct.pack(
            _FMT_HEARTBEAT,
            MC_MSG_HEARTBEAT,
            self._mac,
            len(name),
            name,
            0xFF,  # battery unknown
            1 if self._enabled else 0,
        )
        self._send(self._link_target(), hb)
