"""
minibot.py — MiniCore robot framework (DO NOT EDIT).

This is the library your robot's `main.py` builds on. It hides all of the
radio/communication plumbing so you can focus on *behavior* in main.py.

What it does for you:
  * Brings up Wi-Fi + ESP-NOW on the right channel and talks to the dongle.
  * Answers the driver station's discovery + enable messages.
  * Decodes the joystick packets into friendly getters (get_left_y(), etc).
  * Drives your motors as RC/ESC servo PWM (50 Hz).
  * Safety: motors are forced to neutral when the robot is disabled or when
    the radio link drops for more than 250 ms (matches the old C++ firmware).

Wire protocol: byte-for-byte identical to firmware/common/minicore_protocol.h,
so the ESP32-S3 dongle and the web driver station work unchanged.
"""

import network
import espnow
import struct
import time
from machine import Pin, PWM

# --- Protocol constants (keep in sync with firmware/common/minicore_protocol.h) ---
MC_MSG_JOYSTICK = 0x01
MC_MSG_ENABLE = 0x02
MC_MSG_HEARTBEAT = 0x03
MC_MSG_DISCOVERY_REQ = 0x04
MC_MSG_DISCOVERY_RESP = 0x05

MC_ROBOT_ID_MAX = 16
MC_HEARTBEAT_INTERVAL_MS = 1000
MC_MOTOR_TIMEOUT_MS = 250

_BROADCAST = b"\xff\xff\xff\xff\xff\xff"

# struct formats (little-endian, packed). Sizes are asserted below.
_FMT_JOYSTICK = "<BBhhhhhhH8s"   # 24 bytes
_FMT_ENABLE = "<BB6s"            # 8 bytes
_FMT_HEARTBEAT = "<B6sB16sBB"    # 26 bytes
_FMT_DISCOVERY_REQ = "<BB"       # 2 bytes
_FMT_DISCOVERY_RESP = "<B6sB16s" # 24 bytes

assert struct.calcsize(_FMT_JOYSTICK) == 24
assert struct.calcsize(_FMT_ENABLE) == 8
assert struct.calcsize(_FMT_HEARTBEAT) == 26
assert struct.calcsize(_FMT_DISCOVERY_REQ) == 2
assert struct.calcsize(_FMT_DISCOVERY_RESP) == 24

# --- PWM calibration ---
# Matched to the ESC datasheet:
#   Pulse high time  1-2 ms nominal, 1.5 ms center   -> MIN/CENTER/MAX below
#   Period           2.9-100 ms (~10-345 Hz)         -> 50 Hz = 20 ms, mid-range
#   Logic high min   1.0 V / low max 0.4 V           -> ESP32 drives 0/3.3 V, fine
#   Input current    <1 mA                           -> direct GPIO, no buffer
#   Deadband         4% default (0.1-25% adjustable) -> see _DEADBAND note
#
# NOTE: the retired C++ firmware used 1758us +/- 391us (clamp 1000-2500us). The
# very old Arduino library wrote LEDC duty 90 on a 10-bit 50 Hz timer
# (90 / 1024 * 20000us = 1757.8us); that was a trim value for *that* hardware's
# ESCs, not a real neutral -- the servo helper in the same old file used
# `0.01 * angle + 1.5`, i.e. 1500us at rest. Carrying 1758us over meant every
# robot held ~50% throttle at "neutral" and the wheels spun on power-up, and the
# 2500us clamp allowed pulses 500us past this ESC's 2 ms maximum.
# If your ESCs need a different center, pass neutral_us= (see Minibot.__init__).
_PWM_FREQ_HZ = 50
_PWM_CENTER_US = 1500   # neutral pulse width (motors stopped)
_PWM_RANGE_US = 500     # +/- swing at full stick
_PWM_MIN_US = 1000
_PWM_MAX_US = 2000

# Stick deadband, as a fraction of full travel (carried over from the old
# firmware's `if (abs(axis) < 2000) axis = 0`). This is a *stick* deadband, so a
# controller resting off-center doesn't make the robot creep; it is separate
# from -- and wider than -- the ESC's own 4% throttle deadband (+/-20us of the
# 500us travel), so the ESC's deadband is fully covered either way.
_DEADBAND = 2000.0 / 32767.0  # ~6.1% of stick travel = +/-30.5us of pulse


def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def _us_to_duty_u16(us):
    """Convert a servo pulse width (microseconds) to MicroPython's 16-bit duty.

    We work in duty_u16 rather than duty_ns because duty_ns is rejected in the
    PWM() constructor on the ESP32 port ("PWM is inactive" — it needs a timer
    that isn't assigned yet), and we must set neutral in the constructor. See
    _init_motor_pwm().
    """
    return int((us * 65536 * _PWM_FREQ_HZ + 500000) // 1000000)


class Minibot:
    """The robot. Create one in main.py, call begin(), then call update()
    at the top of your loop before reading inputs or driving motors."""

    # Game status values returned by get_game_status()
    STANDBY = 0
    TELEOP = 1

    def __init__(self, robot_id, left_motor_pin=16, right_motor_pin=17, channel=6,
                 neutral_us=_PWM_CENTER_US, range_us=_PWM_RANGE_US):
        """neutral_us / range_us calibrate the ESC pulse widths.

        Defaults match the ESC datasheet: 1500 us center, +/- 500 us at full
        stick (1-2 ms). If your robot creeps when the sticks are centered, nudge
        neutral_us until it sits still (see the calibration note in main.py).
        """
        self._robot_id = robot_id[:MC_ROBOT_ID_MAX]
        self._left_pin = left_motor_pin
        self._right_pin = right_motor_pin
        self._channel = channel
        # Keep the calibration inside the ESC's 1-2 ms pulse window: a typo here
        # would otherwise be driven straight to the motors as a real command.
        self._neutral_us = _clamp(neutral_us, _PWM_MIN_US, _PWM_MAX_US)
        self._range_us = _clamp(range_us, 0, _PWM_RANGE_US)

        # Controller state (raw int16 axes, -32767..32767; neutral 0)
        self._axis_lx = 0
        self._axis_ly = 0
        self._axis_rx = 0
        self._axis_ry = 0
        self._axis_lt = 0
        self._axis_rt = 0
        self._buttons = 0

        self._enabled = False
        self._last_joystick_ms = 0
        self._last_hb_ms = 0

        self._sta = None
        self._espnow = None
        self._mac = b"\x00" * 6
        self._dongle_mac = None  # learned lazily from first received frame

        self._left_pwm = None
        self._right_pwm = None

    # --- lifecycle -----------------------------------------------------------

    def begin(self):
        """Bring up the motor outputs, Wi-Fi and ESP-NOW. Call once."""
        # Motors FIRST, at neutral: bringing up Wi-Fi takes a moment, and until
        # a PWM channel drives these pins they float, which some ESCs latch onto
        # as a throttle command. Get a valid neutral pulse train out immediately.
        self._left_pwm = self._init_motor_pwm(self._left_pin)
        self._right_pwm = self._init_motor_pwm(self._right_pin)
        self.stop_all_motors()

        # Wi-Fi STA on the shared channel (no AP association; ESP-NOW only).
        self._sta = network.WLAN(network.STA_IF)
        self._sta.active(True)
        self._sta.disconnect()
        try:
            self._sta.config(channel=self._channel)
        except OSError:
            # Some ports require the channel be set via ESP-NOW peer instead;
            # add_peer(channel=...) below still pins it.
            pass
        self._mac = self._sta.config("mac")

        self._espnow = espnow.ESPNow()
        self._espnow.active(True)
        # Broadcast peer is required before we can send heartbeats/discovery.
        self._add_peer(_BROADCAST)

        now = time.ticks_ms()
        self._last_joystick_ms = now
        self._last_hb_ms = now

    # --- main loop step ------------------------------------------------------

    def update(self):
        """Call FIRST each loop. Drains the radio, applies enable/failsafe,
        and sends periodic heartbeats."""
        # Drain all pending ESP-NOW frames without blocking.
        while True:
            mac, msg = self._espnow.irecv(0)
            if mac is None:
                break
            if msg:
                self._handle(mac, bytes(msg))

        now = time.ticks_ms()

        # Failsafe: neutral motors when disabled or link is stale. Also zero the
        # cached axes, so a main.py that drives from the sticks can't be handed
        # the last-known (possibly full-throttle) values from before the link
        # dropped — otherwise it would immediately undo this stop.
        if not self._enabled or time.ticks_diff(now, self._last_joystick_ms) > MC_MOTOR_TIMEOUT_MS:
            self._zero_inputs()
            self.stop_all_motors()

        # Heartbeat so the dongle/web UI knows we're alive.
        if time.ticks_diff(now, self._last_hb_ms) >= MC_HEARTBEAT_INTERVAL_MS:
            self._last_hb_ms = now
            self._send_heartbeat()

    # --- inputs (normalized -1.0..1.0) --------------------------------------

    def _stick(self, raw):
        """Normalize a stick axis and swallow the resting-center jitter."""
        value = raw / 32767.0
        return 0.0 if -_DEADBAND < value < _DEADBAND else value

    def get_left_x(self):
        return self._stick(self._axis_lx)

    def get_left_y(self):
        return self._stick(self._axis_ly)

    def get_right_x(self):
        return self._stick(self._axis_rx)

    def get_right_y(self):
        return self._stick(self._axis_ry)

    def get_left_trigger(self):
        return self._axis_lt / 32767.0

    def get_right_trigger(self):
        return self._axis_rt / 32767.0

    # --- buttons (True when pressed) ----------------------------------------

    def get_cross(self):
        return bool(self._buttons & (1 << 0))

    def get_circle(self):
        return bool(self._buttons & (1 << 1))

    def get_square(self):
        return bool(self._buttons & (1 << 2))

    def get_triangle(self):
        return bool(self._buttons & (1 << 3))

    # --- game status ---------------------------------------------------------

    def get_game_status(self):
        """TELEOP when the driver station has enabled this robot, else STANDBY."""
        return Minibot.TELEOP if self._enabled else Minibot.STANDBY

    # --- motors (value -1.0..1.0) -------------------------------------------

    def drive_left_motor(self, value):
        self._motor_write(self._left_pwm, value)

    def drive_right_motor(self, value):
        self._motor_write(self._right_pwm, value)

    def stop_all_motors(self):
        self._pulse_us(self._left_pwm, self._neutral_us)
        self._pulse_us(self._right_pwm, self._neutral_us)

    # --- internals -----------------------------------------------------------

    def _zero_inputs(self):
        self._axis_lx = 0
        self._axis_ly = 0
        self._axis_rx = 0
        self._axis_ry = 0
        self._axis_lt = 0
        self._axis_rt = 0
        self._buttons = 0

    def _init_motor_pwm(self, pin):
        """Create a motor PWM that is already at neutral on its first output edge.

        The duty MUST be passed to the PWM() constructor. If it isn't, the ESP32
        port defaults the channel to duty_u16 = 32768 (50% of a 20 ms period =
        a 10 ms pulse). ESCs read that as far beyond full throttle, so the wheels
        spin the instant begin() runs — before the radio is even up. Setting the
        duty afterwards is too late: the pin is already driving.
        """
        return PWM(
            Pin(pin),
            freq=_PWM_FREQ_HZ,
            duty_u16=_us_to_duty_u16(self._neutral_us),
        )

    def _motor_write(self, pwm, value):
        value = _clamp(value, -1.0, 1.0)
        self._pulse_us(pwm, self._neutral_us + int(value * self._range_us))

    def _pulse_us(self, pwm, us):
        if pwm is None:
            return
        us = _clamp(us, _PWM_MIN_US, _PWM_MAX_US)
        pwm.duty_u16(_us_to_duty_u16(us))

    def _add_peer(self, mac):
        try:
            self._espnow.add_peer(mac, channel=self._channel)
        except OSError:
            # Already added — ESP-NOW raises if the peer exists.
            pass

    def _send(self, mac, payload):
        self._add_peer(mac)
        try:
            self._espnow.send(mac, payload)
        except OSError:
            pass

    def _handle(self, mac, data):
        if len(data) < 1:
            return
        # Learn the dongle's MAC from the first frame we hear.
        if self._dongle_mac is None:
            self._dongle_mac = bytes(mac)

        msg_type = data[0]
        if msg_type == MC_MSG_DISCOVERY_REQ:
            self._send_discovery_resp(mac)
        elif msg_type == MC_MSG_ENABLE:
            self._handle_enable(data)
        elif msg_type == MC_MSG_JOYSTICK:
            self._handle_joystick(data)

    def _handle_enable(self, data):
        if len(data) < struct.calcsize(_FMT_ENABLE):
            return
        _, enabled, target_mac = struct.unpack(_FMT_ENABLE, data[:struct.calcsize(_FMT_ENABLE)])
        if target_mac == _BROADCAST or target_mac == self._mac:
            self._enabled = enabled != 0

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
        target = self._dongle_mac if self._dongle_mac is not None else _BROADCAST
        self._send(target, hb)
