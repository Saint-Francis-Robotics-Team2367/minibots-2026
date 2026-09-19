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

Wire protocol: firmware/common/minicore_protocol.h is the single source of truth
for every packet layout here. That header is also compiled into the ESP32-S3
dongle, so a change to it means reflashing the dongle as well as re-uploading
this file -- they are not independently versioned.
"""

import time

from machine import PWM, Pin

from button import Button
from comm_module import CommModule
from display import Display
from minibot_config import MinibotConfig
from neopixel_ring import RAINBOW_COLORS, NeoPixelRing, RingConnectionStatus, RingRotation

# --- PWM calibration ---
# Matched to the ESC datasheet:
#   Pulse high time  1-2 ms nominal, 1.5 ms center   -> _PWM_CENTER_US +/- _PWM_RANGE_US
#   Accepted range   0.5-2.5 ms per controller spec  -> _PWM_MIN_US / _PWM_MAX_US clamp
#   Period           2.9-100 ms (~10-345 Hz)         -> 50 Hz = 20 ms, mid-range
#   Logic high min   1.0 V / low max 0.4 V           -> ESP32 drives 0/3.3 V, fine
#   Input current    <1 mA                           -> direct GPIO, no buffer
#
# NOTE: the retired C++ firmware used 1758us +/- 391us (clamp 1000-2500us). The
# very old Arduino library wrote LEDC duty 90 on a 10-bit 50 Hz timer
# (90 / 1024 * 20000us = 1757.8us); that was a trim value for *that* hardware's
# ESCs, not a real neutral -- the servo helper in the same old file used
# `0.01 * angle + 1.5`, i.e. 1500us at rest. Carrying 1758us over meant every
# robot held ~50% throttle at "neutral" and the wheels spun on power-up.
#
# The 1000-2500us clamp it used is a separate question from that bad neutral, and
# _PWM_MIN_US/_PWM_MAX_US are now 500-2500 deliberately: the clamp is the
# controller's absolute accepted range, a last guard against an out-of-spec
# pulse, not the operating range. What keeps normal output inside 1-2 ms is
# _PWM_CENTER_US +/- _PWM_RANGE_US (1500 +/- 300 = 1200-1800us).
# If your ESCs need a different center, pass neutral_left_us= / neutral_right_us=
# (see Minibot.__init__), or set them live from the driver station.
# fmt: off
_PWM_FREQ_HZ = 50
_PWM_CENTER_US = 1500  # neutral pulse width (motors stopped)
_PWM_RANGE_US = 300    # +/- swing at full stick
_PWM_MIN_US = 500      # safety minimum (per controller specs)
_PWM_MAX_US = 2500     # safety maximum (per controller specs)
# fmt: on

# Stick deadband, as a fraction of full travel (carried over from the old
# firmware's `if (abs(axis) < 2000) axis = 0`). This is a *stick* deadband, so a
# controller resting off-center doesn't make the robot creep.
_DEADBAND = 2000.0 / 32767.0  # ~6.1% of stick travel = +/-18.3us of pulse

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

# The global speed limit that bounds every motor command lives in comm_module.py
# (_SPEED_LIMIT_MIN/_MAX); _slew() reads it through self.comm.get_speed_limit().


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

    def __init__(self, config):
        """Initialize from a MinibotConfig.

        Motors always swing ±_PWM_RANGE_US (300 us) at full stick, centered on
        their neutral. That span is a library constant, not a per-robot setting.

        The motor slew limit is not settable here on purpose -- it is fixed at
        _SLEW_PER_S so robot code cannot opt out of it.
        """
        self._left_pin = config.left_motor_pin
        self._right_pin = config.right_motor_pin

        # Create the communication module to handle WiFi, ESP-NOW, and protocol
        self.comm = CommModule(
            config.robot_id,
            config.channel,
            config.neutral_left_us,
            config.neutral_right_us,
        )
        self.comm.set_on_neutral_change(self._on_neutral_change)

        self._left_pwm = None
        self._right_pwm = None

        # Rate-limited motor state. _out_* is what we last actually commanded,
        # which the limiter has to remember to know how far it may step next.
        self._out_left = 0.0
        self._out_right = 0.0
        self._slew_ms_left = time.ticks_ms()
        self._slew_ms_right = self._slew_ms_left

        self._display = self._init_display(config)
        self._ring = self._init_ring()
        self._ring_rotation = RingRotation(RAINBOW_COLORS, rotate_delay_ms=200)
        self._ring_connection_status = RingConnectionStatus()
        self._ring_show_rainbow = False
        self._button = self._init_button()
        self._set_ring_colors()

    # --- lifecycle -----------------------------------------------------------

    def begin(self):
        """Bring up the motor outputs, Wi-Fi and ESP-NOW. Call once."""
        # Load calibration and bring up communication first. This loads any saved
        # neutral trim and starts the WiFi/ESP-NOW stack.
        self.comm.begin()

        # Motors FIRST, at neutral: bringing up Wi-Fi takes a moment, and until
        # a PWM channel drives these pins they float, which some ESCs latch onto
        # as a throttle command. Get a valid neutral pulse train out immediately.
        self._left_pwm = self._init_motor_pwm(self._left_pin, self.comm.get_neutral_left_us())
        self._right_pwm = self._init_motor_pwm(self._right_pin, self.comm.get_neutral_right_us())
        self.stop_all_motors()

    # --- main loop step ------------------------------------------------------

    def update(self):
        """Call FIRST each loop. Drains the radio, applies enable/failsafe,
        and sends periodic heartbeats."""
        self.comm.update()

        self._set_ring_colors()

        # Failsafe: neutral motors when disabled or link is stale.
        if not self.comm.is_enabled() or self.comm.is_joystick_stale():
            self.stop_all_motors()

    # --- inputs (normalized -1.0..1.0) --------------------------------------

    def _stick(self, raw):
        """Normalize a stick axis and swallow the resting-center jitter."""
        value = raw / 32767.0
        return 0.0 if -_DEADBAND < value < _DEADBAND else value

    def get_left_x(self):
        return self._stick(self.comm.get_left_x())

    def get_left_y(self):
        return self._stick(self.comm.get_left_y())

    def get_right_x(self):
        return self._stick(self.comm.get_right_x())

    def get_right_y(self):
        return self._stick(self.comm.get_right_y())

    def get_left_trigger(self):
        return self.comm.get_left_trigger() / 32767.0

    def get_right_trigger(self):
        return self.comm.get_right_trigger() / 32767.0

    # --- buttons (True when pressed) ----------------------------------------

    def get_cross(self):
        return bool(self.comm.get_buttons() & (1 << 0))

    def get_circle(self):
        return bool(self.comm.get_buttons() & (1 << 1))

    def get_square(self):
        return bool(self.comm.get_buttons() & (1 << 2))

    def get_triangle(self):
        return bool(self.comm.get_buttons() & (1 << 3))

    # --- game status ---------------------------------------------------------

    def get_game_status(self):
        """TELEOP when the driver station has enabled this robot, else STANDBY."""
        return Minibot.TELEOP if self.comm.is_enabled() else Minibot.STANDBY

    # --- motors (value -1.0..1.0) -------------------------------------------

    def drive_left_motor(self, value):
        self._out_left, self._slew_ms_left = self._slew(self._out_left, value, self._slew_ms_left)
        self._motor_write(self._left_pwm, self._out_left, self.comm.get_neutral_left_us())

    def drive_right_motor(self, value):
        self._out_right, self._slew_ms_right = self._slew(self._out_right, value, self._slew_ms_right)
        self._motor_write(self._right_pwm, self._out_right, self.comm.get_neutral_right_us())

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
        self._pulse_us(self._left_pwm, self.comm.get_neutral_left_us())
        self._pulse_us(self._right_pwm, self.comm.get_neutral_right_us())

    # --- calibration ---------------------------------------------------------

    def clear_calibration(self):
        """Forget the saved calibration; main.py's values win at the next boot.

        Run once from the REPL when a robot should go back to the numbers in its
        main.py. Editing the constructor alone will not do it: a saved
        calibration is loaded over the top of those values in begin().

        Kept on Minibot even though the file belongs to CommModule: `bot` is the
        only name students have at the REPL, and the README sends them here.
        """
        return self.comm.clear_calibration()

    def _on_neutral_change(self):
        """A station applied new neutrals -- put them on the wire now.

        Only when the motors are already stopped: then the pulse is the neutral
        itself, and re-emitting shows the change without anyone touching the
        sticks, which is the whole point of calibrating. If something is being
        driven, the next drive_*_motor() picks the new neutral up on its own and
        stepping it here would be a throttle jump nobody asked for.
        """
        if self._out_left == 0.0 and self._out_right == 0.0:
            self.stop_all_motors()

    # --- button -----------------------------------------------------------

    def _init_button(self) -> Button | None:
        """Create and initialize button. Returns Button | None."""
        try:
            return Button()
        except Exception as e:
            print(f"[warn] Failed to initialize button: {e}")
            return None

    def _check_button(self) -> None:
        """Check button state and toggle display mode."""
        if self._button is None:
            return
        if self._button.check():
            self._ring_show_rainbow = not self._ring_show_rainbow
            mode = "rainbow" if self._ring_show_rainbow else "connection"
            print(f"Button pressed: switched to {mode} mode")

    # --- neopixel ring ---------------------------------------------------

    def _init_ring(self) -> NeoPixelRing | None:
        """Create and initialize NeoPixel ring."""
        try:
            ring = NeoPixelRing(max_intensity=20)
            ring.clear()
            ring.write()
            return ring
        except Exception as e:
            print(f"[warn] Failed to initialize NeoPixel ring: {e}")
            return None

    def _set_ring_colors(self) -> None:
        """Set the ring color based on display mode."""
        if self._ring is None or self._ring_rotation is None or self._ring_connection_status is None:
            return
        try:
            self._check_button()

            if self._ring_show_rainbow:
                # Rainbow rotation mode
                self._ring_rotation.update()
                colors = self._ring_rotation.get_colors()
            else:
                # Connection status mode - check if we have dongle connection
                lx, ly, rx, ry, lt, rt, buttons = self.comm.get_joystick_axes()
                has_input = ly != 0 or ry != 0 or lx != 0 or rx != 0

                if not self.comm.is_connected_to_dongle():
                    # Not connected to dongle
                    self._ring_connection_status.set_status(self._ring_connection_status.STATUS_DISCONNECTED)
                elif not self.comm.is_enabled():
                    # Connected but not assigned/enabled
                    self._ring_connection_status.set_status(self._ring_connection_status.STATUS_CONNECTED_UNASSIGNED)
                elif has_input:
                    # Driving (has input)
                    self._ring_connection_status.set_status(self._ring_connection_status.STATUS_DRIVING)
                    self._ring_connection_status.update_blink()
                else:
                    # Connected and assigned but not driving
                    self._ring_connection_status.set_status(self._ring_connection_status.STATUS_CONNECTED_ASSIGNED)

                colors = self._ring_connection_status.get_colors()

            self._ring.set_colors(colors)
            self._ring.write()
        except Exception as e:
            print(f"[warn] Failed to set ring colors: {e}")

    # --- display -----------------------------------------------------------

    def _init_display(self, config) -> Display | None:
        """Create and initialize display if enabled. Returns Display | None."""
        if not config.display_enabled:
            return None
        try:
            display = Display()
            display.set_line1(self.comm.get_robot_id())
            # set_line*() only stages text in RAM; nothing reaches the panel
            # until show() pushes the framebuffer over I2C.
            display.show()
            return display
        except Exception as e:
            print(f"[warn] Failed to initialize display: {e}")
            return None

    # --- internals -----------------------------------------------------------

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

        The global speed limit is applied here, by narrowing the range clamp
        this already performs rather than adding a second one. Two consequences
        are the reason it belongs here and not in _motor_write():

        - Every public motor call routes through this method, so there is no
          path by which main.py can exceed the cap.
        - Lowering the limit while driving ramps the output down at _SLEW_PER_S
          instead of stepping it. Clamping after the limiter would cut the
          command abruptly -- the exact current spike the limiter exists to
          prevent.

        stop_all_motors() writes neutral through _pulse_us() and is untouched:
        a stop must never be ramped, and must never be limited either.
        """
        now = time.ticks_ms()
        target = _clamp(target, -self.comm.get_speed_limit(), self.comm.get_speed_limit())
        dt_ms = _clamp(time.ticks_diff(now, last_ms), 0, _SLEW_MAX_DT_MS)
        step = _SLEW_PER_S * dt_ms / 1000.0
        return cur + _clamp(target - cur, -step, step), now

    def _motor_write(self, pwm, value, neutral_us):
        value = _clamp(value, -1.0, 1.0)
        self._pulse_us(pwm, neutral_us + int(value * _PWM_RANGE_US))

    def _pulse_us(self, pwm, us):
        if pwm is None:
            return
        us = _clamp(us, _PWM_MIN_US, _PWM_MAX_US)
        pwm.duty_u16(_us_to_duty_u16(us))
