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

**Input Reports (Dongle --> Browser)**

| Report ID | Purpose | Payload |
|-----------|---------|---------|
| `0x03` | Heartbeat from robot | heartbeat_packet_t data |
| `0x05` | Discovery response | discovery_response_t data |
| `0xFE` | Dongle status | Channel, paired count, error flags |

### Implementation Notes

- The ESP32-S3 firmware should use the TinyUSB stack (included in ESP-IDF and Arduino ESP32 core) to present as a custom HID device
- The HID report descriptor must define all the report IDs and their sizes
- On the browser side, use `navigator.hid.requestDevice()` with a filter matching the dongle's VID/PID
- Send output reports with `device.sendReport(reportId, data)`
- Receive input reports with `device.addEventListener('inputreport', callback)`

---

## Robot-Side Firmware Logic

```
setup():
    Initialize ESP-NOW
    Set Wi-Fi channel to match control station
    Register ESP-NOW receive callback
    Initialize PWM outputs for ESCs
    Set robot_enabled = false
    Set robot_name from config (stored in flash or hardcoded)

loop():
    if received 0x04 discovery request:
        Send 0x05 discovery response (name + MAC) back to sender

    if received 0x02 enable/disable:
        Update robot_enabled flag

    if received 0x01 joystick state AND robot_enabled:
        Update last_packet_time
        Map joystick axes to tank drive (left stick Y = left motor, right stick Y = right motor)
        Map auxiliary channels to servos/pneumatics
        Write PWM values to ESCs

    if (millis() - last_packet_time > 250):
        Stop all motors (safety timeout)

    Periodically send 0x03 heartbeat to control station MAC (every ~1 second)
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

- **Framework**: Arduino or ESP-IDF
- **Key libraries**: `esp_now.h`, ESP32 PWM/LEDC for ESC control

### Browser UI

- **Required APIs**: Gamepad API, WebHID API (Chrome/Edge only, requires HTTPS or localhost)
- **Framework**: TBD (vanilla JS or React)
- **No backend required** -- the web page can be a single HTML file served locally or from any static host

---

## Task Checklist

- [ ] Design the HID report descriptor for the dongle firmware
- [ ] Build ESP32-S3 control station firmware
  - [ ] USB HID device initialization (TinyUSB)
  - [ ] HID report parsing (output reports from browser)
  - [ ] HID report sending (input reports to browser)
  - [ ] ESP-NOW initialization and peer management
  - [ ] Joystick routing (WebHID --> ESP-NOW unicast to paired robot)
  - [ ] Enable/disable broadcast
  - [ ] Discovery request broadcast and response collection
  - [ ] LCD status display (ST7789)
  - [ ] RGB LED state indication
- [ ] Build robot-side ESP-NOW receiver firmware
  - [ ] ESP-NOW receive callback
  - [ ] Discovery response handler
  - [ ] Joystick-to-PWM mapping (tank drive)
  - [ ] Auxiliary channel handling (servos, pneumatics)
  - [ ] Safety timeout (250ms)
  - [ ] Heartbeat transmission
  - [ ] Robot name/ID configuration
- [ ] Build browser-based control panel UI
  - [ ] WebHID connection flow (device selection, connect/disconnect)
  - [ ] Gamepad API polling and state display
  - [ ] Robot discovery UI (scan button, results list)
  - [ ] Controller-to-robot pairing UI (drag and drop or dropdown)
  - [ ] Enable/disable controls (global + per-robot)
  - [ ] Connection health display (heartbeat status, latency)
  - [ ] Channel selection UI (optional)
- [ ] Define and test joystick-to-motor mapping (tank drive + aux channels)
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
