# Old codebase reference: Python driver station ↔ C++ (ESP32) Minibot library

This document describes how the original **driver station** (`driverStation.py`) and the **firmware** (`minibots/minibot.*` + `minibots.ino`) fit together: architecture, threads, UDP messaging, and the binary controller format. Use it when replacing transports (e.g. WebSockets, BLE) or the frontend while preserving behavior.

---

## 1. Repository layout (`old-code/`)

| Path | Role |
|------|------|
| `driverStation.py` | Desktop app: **Tkinter** UI, **Pygame** joysticks, **UDP** I/O (broadcast discovery + per-robot packets). |
| `minibots/minibot.h` | `Minibot` class API: WiFi, UDP, PWM/servo, controller/game-status state. |
| `minibots/minibot.cpp` | Implementation of discovery, parsing, motor helpers, `updateController()`. |
| `minibots/minibots.ino` | Sketch: `setup()` / `loop()` calling `Minibot` for teleop tank drive. |

There is no separate “C++ library” built for the PC: the C++ code targets **ESP32** (Arduino framework) and is compiled into firmware. The **Python side is a standalone script** that speaks the same UDP protocol over WiFi.

---

## 2. High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  PC: driverStation.py                                            │
│  ┌──────────────┐   ┌────────────────┐   ┌─────────────────────┐ │
│  │ Tkinter GUI  │   │ Pygame joysticks│   │ UDP socket (2367)   │ │
│  │ status, pair │   │ axes + buttons │   │ broadcast + unicast │ │
│  └──────────────┘   └────────────────┘   └──────────┬──────────┘ │
│         │                      │                       │          │
│         └──────────────────────┴───────────────────────┘          │
│              3 background threads (see §4)                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │ WiFi LAN (UDP)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  ESP32: minibots.ino + Minibot (minibot.cpp / minibot.h)         │
│  ┌──────────────┐   WiFiUDP :2367   ┌──────────────────────────┐ │
│  │ loop():      │ ◄────────────────►│ updateController()        │ │
│  │ teleop logic │                   │ parse ping / status / 8B  │ │
│  └──────────────┘                   └────────────────────────────┘ │
│         │                                    │                    │
│         └────────────────┬───────────────────┘                    │
│                          ▼                                        │
│                   LEDC PWM (motors / servo)                         │
└─────────────────────────────────────────────────────────────────┘
```

- **Single UDP port on both ends:** `2367` (Python: `BROADCAST_PORT`; firmware: `UDP_PORT`).
- **No TCP, HTTP, or serial bridge** in this codebase; everything is **UDP datagrams**.

---

## 3. Configuration that must match the deployment

### 3.1 WiFi (firmware only)

Defined in `minibot.h`:

- `WIFI_SSID` / `WIFI_PASSWORD` — robot joins this AP; the PC must be on the **same L2 network** so UDP unicast to the robot’s IP works.
- There is **no** WiFi configuration in Python; it assumes the host OS is already connected.

### 3.2 Robot identity

- In `minibots.ino`, the robot is constructed with a string such as  
  `Minibot bot("ENTER ROBOT NAME HERE", ...)`.
- That string is **`robotId`**: it appears in discovery replies and **must** prefix game-status packets from the driver station (see §5.3).

### 3.3 Pins and PWM (firmware)

From `minibot.h` defaults / `minibots.ino` example:

- **Motor channels:** `leftMotorPin`, `rightMotorPin`, `dcMotorPin`, `servoMotorPin` (example sketch uses GPIO 16, 17, 18, 19).
- **PWM:** `ledcAttach` at **50 Hz**, **10-bit** resolution (`freq`, `resolution` in `minibot.h`).
- **Center offsets:** `leftMotorPwmOffset`, `rightMotorPwmOffset`, and `dcMotorPwmOffset`. The sample sketch passes `90, 90` for the left and right offsets; **`dcMotorPwmOffset` is omitted** and therefore uses the header default **90**.

`driveServoMotor` uses a **different** duty math (`65535` scale) than the other motors (`ledcWrite` with 10-bit channel) — worth validating on hardware if you port PWM backends.

---

## 4. Python driver station: structure and threads

### 4.1 Socket setup (`driverStation.py`)

- `socket.AF_INET`, `socket.SOCK_DGRAM`.
- `SO_BROADCAST` enabled so `sendto(..., ('255.255.255.255', 2367))` works.
- **Bind** to `('', 2367)` — all interfaces, port **2367** (same as robot).

Non-blocking receive: `setblocking(False)` so the discovery loop can poll without hanging.

### 4.2 GUI (Tkinter)

- Window title `"Driver Station"`.
- **Status** string: `standby` | `teleop` (buttons set global `game_status` and label text).
- **Two pairings:** “Robot 1” and “Robot 2” — each combobox selects a **discovered robot name** and a **controller name**, then **Connect** assigns that pygame joystick object to `robot["controller"]` in the shared `robots` list.

### 4.3 Joystick enumeration (Pygame)

- On startup and on **Refresh Controllers**: `pygame.joystick` init, build `active_controllers` list of `{ id, name, obj }` with `name` like `"0: Controller Name"`.

### 4.4 Background threads (all `daemon=True`)

| Thread | Period | Behavior |
|--------|--------|----------|
| `discover_robots` | ~20 Hz (`sleep(0.05)`) | Sends `b"ping"` to `255.255.255.255:2367`; non-blocking `recvfrom`; if payload starts with `b"pong:"`, parses name, adds/updates `robots[]` and refreshes dropdowns. |
| `send_controller_data` | ~20 Hz | `pygame.event.pump()`; for each robot with a selected controller and `addr`, sends **8-byte** binary packet (§5.2). |
| `broadcast_game_status` | 1 Hz | For each robot with `addr`, sends **text** `b"{name}:{game_status}"` (§5.3). |

Main thread: `root.mainloop()`. Note: `comm_socket.close()` after `mainloop()` is effectively cleanup on exit (often never reached if the process is killed).

---

## 5. UDP protocol (what bytes mean)

All traffic uses **port 2367** on both client and robot. The robot **does not** bind different ports per command vs discovery (contrast with unused macros in `minibot.h`; see §8).

### 5.1 Discovery: `ping` / `pong`

**PC → broadcast:** payload exactly the ASCII bytes `ping` (no newline).

**Robot → PC:** ASCII text  
`pong:` + `robotId` (UTF-8 bytes; no documented terminator; driver uses `.decode().strip()` on the substring after `pong:`).

**Firmware behavior (`updateController`, text branch):**

- If the packet string equals `"ping"` **and** `!connected`:
  - Replies with `pong:` + `robotId` to `udp.remoteIP()`, `udp.remotePort()`.
  - Sets `connected = true`.

Implication: after the **first** successful ping handling, **`connected` stays true** and **further `ping` datagrams are ignored** (no additional `pong`). The PC discovery loop keeps broadcasting `ping`; rediscovery of the **same** robot after that relies on other traffic, not repeated `pong`s. New robots that have never answered still respond until they set `connected`.

The PC stores `addr` from `recvfrom` on each `pong` and updates existing robots’ `addr` when a new `pong` arrives — useful if the first response came from a transient port/path.

### 5.2 Controller payload (binary, 8 bytes)

**PC → robot** when a controller is bound to that robot:

Packed with Python `struct.pack('6B2B', ...)`:

| Offset | Size | Content |
|--------|------|---------|
| 0–5 | 6 × `uint8` | Axis values: for each axis `i`, `int((axis_i * 127) + 127) & 0xFF` → **0–255**, **neutral ≈ 127**. |
| 6 | `uint8` | Low byte of button bitmask. |
| 7 | `uint8` | High byte of button bitmask. |

Buttons (Python):  
`buttons = sum((controller.get_button(i) << i) for i in range(4))` — only **four** buttons indexed 0–3; packed little-endian into two bytes (only the low byte carries data for four buttons).

**Firmware (`len == 8`):**

- Copies 6 bytes into `axes[]`, 2 bytes into `buttons[]`.
- **Only applies stick/button state if `gameStatus == Teleop`.** Otherwise it returns without updating axes/buttons (packet is still consumed).

**Axis mapping on the robot** (conceptual; used by `minibots.ino`):

| Index | Role in example sketch |
|-------|-------------------------|
| 0 | `leftX` (read; not used in snippet) |
| 1 | `leftY` → left tread |
| 2 | `rightX` (read; not used in snippet) |
| 3 | `rightY` → right tread |
| 4–5 | Stored; unused in snippet |

**Buttons (`buttons[0]` bits):**

| Bit | Flag in `Minibot` |
|-----|-------------------|
| 0 | cross |
| 1 | circle |
| 2 | square |
| 3 | triangle |

`buttons[1]` is received but not decoded in `minibot.cpp` for additional actions.

**Risk for ports:** Pygame is asked for **6 axes**; controllers with fewer than 6 axes may error at runtime unless guarded.

### 5.3 Game status (text)

**PC → robot:** UTF-8 bytes:  
`{robotId}:{game_status}`  

Example: `MyRobot:teleop`, `MyRobot:standby`.

**Firmware:** Non-8-byte packets are treated as text (`String` over the buffer). If the string **starts with** `robotId` and contains `:`, the substring after the **first** `:` is passed to `stringToGameStatus`:

- `"standby"` → `Status::Standby`
- `"teleop"` → `Status::Teleop`
- Anything else → `Status::Unknown`

There is **no** acknowledgment to the PC.

### 5.4 Ordering and coexistence

- Controller packets and game-status packets are **independent**; the PC sends both at different rates (~20 Hz vs 1 Hz).
- The robot processes **one UDP packet per `updateController()` call**; bursts may require multiple `loop()` iterations to drain (no loop-until-empty in the snippet).

---

## 6. Firmware: `Minibot` behavior summary

### 6.1 `begin()`

- Serial 115200.
- `ledcAttach` on four pins (left, right, DC, servo).
- `WiFi.begin` with SSID/password; blocks until connected; prints IP.
- `udp.begin(UDP_PORT)` — listens on **2367**.
- `stopAllMotors()`.

### 6.2 `updateController()`

1. If no packet, return.
2. Read up to 255 bytes, NUL-terminate.
3. If `len == 8`, handle binary controller data (§5.2).
4. Else handle text: `ping` reply (§5.1), or `robotId:...` game status (§5.3).

### 6.3 Motor helpers

- `driveLeftMotor` / `driveRightMotor` / `driveDCMotor(float value)` with `value` nominally **-1.0..1.0**:
  - Scaled by `MOTOR_SPEED_MULTIPLYER` (20), clamped to **±20**, added to per-channel PWM offset, `ledcWrite`.
- `driveServoMotor(int angle)` with **-50..50** degrees mapped to pulse width then duty (see §3.3 for resolution note).

### 6.4 Example application (`minibots.ino`)

- Every loop: `updateController()` first.
- If `Standby` or `Unknown`: `stopAllMotors()`.
- If teleop: map **left Y** and **right Y** to `left`/`right` motor floats with a small deadband around center (roughly 125–130 on the 0–255 axis), then `driveLeftMotor` / `driveRightMotor`.

Axis math uses inverted/normalized form from 0–255 joystick bytes — match this if you replicate teleop feel.

---

## 7. End-to-end data flow (typical session)

1. Robot powers on, joins WiFi, listens on UDP 2367.
2. PC starts driver station; threads begin sending `ping` every 50 ms.
3. Robot receives `ping`, sends `pong:ROBOTNAME`, sets `connected`.
4. PC adds robot to list and captures `(IP, port)` from `recvfrom`.
5. User selects robot + controller, clicks Connect → `robot["controller"]` set.
6. At ~20 Hz, PC sends 8-byte controller state to `robot["addr"]`.
7. At 1 Hz, PC sends `ROBOTNAME:standby` or `ROBOTNAME:teleop`.
8. In teleop, firmware applies axes to motors; in standby/unknown, motors stop.

---

## 8. Unused or misleading symbols (for accurate rewrites)

In `minibot.h` / `.cpp`:

- **`DISCOVERY_PORT` (12345)** and **`COMMAND_PORT_BASE` (12346)** — not used; all traffic uses **`UDP_PORT` / 2367**.
- **`lastPingTime`**, **`lastCommandTime`**, **`assignedPort`** — member variables **not referenced** in the shown `minibot.cpp` (dead state).
- **`emergencyStop`** — declared, not used in the shown implementation.

Rely on **§5** for the real protocol, not these names.

---

## 9. Python dependencies

- **Standard library:** `socket`, `threading`, `time`, `struct`, `tkinter` / `ttk`.
- **Third party:** **Pygame** — joystick and event pump.

No requirements file is present in `old-code/`; pinning pygame for a new project is recommended.

---

## 10. Checklist for a replacement design

When changing protocol or UI, preserve or consciously replace:

| Concern | Old behavior |
|--------|----------------|
| Discovery | Broadcast `ping` → unicast `pong:name`; robot tracks `connected`. |
| Robot ID | String must match firmware `robotId` for game-status routing. |
| Controller stream | 6 unsigned axes + 16-bit button mask (only 4 bits used); **only applied in teleop** on device. |
| Game status | Periodic `name:standby|teleop`. |
| Timing | ~20 Hz controls, ~1 Hz status (Python); firmware one packet per `updateController` call. |
| Network | Same LAN as WiFi STA on ESP32; UDP firewalls must allow bidirectional UDP. |

This document is the single reference for how the old Python ↔ ESP32 **Minibot** stack worked end to end.
