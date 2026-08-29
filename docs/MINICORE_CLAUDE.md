# MiniCore Communication System Redesign -- CLAUDE.md

> Handoff document for implementing the MiniCore driver station system.
> This document contains all architecture decisions, hardware specs, protocol definitions, and implementation guidance.

---

## Project Overview

MiniCore is a custom robotics control system for Lancer Robotics (FRC Team 2367). It provides a driver station that lets operators control small ESP32-based robots using game controllers.

The original system was a Windows exe that read two USB controllers and forwarded commands via UDP over Wi-Fi to ESP32 robots. This broke down during competition due to unreliable UDP packet delivery in crowded RF environments (many teams, many Wi-Fi networks in one room).

The redesign replaces the entire communication layer with ESP-NOW and moves the control interface to a browser-based web UI.

---

## System Architecture

```
Controllers --USB--> PC (Browser Web UI) --WebHID--> Waveshare ESP32-S3 Dongle --ESP-NOW unicast--> Robot ESP32(s)
```

There are three major components:

### 1. Browser-Based Control Panel (runs on PC)

- A web page (Chrome or Edge required) that serves as the entire control UI
- Reads game controllers natively via the **Gamepad API** -- no exe or background process needed
- Communicates with the Waveshare ESP32-S3 dongle over **WebHID API** -- no serial ports, no COM port enumeration, no drivers
- Handles controller-to-robot pairing (which controller drives which robot)
- Provides global and per-robot enable/disable controls
- Initiates robot discovery scans
- Displays robot connection status and heartbeat info
- Web framework is TBD (likely vanilla JS or React)

### 2. Control Station Dongle (Waveshare ESP32-S3-LCD-1.47)

- Plugs into the PC via USB-C
- Presents itself to the PC as a custom **USB HID device** (not a serial/CDC device)
- Receives joystick state and commands from the browser via WebHID
- Routes joystick data to the correct robot via **ESP-NOW unicast**
- Broadcasts enable/disable and discovery commands via **ESP-NOW broadcast**
- Relays discovery responses and heartbeat data back to the browser via WebHID
- The onboard 1.47-inch LCD displays secondary status info (connected robots, enable/disable state)
- The onboard RGB LED indicates system state at a glance (green = enabled, red = disabled, blinking = connection issues)
- This single dongle handles communication with all robots on the field (up to 4 simultaneously)

### 3. Robot ESP32 (one per robot)

- Runs on an ESP32 (original variant, not S2/S3)
- Listens for ESP-NOW packets from the control station dongle
- When enabled and receiving joystick data: drives motors via PWM to ESCs
- When disabled: ignores all joystick input
- Safety timeout: stops all motors if no joystick packet received within 250ms
- Responds to discovery requests with its name/ID and MAC address
- Optionally sends heartbeat/status packets back to the control station

---

## Hardware

### Control Station: Waveshare ESP32-S3-LCD-1.47

- **Purchase link**: https://www.amazon.com/gp/product/B0DFTCC1FT
- **Product page**: https://www.waveshare.com/esp32-s3-lcd-1.47.htm
- **Wiki/docs**: https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47

**Specs**

| Attribute | Value |
|-----------|-------|
| MCU | ESP32-S3R8 (dual-core Xtensa LX7, up to 240MHz) |
| SRAM | 512KB |
| ROM | 384KB |
| Flash | 16MB |
| PSRAM | 8MB |
| Display | 1.47-inch LCD, 172x320, 262K color, ST7789 driver |
| Wireless | 2.4GHz Wi-Fi (802.11 b/g/n) + Bluetooth LE 5, onboard antenna |
| USB | Type-C with **direct native USB** (GPIO19/GPIO20 as D-/D+) |
| Extras | TF card slot, RGB LED, BOOT button, RESET button |

**Critical USB detail**: The USB Type-C connector is wired directly to the ESP32-S3's native USB pins (GPIO19 and GPIO20) through 22-ohm series resistors. There is **no UART-to-USB bridge chip** (no CH340, no CP2102). This means:
- The board can present as a native USB HID device for WebHID
- It will NOT appear as a COM port unless you enable USB CDC in firmware
- Flashing requires entering download mode manually: hold BOOT, press RESET, release RESET, release BOOT

**Display pinout** (ST7789, SPI):
- Confirm exact pin assignments from the Waveshare wiki or schematic PDF at: https://files.waveshare.com/wiki/ESP32-S3-LCD-1.47/ESP32-S3-LCD-1.47_schematic_diagram.pdf

### Robot MCU: ESP32 (Original)

- Any ESP32 (original, not S2/S3) development board with ESP-NOW support
- Specific board TBD -- just needs GPIO pins for PWM output to ESCs and ESP-NOW capability
- Must be on the same Wi-Fi channel as the control station dongle

---

## Robot Details

| Attribute | Value |
|-----------|-------|
| Drive type | Tank drive (2 motors per robot) |
| Motor control | PWM signals to ESCs |
| Max simultaneous robots | 4 |
| Controller data | Joystick axes, buttons, plus auxiliary controls (servos, pneumatics, etc.) |
| Robot identification | Each robot reports a name/ID string during discovery |

---

## ESP-NOW Protocol

All communication between the control station dongle and robots uses ESP-NOW. All devices must be on the same Wi-Fi channel.

### Message Types

| Type | Hex | Direction | Mode | Description |
|------|-----|-----------|------|-------------|
| Joystick State | `0x01` | Dongle --> Robot | Unicast | Controller axis/button data for a specific robot |
| Enable/Disable | `0x02` | Dongle --> All Robots | Broadcast (`FF:FF:FF:FF:FF:FF`) | Global or per-robot enable/disable command |
| Heartbeat/Status | `0x03` | Robot --> Dongle | Unicast | Robot reports it is alive, optionally with status data |
| Discovery Request | `0x04` | Dongle --> All Robots | Broadcast | Control station asks "who's out there?" |
| Discovery Response | `0x05` | Robot --> Dongle | Unicast | Robot responds with its name/ID and MAC address |
| Set Neutral | `0x06` | Dongle --> Robot | **Unicast only** | Per-motor ESC neutral pulse widths for one specific robot |
| Neutral Ack | `0x07` | Robot --> Dongle | Unicast (broadcast fallback) | The neutrals actually in force, post-clamp |

### Joystick State Packet (0x01)

This packet carries the full controller state. Suggested structure:

```c
typedef struct {
    uint8_t type;           // 0x01
    uint8_t seq;            // Sequence number (0-255, wrapping)
    int16_t axis_lx;        // Left stick X (-32768 to 32767)
    int16_t axis_ly;        // Left stick Y
    int16_t axis_rx;        // Right stick X
    int16_t axis_ry;        // Right stick Y
    int16_t axis_lt;        // Left trigger
    int16_t axis_rt;        // Right trigger
    uint16_t buttons;       // Button bitfield
    uint8_t aux[8];         // Auxiliary channels (servos, pneumatics, etc.)
} __attribute__((packed)) joystick_packet_t;
```

Total: ~24 bytes, well within ESP-NOW's 250-byte max payload.

### Enable/Disable Packet (0x02)

```c
typedef struct {
    uint8_t type;           // 0x02
    uint8_t enabled;        // 1 = enable, 0 = disable
    uint8_t target_mac[6];  // Target robot MAC, or FF:FF:FF:FF:FF:FF for all
} __attribute__((packed)) enable_packet_t;
```

**Enable is a keepalive, not a latch.** The driver station re-broadcasts
`enabled = 1` about every 500 ms for as long as it is armed, and the robot lets
its enable flag lapse after `MC_ENABLE_TIMEOUT_MS` (3000 ms) without one. A
latching enable meant a robot that missed the disable — powered up through a
station reload, out of range, or behind a closed browser tab — came back still
enabled and drove the moment it was assigned a controller.

Three independent gates now stand between a stick and a motor, so no single
failure re-opens that hole:

1. The driver station only puts real stick values on the wire while armed;
   disarmed slots stream a neutral packet.
2. The dongle refuses to forward joystick reports unless it has seen a global
   enable (`s_global_enabled` in `minicore_bridge.c`).
3. The robot gates the motors on its own enable flag, which expires as above.

A disable takes effect immediately and does not refresh the expiry window.

### Set Neutral (0x06) / Neutral Ack (0x07)

```c
typedef struct {
    uint8_t  type;            // 0x06
    uint8_t  target_mac[6];   // this robot only — never broadcast
    uint16_t neutral_left_us;
    uint16_t neutral_right_us;
} __attribute__((packed)) set_neutral_packet_t;   // 11 bytes

typedef struct {
    uint8_t  type;            // 0x07
    uint8_t  mac[6];
    uint16_t neutral_left_us; // post-clamp: what the robot really applied
    uint16_t neutral_right_us;
    uint8_t  stored;          // 1 = saved to the robot's filesystem
} __attribute__((packed)) neutral_ack_packet_t;   // 12 bytes
```

Per-motor ESC trim, set from the driver station and **sent only on an explicit
button press** — never streamed from the control loop. Three properties are
deliberate:

- **Unicast only, with `target_mac` carried and verified by the robot.** Neutral
  trim is per-robot ESC calibration; a broadcast set would redefine "stopped" for
  every robot on the field at once, so the robot refuses anything not addressed
  to it rather than filtering it.
- **Clamped to `MC_NEUTRAL_TRIM_MIN_US`..`MAX` (1000–2000 µs)** by the **robot**,
  which is authoritative, and mirrored by the **web inputs** so the driver is told
  before sending. The **dongle does not clamp** — it is a transport and forwards
  the frame untouched. Two tiers, not three: the browser is the least trustworthy
  point (editable, cacheable) and the robot is the only one that sees *every* path
  in, including a `calib.json` hand-edited over the REPL. Putting the clamp in the
  dongle as well bought nothing observable and made an ESC policy number a
  compiled-in constant, so widening the range forced a rebuild and a BOOT/RESET
  reflash. The range is the full RC pulse window, so the station
  can express any neutral the ESC spec allows. This replaced a ±100 µs window
  around 1500: typical trim is ±30–50 µs, but robots in this fleet run ESCs
  offset far enough (1700 µs) that the narrow window refused their real neutral.
  Note what the wider range admits — neutral is the pulse driven on every stop,
  *including the 250 ms link-loss failsafe*, so a neutral at either rail makes
  "motors stopped" mean full throttle that way. What remains between a typo and
  that: the robot's own pulse clamp, the fact that this only moves on an explicit
  Apply, and the echo reporting what actually landed.
- **Not gated on the global enable**, unlike joystick reports. Calibrating means
  watching the wheels for creep at centered sticks, which requires the robot
  armed; and it changes what "stopped" means rather than driving anything.

The robot saves the values to `calib.json` and **loads them over `main.py`'s
constructor arguments in `begin()`** — before the PWM channels are created, since
the duty passed to the `PWM()` constructor is the first thing the ESC sees. That
precedence is the surprising part: editing `neutral_left_us=` in `main.py` has no
effect while a saved calibration exists. `Minibot.clear_calibration()` (or
deleting the file) hands control back.

`0x07` is also sent **unprompted**, so the station can populate its fields
whichever side came up first: on the robot's first `_CALIB_ANNOUNCE_COUNT`
heartbeats, again whenever it newly learns the dongle's MAC (which is what covers
a robot rebooting into a running station), and alongside every discovery
response. It reuses the heartbeat's target selection, so it falls back to
broadcast until the dongle is known — repeating because ESP-NOW broadcasts are
unacknowledged. `stored` answers "will this survive a reset?", letting a failed
flash write show up as a warning rather than being silently lost.

### Heartbeat/Status Packet (0x03)

```c
typedef struct {
    uint8_t type;           // 0x03
    uint8_t robot_id_len;   // Length of robot name/ID string
    char robot_id[16];      // Robot name/ID (null-terminated)
    uint8_t battery_pct;    // Battery percentage (0-100, or 0xFF if unknown)
    uint8_t status_flags;   // Bit flags: bit 0 = motors active, bit 1 = ESC connected, etc.
} __attribute__((packed)) heartbeat_packet_t;
```

### Discovery Request Packet (0x04)

```c
typedef struct {
    uint8_t type;           // 0x04
    uint8_t channel;        // Current Wi-Fi channel (for confirmation)
} __attribute__((packed)) discovery_request_t;
```

### Discovery Response Packet (0x05)

```c
typedef struct {
    uint8_t type;           // 0x05
    uint8_t mac[6];         // This robot's MAC address
    uint8_t robot_id_len;   // Length of robot name/ID string
    char robot_id[16];      // Robot name/ID (null-terminated)
} __attribute__((packed)) discovery_response_t;
```

### Discovery Flow

1. Operator clicks "Scan for Robots" in the browser UI
2. Browser sends a scan command to the dongle via WebHID
3. Dongle broadcasts a `0x04` discovery request over ESP-NOW
4. All robots running MiniCore firmware respond with `0x05` containing their name/ID and MAC
5. Dongle collects responses (with a short timeout, e.g. 500ms) and relays them back to the browser via WebHID
6. Browser displays discovered robots in a list
7. Operator assigns controllers to robots from the list

This is on-demand (not continuous beaconing) to avoid stale entries and unnecessary airtime.

### Pairing Strategy

- Pairings are configured in the browser UI after discovery
- The dongle stores the mapping of controller index --> robot MAC address
- When joystick data arrives from the browser, the dongle looks up which robot MAC is assigned to that controller and sends a `0x01` unicast to that MAC
- Up to 4 robots can be paired and active simultaneously
- The ESP-NOW peer limit is 20 per device, so 4 robots is well within bounds

---

## WebHID Protocol (Browser <--> Dongle)

The browser communicates with the ESP32-S3 dongle over USB HID. This requires defining a **HID Report Descriptor** on the ESP32-S3 firmware side.

### HID Report Structure (suggested)

**Output Reports (Browser --> Dongle)**

| Report ID | Purpose | Payload |
|-----------|---------|---------|
| `0x01` | Joystick state for controller N | Controller index (1 byte) + joystick_packet_t data |
| `0x02` | Enable/disable | enable_packet_t data |
| `0x04` | Discovery scan request | (empty or channel byte) |
| `0x10` | Pair controller to robot | Controller index (1 byte) + robot MAC (6 bytes) |
| `0x11` | Unpair controller | Controller index (1 byte) |
| `0x12` | Set ESC neutral | Slot index (1 byte) + `neutral_left_us` + `neutral_right_us` (u16 LE each) |

**Input Reports (Dongle --> Browser)**

| Report ID | Purpose | Payload |
|-----------|---------|---------|
| `0x03` | Heartbeat from robot | heartbeat_packet_t data |
| `0x05` | Discovery response | discovery_response_t data |
| `0x06` | Neutral calibration echo | neutral_ack_packet_t data |
| `0xFE` | Dongle status | Channel, paired count, global enable, error flags, `protocol_version` |

**`error_flags` bit 0 — ESP-NOW send failure.** The browser mirrors this bit
straight onto the "Radio send failing" chip, so the dongle is responsible for
making it steady. It is derived from recent send history, not set as a raw flag:
a failure reads as set for up to `MC_SEND_ERR_HOLD_US` (1 s) and is cleared early
by the next success on the same peer. Two details matter if you touch it:

- The history is **per paired slot**. Unicast joystick traffic runs at ~60 Hz per
  robot, so one shared flag would interleave a dead robot's failures with a live
  robot's successes and blink.
- **Broadcast completions are ignored.** ESP-NOW does not acknowledge broadcasts
  and always reports them `SUCCESS`, even with every robot on the field powered
  off — and the station broadcasts an enable re-assert about every 500 ms while
  armed. Counting those would permanently mask real failures.

Don't reintroduce a "clear the flag on each inbound report" reset. Send outcomes
arrive asynchronously in the ESP-NOW send callback, well after `esp_now_send()`
returns, so a reset at report rate erases the result before the 200 ms status
task can sample it — which is what made the chip flicker instead of holding.

### Two shared headers, and which one forces a reflash

`minicore_protocol.h` is **compiled into the dongle**, so editing it costs a
rebuild plus a physical BOOT/RESET reflash. `minicore_policy.h` is not — the
dongle neither includes nor uses it.

| Edited | Dongle reflash | Robot upload | Web reload |
|--------|----------------|--------------|------------|
| `minicore_protocol.h` (packets, message types, report ids) | **yes** | yes | yes |
| `minicore_policy.h` (timeouts, neutral-trim range) | no | yes | yes |

Keep behaviour constants in the policy header. The rule exists because a policy
number once leaked into the transport: `minicore_bridge.c` clamped the neutral
trim as well as the robot, so widening that range forced a dongle reflash for no
functional gain. The dongle addresses and routes frames; it does not interpret
what they mean.

**`MC_PROTOCOL_VERSION`** must be bumped whenever anything structural in
`minicore_protocol.h` changes — a message type, report id, report length, or
packet layout. The dongle reports the value it was *built* with in `0xFE`, and
the web app compares it against its own copy in `constants.js` and logs a
mismatch. That turns "the dongle is running old firmware" from a silent,
hours-long debugging session into one line in the Activity log.

### Implementation Notes

- The ESP32-S3 firmware should use the TinyUSB stack (included in ESP-IDF and Arduino ESP32 core) to present as a custom HID device
- The HID report descriptor must define all the report IDs and their sizes
- On the browser side, use `navigator.hid.requestDevice()` with a filter matching the dongle's VID/PID
- Send output reports with `device.sendReport(reportId, data)`
- Receive input reports with `device.addEventListener('inputreport', callback)`

---

## Robot-Side Firmware Logic

> Implemented in **MicroPython**: the framework steps below live in `minibot.py`
> (`Minibot.begin()` / `Minibot.update()`), and the tank-drive mixing is the default
> student code in `main.py`. Students can replace the mixing with any behavior.

```
setup()  [minibot.py: Minibot.begin()]:
    Initialize ESP-NOW
    Set Wi-Fi channel to match control station
    Register ESP-NOW receive callback
    Initialize PWM outputs for ESCs
    Set robot_enabled = false
    Set robot_name from config (the Minibot(...) constructor in main.py)

loop()  [minibot.py: Minibot.update(), then student main.py]:
    if received 0x04 discovery request:
        Send 0x05 discovery response (name + MAC) back to sender

    if received 0x02 enable/disable:
        Update robot_enabled flag
        if enabling: last_enable_time = now   # keepalive, see Enable packet above

    if received 0x01 joystick state AND robot_enabled:
        Update last_packet_time
        Decode joystick axes/buttons (student reads via get_left_y(), etc.)

    if robot_enabled and (now - last_enable_time > 3000ms):
        robot_enabled = false      # station went quiet; don't stay latched on

    if (now - last_packet_time > 250ms) or not enabled:
        Stop all motors (safety timeout)
        Zero the cached axes, so student code driving from the sticks cannot
        immediately undo the stop with pre-dropout values

    Periodically send 0x03 heartbeat to control station MAC (every ~1 second)

    # student main.py then maps inputs to motors, e.g. tank drive:
    #   bot.drive_left_motor(-bot.get_left_y())
    #   bot.drive_right_motor(-bot.get_right_y())
```

### Tank Drive Mixing

For tank drive, the simplest mapping is:
- Left motor speed = left stick Y axis
- Right motor speed = right stick Y axis

The joystick values (-32768 to 32767) need to be mapped to the ESC's PWM range (typically 1000-2000 microseconds for standard RC ESCs, with 1500 as neutral).

```c
int16_t map_axis_to_pwm(int16_t axis_value) {
    // Map -32768..32767 to 1000..2000 microseconds
    return 1500 + (axis_value * 500 / 32767);
}
```

---

## Congested RF Mitigation

ESP-NOW operates at the MAC layer below Wi-Fi, so it does not need a router or access point. However, it still uses the 2.4GHz band.

Strategies:
- Lock all devices to the least congested Wi-Fi channel (channels 1, 6, or 11 are non-overlapping -- scan beforehand)
- Keep payloads small (~20-24 bytes for joystick state)
- Send at high rate (50-100Hz) so the robot always uses the latest state and a few dropped packets are imperceptible
- ESP-NOW supports optional ACK callbacks on unicast -- use these to detect connection loss

Fallback options if 2.4GHz is completely unusable:
- 900MHz radio modules (LoRa, HC-12)
- NRF24L01+ modules (2.4GHz but with frequency hopping and narrow channel widths)

---

## Development Environment

### Control Station Dongle (ESP32-S3)

- **Framework**: ESP-IDF (recommended for native USB HID control) or Arduino with ESP32 core
- **USB Stack**: TinyUSB (included in ESP-IDF)
- **Key libraries**: `esp_now.h`, `tinyusb`, ST7789 display driver (SPI)
- **Board selection in Arduino**: "ESP32S3 Dev Module" with USB CDC On Boot enabled for serial debug during development

### Robot (ESP32)

- **Framework**: **MicroPython** (students write `main.py`; the `Minibot` library in `minibot.py` wraps ESP-NOW + PWM). See `firmware/esp32-robot/`.
- **Key modules**: `espnow`, `network`, `machine.PWM` (50 Hz servo/ESC pulses via `duty_u16()`)
- **PWM calibration** — matched to the ESC datasheet:

  | Spec | Datasheet | Code |
  |------|-----------|------|
  | Pulse high time | 1–2 ms nominal, 1.5 ms center | `_PWM_CENTER_US=1500`, `_PWM_RANGE_US=300` (± swing at full stick) |
  | Accepted range | 0.5–2.5 ms per controller spec | `_PWM_MIN_US=500`, `_PWM_MAX_US=2500` — the hard clamp in `_pulse_us()` |
  | Period | 2.9–100 ms (≈10–345 Hz) | `_PWM_FREQ_HZ=50` → 20 ms (mid-range) |
  | Logic high min 1.0 V / low max 0.4 V | — | ESP32 GPIO drives 0/3.3 V push-pull ✓ |
  | Input current | <1 mA | Direct GPIO, no buffer needed ✓ |
  | Deadband | 4% default (0.1–25%) | ESC-side (±12 µs of the 300 µs travel); our *stick* deadband is ±2000/32767 ≈ 6.1% (±18.3 µs), wider, so the ESC's is covered |

  Neutral is per **motor** and per robot: `Minibot(..., neutral_left_us=, neutral_right_us=)`,
  clamped into the `_PWM_MIN_US`–`_PWM_MAX_US` window so a typo can't emit an out-of-spec pulse.
  The ± swing is **not** a constructor argument — it is the `_PWM_RANGE_US` library constant,
  shared by every robot. Neutral can also be set at runtime from the driver station; see the
  Set Neutral / Neutral Ack section above.
- **Do not reuse the old firmware's 1758 µs / ±391 µs.** Those came from the original Arduino library writing LEDC duty `90` on a 10-bit 50 Hz timer (`90/1024*20000 = 1757.8 µs`) — a trim value for that specific hardware, not a true neutral. The servo helper in that same old file used `0.01*angle + 1.5` (1500 µs at rest). Carrying 1758 µs into the MicroPython port made every robot hold ~50% throttle at "neutral", spinning the wheels on power-up.
- **Motor commands are slew-rate limited** (`_SLEW_PER_S` in `minibot.py` — a library constant,
  deliberately *not* a `Minibot(...)` parameter, so student code in `main.py` cannot opt out of a
  limit that exists to protect the hardware). `drive_left_motor()` / `drive_right_motor()`
  ramp toward the requested value at a bounded units-per-second rate — 500 ms for a full
  forward-to-reverse reversal by default. Slamming the sticks through neutral otherwise puts the
  supply and the motor's back-EMF in series (`I = (V_applied − V_bemf) / R`), drawing about twice
  stall current; the rail sags, the ESP32's brownout detector resets the board, and the ~3 s
  outage that follows (MicroPython boot + `boot.py`'s upload pause) crosses the driver station's
  2.5 s heartbeat-staleness threshold, so it presents as a dropped connection rather than a reset.
  Two properties are load-bearing: the step is derived from `ticks_diff`, not per-call, because
  `main.py`'s loop rate is unbounded and student-editable; and `stop_all_motors()` bypasses the
  limiter entirely *and* clears its state, so the 250 ms failsafe still cuts instantly and the next
  drive call cannot ramp from a throttle the motors have already left. This bounds the current; it
  does not substitute for bulk capacitance at the ESC.
- **Neutral must be passed to the `PWM()` constructor** (`duty_u16=...`). A bare `PWM(pin, freq=50)` defaults to duty_u16 = 32768 on the ESP32 port — a 10 ms pulse, which ESCs read as far past full throttle, so the motors run the instant `begin()` executes. `duty_ns` can't be used in the constructor (it raises "PWM is inactive" before a timer is assigned), hence `duty_u16`.

### Browser UI

- **Required APIs**: Gamepad API, WebHID API (Chrome/Edge only, requires HTTPS or localhost)
- **Framework**: TBD (vanilla JS or React)
- **No backend required** -- the web page can be a single HTML file served locally or from any static host

---

## Task Checklist

Status as of the neutral-calibration work. Unchecked items are genuinely not
built, not merely unverified.

- [x] Design the HID report descriptor for the dongle firmware
- [x] Build ESP32-S3 control station firmware
  - [x] USB HID device initialization (TinyUSB)
  - [x] HID report parsing (output reports from browser)
  - [x] HID report sending (input reports to browser)
  - [x] ESP-NOW initialization and peer management
  - [x] Joystick routing (WebHID --> ESP-NOW unicast to paired robot)
  - [x] Enable/disable broadcast
  - [x] Discovery request broadcast and response collection
  - [x] LCD status display (ST7789) — `waveshare_s3_lcd147_ui_init()` in `minicore_app.c`
  - [ ] RGB LED state indication — driver exists (`RGB.c`), not wired to link/enable state
- [x] Build robot-side ESP-NOW receiver firmware
  - [x] ESP-NOW receive callback
  - [x] Discovery response handler
  - [x] Joystick-to-PWM mapping (tank drive)
  - [ ] Auxiliary channel handling (servos, pneumatics) — `aux[8]` rides the wire but
        `_handle_joystick()` discards it; no student-facing getter yet
  - [x] Safety timeout (250ms)
  - [x] Heartbeat transmission
  - [x] Robot name/ID configuration
- [x] Build browser-based control panel UI
  - [x] WebHID connection flow (device selection, connect/disconnect)
  - [x] Gamepad API polling and state display
  - [x] Robot discovery UI (scan button, results list)
  - [x] Controller-to-robot pairing UI (dropdown per slot)
  - [x] Enable/disable controls (global) — broadcast only; `encodeEnable()` takes a
        target MAC, but no per-robot control is exposed in the UI
  - [x] Connection health display (heartbeat staleness, radio-fault chip) — no latency readout
  - [ ] Channel selection UI (optional) — the channel is displayed, not settable
- [x] Define and test joystick-to-motor mapping (tank drive)
- [x] Per-motor ESC neutral trim, settable from the driver station and persisted on the robot
- [x] Motor slew-rate limiting (brownout mitigation on direction reversal)
- [ ] Generic relay report ids, so a new robot<->station message needs no dongle
      change at all: `RELAY_OUT` = `[slot][opaque bytes]` unicast verbatim to that
      slot's MAC, `RELAY_IN` = any unrecognised inbound frame forwarded up. Sized
      generously once (resizing is itself a descriptor change). Joystick must stay
      on its own path and the relay must refuse `MC_MSG_JOYSTICK` payloads, or it
      becomes a way around the `s_global_enabled` gate.
- [ ] Test in congested RF environment
- [ ] Field test with multiple robots (up to 4)

---

## Key Links

- **Notion project page**: https://www.notion.so/335303820a2981fbb83cf8e14d77c734
- **Monday.com task**: https://lancerrobotics.monday.com/boards/18407198631/pulses/11695399591
- **Waveshare product page**: https://www.waveshare.com/esp32-s3-lcd-1.47.htm
- **Waveshare wiki**: https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47
- **Schematic PDF**: https://files.waveshare.com/wiki/ESP32-S3-LCD-1.47/ESP32-S3-LCD-1.47_schematic_diagram.pdf
- **ESP-NOW docs**: https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/network/esp_now.html
- **WebHID API**: https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API
- **Gamepad API**: https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API
- **TinyUSB HID**: https://docs.tinyusb.org/en/latest/reference/getting_started.html
