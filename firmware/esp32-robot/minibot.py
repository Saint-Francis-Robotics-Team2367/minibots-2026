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

import json
import network
import espnow
import os
import struct
import time
from machine import Pin, PWM

# --- Protocol constants (keep in sync with firmware/common/minicore_protocol.h) ---
MC_MSG_JOYSTICK = 0x01
MC_MSG_ENABLE = 0x02
MC_MSG_HEARTBEAT = 0x03
MC_MSG_DISCOVERY_REQ = 0x04
MC_MSG_DISCOVERY_RESP = 0x05
MC_MSG_SET_NEUTRAL = 0x06
MC_MSG_NEUTRAL_ACK = 0x07

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
_FMT_JOYSTICK = "<BBhhhhhhH8s"   # 24 bytes
_FMT_ENABLE = "<BB6s"            # 8 bytes
_FMT_HEARTBEAT = "<B6sB16sBB"    # 26 bytes
_FMT_DISCOVERY_REQ = "<BB"       # 2 bytes
_FMT_DISCOVERY_RESP = "<B6sB16s" # 24 bytes
_FMT_SET_NEUTRAL = "<B6sHH"      # 11 bytes
_FMT_NEUTRAL_ACK = "<B6sHHB"     # 12 bytes

assert struct.calcsize(_FMT_JOYSTICK) == 24
assert struct.calcsize(_FMT_ENABLE) == 8
assert struct.calcsize(_FMT_HEARTBEAT) == 26
assert struct.calcsize(_FMT_DISCOVERY_REQ) == 2
assert struct.calcsize(_FMT_DISCOVERY_RESP) == 24
assert struct.calcsize(_FMT_SET_NEUTRAL) == 11
assert struct.calcsize(_FMT_NEUTRAL_ACK) == 12

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

# --- Remote neutral trim (driver station "Apply") ---
# Clamp for a neutral pulse arriving over the air, deliberately much tighter than
# the 1000-2000 us the constructor allows. A neutral set in main.py is a number a
# student reads in context; one arriving from a web text box is not, and
# neutral_us = 2000 would make "motors stopped" mean full forward. Real ESC trim
# is +/-30-50 us, so +/-100 us is generous and bounds a typo to about 20%
# throttle instead of 100%. Keep in sync with MC_NEUTRAL_TRIM_* in
# firmware/common/minicore_protocol.h.
_NEUTRAL_TRIM_MIN_US = 1400
_NEUTRAL_TRIM_MAX_US = 1600

# Where a station-applied calibration is saved so it survives a reset -- notably
# a brownout mid-match, which is exactly when losing the trim would be worst.
# JSON rather than packed bytes so it can be read, edited or deleted from the
# REPL; the file is a few dozen bytes either way.
_CALIB_PATH = "calib.json"

# How many heartbeats after boot also carry an unsolicited calibration announce.
# The station needs the robot's real neutrals to fill its fields, and either side
# may come up first. Repeating covers the broadcast fallback below, which is
# unacknowledged and may be lost; three is ~3 s at the heartbeat interval.
_CALIB_ANNOUNCE_COUNT = 3

# Stick deadband, as a fraction of full travel (carried over from the old
# firmware's `if (abs(axis) < 2000) axis = 0`). This is a *stick* deadband, so a
# controller resting off-center doesn't make the robot creep; it is separate
# from -- and wider than -- the ESC's own 4% throttle deadband (+/-20us of the
# 500us travel), so the ESC's deadband is fully covered either way.
_DEADBAND = 2000.0 / 32767.0  # ~6.1% of stick travel = +/-30.5us of pulse

# --- Motor slew rate ---
# Cap on how fast a motor command may change, in units of stick travel per
# second. Full travel is 2.0 units (-1..1), so 4.0/s = 500 ms for a full
# forward->reverse reversal.
#
# This is a current limit, not a feel preference. A brushed motor draws
# (V_applied - V_bemf) / R. Slamming from full forward to full reverse flips
# V_applied while V_bemf is still positive, so the two add: roughly twice stall
# current, pulled through the pack's internal resistance. The rail sags and the
# ESP32's brownout detector resets the board mid-match, which reads at the driver
# station as the robot dropping its connection (a reset costs ~3 s: MicroPython's
# own boot plus boot.py's upload pause, well past the station's 2.5 s heartbeat
# staleness threshold). Ramping the command keeps V_applied close to V_bemf as
# the motor sheds speed, so the difference -- and the current -- stays bounded.
#
# The ramp must be slow relative to how fast the drivetrain can actually
# decelerate. Below roughly 300 ms per reversal the back-EMF has not decayed and
# most of the spike survives, so lowering this past that point buys nothing.
#
# Deliberately NOT a Minibot(...) parameter. This protects the hardware rather
# than shaping behavior, and main.py is the file students edit: an override there
# is a way to brown a board out by accident, or to "fix" a robot that feels
# sluggish by deleting the thing keeping it alive. Retune it here, in the
# library, and it applies to every robot on the field.
_SLEW_PER_S = 4.0

# Longest interval a single slew step may claim. Without a cap, code that stops
# driving a motor for a while (a standby period, a slow loop) banks a step budget
# big enough to jump straight to the target on the next call -- precisely the
# step this exists to prevent. Erring short only makes the ramp gentler.
_SLEW_MAX_DT_MS = 50


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
                 range_us=_PWM_RANGE_US,
                 neutral_left_us=None, neutral_right_us=None):
        """Calibrate ESC pulse widths per motor.

        neutral_left_us / neutral_right_us set the neutral (stopped) pulse for each
        motor independently. Defaults are 1500 us (RC standard). If your motors
        creep when the sticks are centered, adjust these until they sit still
        (see the calibration note in main.py).

        range_us is the ±swing at full stick (default 500 us, total 1000-2000 us).

        The motor slew limit is not settable here on purpose -- it is fixed at
        _SLEW_PER_S so robot code cannot opt out of it. See the note there.
        """
        self._robot_id = robot_id[:MC_ROBOT_ID_MAX]
        self._left_pin = left_motor_pin
        self._right_pin = right_motor_pin
        self._channel = channel
        # Keep the calibration inside the ESC's 1-2 ms pulse window: a typo here
        # would otherwise be driven straight to the motors as a real command.
        self._range_us = _clamp(range_us, 0, _PWM_RANGE_US)
        # Per-motor calibration
        self._neutral_left_us = _clamp(neutral_left_us, _PWM_MIN_US, _PWM_MAX_US) if neutral_left_us is not None else _PWM_CENTER_US
        self._neutral_right_us = _clamp(neutral_right_us, _PWM_MIN_US, _PWM_MAX_US) if neutral_right_us is not None else _PWM_CENTER_US

        # Controller state (raw int16 axes, -32767..32767; neutral 0)
        self._axis_lx = 0
        self._axis_ly = 0
        self._axis_rx = 0
        self._axis_ry = 0
        self._axis_lt = 0
        self._axis_rt = 0
        self._buttons = 0

        self._enabled = False
        self._last_enable_ms = 0
        self._last_joystick_ms = 0
        self._last_hb_ms = 0

        # "Will these exact neutrals still be in force after a reset?" True for
        # the constructor values, since main.py reproduces them every boot; set
        # from the file on load, and cleared only when a save actually fails.
        self._calib_stored = True
        self._calib_announce_left = _CALIB_ANNOUNCE_COUNT

        self._sta = None
        self._espnow = None
        self._mac = b"\x00" * 6
        self._dongle_mac = None  # learned lazily from first received frame

        self._left_pwm = None
        self._right_pwm = None

        # Rate-limited motor state. _out_* is what we last actually commanded,
        # which the limiter has to remember to know how far it may step next.
        # The rate itself is the fixed _SLEW_PER_S, not per-robot state.
        self._out_left = 0.0
        self._out_right = 0.0
        self._slew_ms_left = time.ticks_ms()
        self._slew_ms_right = self._slew_ms_left

    # --- lifecycle -----------------------------------------------------------

    def begin(self):
        """Bring up the motor outputs, Wi-Fi and ESP-NOW. Call once."""
        # Saved calibration BEFORE the PWM channels exist. _init_motor_pwm has to
        # be handed the final neutral: the duty passed to the PWM() constructor
        # is the first thing the ESC sees, and correcting it afterwards is too
        # late (see the note there).
        self._load_calibration()

        # Motors FIRST, at neutral: bringing up Wi-Fi takes a moment, and until
        # a PWM channel drives these pins they float, which some ESCs latch onto
        # as a throttle command. Get a valid neutral pulse train out immediately.
        self._left_pwm = self._init_motor_pwm(self._left_pin, self._neutral_left_us)
        self._right_pwm = self._init_motor_pwm(self._right_pin, self._neutral_right_us)
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
        self._last_enable_ms = now
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

        # Let the enable flag lapse if the station has gone quiet. This is what
        # keeps "enabled" from being a latch the robot holds across a driver
        # station reload, a closed tab, or its own trip out of radio range.
        if self._enabled and time.ticks_diff(now, self._last_enable_ms) > MC_ENABLE_TIMEOUT_MS:
            self._enabled = False

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
            # Ride the first few heartbeats with our calibration, so the driver
            # station can fill its fields with what we are actually running
            # without anyone clicking Scan. Same target as the heartbeat, which
            # falls back to broadcast until we have heard the dongle -- the case
            # where no unicast traffic has reached us yet (a slot paired to us
            # but with no gamepad selected sends nothing).
            if self._calib_announce_left > 0:
                self._calib_announce_left -= 1
                self._send_neutral_ack(self._link_target())

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
        self._out_left, self._slew_ms_left = self._slew(
            self._out_left, value, self._slew_ms_left)
        self._motor_write(self._left_pwm, self._out_left, self._neutral_left_us)

    def drive_right_motor(self, value):
        self._out_right, self._slew_ms_right = self._slew(
            self._out_right, value, self._slew_ms_right)
        self._motor_write(self._right_pwm, self._out_right, self._neutral_right_us)

    def stop_all_motors(self):
        """Cut both motors to neutral immediately -- never ramped.

        The slew limiter deliberately does not apply here. update() calls this
        when the robot is disabled or the link goes stale, and a stop that eases
        off is not a stop. Clearing the limiter's state matters as much as the
        pulse does: leave _out_* at the pre-stop value and the next
        drive_*_motor() ramps from a throttle the motors are no longer at,
        stepping straight back to most of it.
        """
        self._out_left = 0.0
        self._out_right = 0.0
        self._slew_ms_left = time.ticks_ms()
        self._slew_ms_right = self._slew_ms_left
        self._pulse_us(self._left_pwm, self._neutral_left_us)
        self._pulse_us(self._right_pwm, self._neutral_right_us)

    # --- internals -----------------------------------------------------------

    def _zero_inputs(self):
        self._axis_lx = 0
        self._axis_ly = 0
        self._axis_rx = 0
        self._axis_ry = 0
        self._axis_lt = 0
        self._axis_rt = 0
        self._buttons = 0

    def _init_motor_pwm(self, pin, neutral_us):
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
            duty_u16=_us_to_duty_u16(neutral_us),
        )

    def _slew(self, cur, target, last_ms):
        """Step `cur` toward `target` at no more than _SLEW_PER_S per second.

        Returns (new_output, now_ms). The caller owns the timestamp because each
        motor needs its own: with one shared timestamp, whichever motor is
        written first in a loop consumes the whole elapsed interval and the
        second one is handed dt ~ 0, so it would never move.

        The step is time-based, not per-call. main.py runs an unbounded `while
        True` whose rate depends on the interpreter and on whatever the student
        put in the loop, so a fixed step per call would ramp at a speed nobody
        chose and would change whenever the loop body did.
        """
        now = time.ticks_ms()
        target = _clamp(target, -1.0, 1.0)
        dt_ms = _clamp(time.ticks_diff(now, last_ms), 0, _SLEW_MAX_DT_MS)
        step = _SLEW_PER_S * dt_ms / 1000.0
        return cur + _clamp(target - cur, -step, step), now

    def _motor_write(self, pwm, value, neutral_us):
        value = _clamp(value, -1.0, 1.0)
        self._pulse_us(pwm, neutral_us + int(value * self._range_us))

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
        # Learn the dongle's MAC from the first frame we hear. A link coming up
        # is also a station that knows nothing about our calibration, so re-arm
        # the announce: this is the path that covers us rebooting (brownout,
        # power cycle) into an already-running driver station.
        if self._dongle_mac is None:
            self._dongle_mac = bytes(mac)
            self._calib_announce_left = _CALIB_ANNOUNCE_COUNT

        msg_type = data[0]
        if msg_type == MC_MSG_SET_NEUTRAL:
            self._handle_set_neutral(mac, data)
        elif msg_type == MC_MSG_DISCOVERY_REQ:
            self._send_discovery_resp(mac)
            # Answer a scan with our calibration too, so the station can fill its
            # fields the moment we show up in the robot list.
            self._send_neutral_ack(mac)
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
            # Refresh the expiry only while being told "enabled" — a disable does
            # not need keeping alive, and must not extend the window.
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
        # Addressed to us specifically -- a broadcast is refused outright rather
        # than filtered. Neutral trim is per-robot ESC calibration, so applying
        # one robot's values field-wide would change what "stopped" means for
        # every other robot at once.
        if target_mac != self._mac:
            return

        self._neutral_left_us = _clamp(left_us, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)
        self._neutral_right_us = _clamp(right_us, _NEUTRAL_TRIM_MIN_US, _NEUTRAL_TRIM_MAX_US)

        # A neutral change is a step, not a ramp. The slew limiter works in
        # normalized -1..1 units and neutral is the offset those map onto, so it
        # has nothing to say here; the trim clamp bounds the step to ~20% of
        # range and this only happens on a button press, so it is left unramped.
        #
        # Re-emit immediately if the motors are already stopped, so the effect is
        # visible without touching the sticks -- watching for creep at centered
        # sticks is the entire point of calibrating.
        if self._out_left == 0.0 and self._out_right == 0.0:
            self.stop_all_motors()

        self._calib_stored = self._save_calibration()
        self._send_neutral_ack(mac)

    # --- calibration persistence ---------------------------------------------

    def _load_calibration(self):
        """Apply a saved station calibration over main.py's values, if present.

        A missing file is the ordinary first-boot case, and a corrupt one must
        not stop the robot booting -- either way we keep what main.py passed in.
        Saved values are re-clamped on the way in: the file is editable from the
        REPL, so it is untrusted input like anything arriving over the radio.
        """
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

    def _save_calibration(self):
        """Persist the current neutrals. True if they will survive a reset."""
        try:
            with open(_CALIB_PATH, "w") as f:
                json.dump({"nl": self._neutral_left_us, "nr": self._neutral_right_us}, f)
            return True
        except OSError:
            # Filesystem full or read-only. The values are still applied for this
            # session -- the station is simply told they are not persistent, so
            # the driver knows a reset reverts them.
            return False

    def clear_calibration(self):
        """Forget the saved calibration; main.py's values win at the next boot.

        Run once from the REPL when a robot should go back to the numbers in its
        main.py. Editing the constructor alone will not do it: a saved
        calibration is loaded over the top of those values in begin().
        """
        try:
            os.remove(_CALIB_PATH)
            return True
        except OSError:
            return False

    # --- outbound frames -----------------------------------------------------

    def _link_target(self):
        """Where robot -> station frames go: the dongle once we have heard from
        it, else broadcast. ESP-NOW broadcasts are unacknowledged, which is why
        the calibration announce repeats instead of firing once."""
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
