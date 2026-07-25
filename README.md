# minibots-2026 — MiniCore stack

End-to-end MiniCore system from [MINICORE_CLAUDE.md](MINICORE_CLAUDE.md): a **browser driver station** (Gamepad API + WebHID), an **ESP32-S3** USB HID dongle (ESP-NOW + optional ST7789 + RGB), and **ESP32** robot firmware (ESP-NOW, tank drive, 250 ms failsafe).

## Quickstart (fresh machine)

**macOS / Linux:**

```bash
git clone <this-repo> minibots-2026
cd minibots-2026
./setup.sh            # installs PlatformIO + pinned ESP-IDF v5.3.2 (~1-2 GB, one time)

./flash-robot.sh      # build + flash the ESP32 robot   (PlatformIO)
./flash-dongle.sh     # build + flash the ESP32-S3 dongle (ESP-IDF)
```

**Windows (PowerShell):**

```powershell
git clone <this-repo> minibots-2026
cd minibots-2026
.\setup.ps1           # installs PlatformIO + pinned ESP-IDF v5.3.2 (~1-2 GB, one time)

.\flash-robot.ps1     # build + flash the ESP32 robot   (PlatformIO)
.\flash-dongle.ps1    # build + flash the ESP32-S3 dongle (ESP-IDF)
```

> If PowerShell blocks the scripts ("running scripts is disabled"), either run
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or launch each with
> `powershell -ExecutionPolicy Bypass -File .\setup.ps1`. After `setup.ps1` installs
> PlatformIO, open a **new** terminal so `pio` is on PATH.
>
> The scripts pause on error (they won't flash-and-close). If you still can't read the
> output, run from an open PowerShell window and tee it to a file:
> `powershell -ExecutionPolicy Bypass -File .\setup.ps1 *>&1 | Tee-Object setup.log`

The setup script is idempotent (safe to re-run). It installs PlatformIO via pip and clones
ESP-IDF into a repo-local, git-ignored `.esp-idf/`; the flash scripts source that SDK
automatically — no manual `export` step.

**Prerequisites** the script expects already present: `git`, Python 3.9+, and `cmake`/`ninja`
(for ESP-IDF).
- macOS: `brew install cmake ninja dfu-util`
- Debian/Ubuntu: `sudo apt-get install -y cmake ninja-build dfu-util`
- Windows: install [Git for Windows](https://git-scm.com), [Python](https://python.org)
  (check *Add to PATH*), and `winget install Kitware.CMake`.

### Flash script options

| bash (`--flag`) | PowerShell (`-Flag`) | Effect |
|-----------------|----------------------|--------|
| `--port /dev/…` (`-p`) | `-Port COM5` | Target a specific serial port (otherwise auto-detected). |
| `--build-only` | `-BuildOnly` | Compile without flashing. |
| `--monitor` (`-m`) | `-Monitor` | Open the serial monitor after flashing. |

**Dongle in download mode** (if flashing fails on native USB): hold **BOOT**, press+release
**RESET**, release **BOOT**, then re-run the dongle flash script.

### VSCode

VSCode works on any OS with the CLI flow above via its integrated terminal. For a
button-driven experience you can also install the **PlatformIO IDE** extension (open the
`firmware/esp32-robot` folder → Build/Upload in the status bar) and the **Espressif ESP-IDF**
extension (open `firmware/esp32s3-dongle`, target `esp32s3`). The scripts remain the
source of truth for the pinned versions.

## Repository layout

| Path | Description |
|------|-------------|
| [setup.sh](setup.sh) / [setup.ps1](setup.ps1) | One-shot toolchain bootstrap (PlatformIO + ESP-IDF v5.3.2), macOS/Linux and Windows. |
| [flash-robot.sh](flash-robot.sh) / [flash-dongle.sh](flash-dongle.sh) (+ `.ps1`) | Build + flash helpers for each firmware. |
| [firmware/common/minicore_protocol.h](firmware/common/minicore_protocol.h) | Shared C structs, USB VID/PID, HID report IDs (keep in sync with JS). |
| [firmware/esp32s3-dongle/](firmware/esp32s3-dongle/) | ESP-IDF project for the Waveshare ESP32-S3-LCD-1.47 class USB HID dongle. |
| [firmware/esp32-robot/](firmware/esp32-robot/) | PlatformIO / Arduino robot firmware (classic ESP32). |
| [web/](web/) | Static driver station (Chrome or Edge; HTTPS or localhost). |

## USB identity (WebHID filter)

- **VID** `0x303A` (Espressif)
- **PID** `0x4002` (project-specific; change in [minicore_protocol.h](firmware/common/minicore_protocol.h) and [web/js/constants.js](web/js/constants.js) together)

## Wi-Fi channel

ESP-NOW requires the same **802.11 channel** on the dongle and every robot.

- Dongle: default channel **6** at boot ([minicore_app.c](firmware/esp32s3-dongle/main/minicore_app.c) `CONFIG_MINICORE_WIFI_CHANNEL`, or add `CONFIG_MINICORE_WIFI_CHANNEL` via `sdkconfig`).
- Robot: [platformio.ini](firmware/esp32-robot/platformio.ini) `MINICORE_WIFI_CHANNEL=6` (must match the dongle).

## Robot firmware (PlatformIO) — details

Customize robot name and pins via [platformio.ini](firmware/esp32-robot/platformio.ini) build
flags (`MINICORE_ROBOT_NAME`, `LEFT_MOTOR_PIN`, `RIGHT_MOTOR_PIN`). Requires **arduino-esp32**
with ESP-IDF 5-style `esp_now_recv_info_t` receive callback (Arduino ESP32 core 3.x) —
PlatformIO fetches this automatically on first build.

`./flash-robot.sh` wraps `pio run -t upload` in `firmware/esp32-robot`; you can still run
`pio` directly there if you prefer.

## Dongle firmware (ESP-IDF) — details

**Target:** `esp32s3`, ESP-IDF **v5.3.x** (pinned to 5.3.2 in
[dependencies.lock](firmware/esp32s3-dongle/dependencies.lock)). Managed components
([main/idf_component.yml](firmware/esp32s3-dongle/main/idf_component.yml)) — TinyUSB, LVGL,
`esp_lvgl_port`, addressable LED — are fetched on first build.

`sdkconfig` is **generated per-machine** from
[sdkconfig.defaults](firmware/esp32s3-dongle/sdkconfig.defaults) and is git-ignored, so a fresh
clone always gets a correct config. `./flash-dongle.sh` runs `idf.py set-target esp32s3 && build`
for you. If you ever change `sdkconfig.defaults`, run a one-time
`idf.py fullclean` in `firmware/esp32s3-dongle` so the new options apply.

**Note:** ESP-IDF's `tinyusb_config_t` layout changed across minor versions. This project uses
the **flat** fields (`device_descriptor`, `string_descriptor`, `configuration_descriptor`) as in
ESP-IDF v5.3 `tusb_hid` examples — hence the version pin. If you retarget a newer IDF that uses
`TINYUSB_DEFAULT_CONFIG()` / a nested `descriptor` struct, adjust
[minicore_usb.c](firmware/esp32s3-dongle/main/minicore_usb.c) accordingly.

**LCD (ST7789)** uses Waveshare's pinout: MOSI 45, SCLK 40, CS 42, DC 41, RST 39, backlight 48
([wiki](https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47)). That module is **ESP32-S3R8** with
**8 MB Octal PSRAM**; [sdkconfig.defaults](firmware/esp32s3-dongle/sdkconfig.defaults) turns
PSRAM on for LVGL.

CI builds the dongle firmware on every change and uploads flashable artifacts
([.github/workflows/esp32s3-dongle.yml](.github/workflows/esp32s3-dongle.yml)).

## Web driver station

Serve [web/](web/) over **HTTPS** or **http://localhost** (WebHID requirement):

```bash
cd web
python3 -m http.server 8080
```

Open `http://localhost:8080`, connect the dongle, run **Scan**, **Pair** a slot to a robot,
enable **Global enable**, and use gamepads at indices **0–3** matching each slot.

## Security

WebHID grants the page access to your USB HID device; use a trusted origin and team hardware only.
