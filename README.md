# minibots-2026 — MiniCore stack

End-to-end MiniCore system from [MINICORE_CLAUDE.md](MINICORE_CLAUDE.md): a **browser driver station** (Gamepad API + WebHID), an **ESP32-S3** USB HID dongle (ESP-NOW + optional ST7789 + RGB), and **ESP32** robot firmware (ESP-NOW, tank drive, 250 ms failsafe).

## Repository layout

| Path | Description |
|------|-------------|
| [firmware/common/minicore_protocol.h](firmware/common/minicore_protocol.h) | Shared C structs, USB VID/PID, HID report IDs (keep in sync with JS). |
| [firmware/esp32s3-dongle/](firmware/esp32s3-dongle/) | ESP-IDF project for the Waveshare ESP32-S3-LCD-1.47 class USB HID dongle. |
| [firmware/esp32-robot/](firmware/esp32-robot/) | PlatformIO / Arduino robot firmware (classic ESP32). |
| [web/](web/) | Static driver station (Chrome or Edge; HTTPS or localhost). Deployed on [Firebase Hosting](https://firebase.google.com/docs/hosting). |

## USB identity (WebHID filter)

- **VID** `0x303A` (Espressif)
- **PID** `0x4002` (project-specific; change in [minicore_protocol.h](firmware/common/minicore_protocol.h) and [web/js/constants.js](web/js/constants.js) together)

## Wi-Fi channel

ESP-NOW requires the same **802.11 channel** on the dongle and every robot.

- Dongle: default channel **6** at boot ([main.c](firmware/esp32s3-dongle/main/main.c) `CONFIG_MINICORE_WIFI_CHANNEL`, or add `CONFIG_MINICORE_WIFI_CHANNEL` via `sdkconfig`).
- Robot: [platformio.ini](firmware/esp32-robot/platformio.ini) `MINICORE_WIFI_CHANNEL=6` (must match the dongle).

## ESP32-S3 dongle (ESP-IDF)

**Requirements:** ESP-IDF v5.x with TinyUSB device support, target `esp32s3`.

```bash
cd firmware/esp32s3-dongle
idf.py set-target esp32s3
idf.py build flash monitor
```

**USB flashing (native USB, no UART bridge):** enter download mode: hold **BOOT**, press **RESET**, release **RESET**, release **BOOT**; then flash.

**Note:** ESP-IDF’s `tinyusb_config_t` layout changed across minor versions. This project uses the **flat** fields (`device_descriptor`, `string_descriptor`, `configuration_descriptor`) as in ESP-IDF v5.3 `tusb_hid` examples. If your IDF uses the newer `TINYUSB_DEFAULT_CONFIG()` / nested `descriptor` struct, adjust [main.c](firmware/esp32s3-dongle/main/main.c) accordingly.

Managed components ([main/idf_component.yml](firmware/esp32s3-dongle/main/idf_component.yml)) are fetched on first build (LVGL, `esp_lvgl_port`, addressable LED on GPIO38).

**LCD (ST7789)** uses Waveshare’s pinout: MOSI 45, SCLK 40, CS 42, DC 41, RST 39, backlight 48 ([wiki](https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47)).

## Robot (PlatformIO)

```bash
cd firmware/esp32-robot
pio run -t upload
```

Customize robot name and pins via [platformio.ini](firmware/esp32-robot/platformio.ini) build flags (`MINICORE_ROBOT_NAME`, `LEFT_MOTOR_PIN`, `RIGHT_MOTOR_PIN`). Requires **arduino-esp32** with ESP-IDF 5-style `esp_now_recv_info_t` receive callback (Arduino ESP32 core 3.x).

## Web driver station

**Production:** [https://minibots-2367.web.app](https://minibots-2367.web.app) (HTTPS; WebHID works on this origin). Connect the dongle, run **Scan**, **Pair** a slot to a robot, enable **Global enable**, and use gamepads at indices **0–3** matching each slot.

**Deploy** (from repo root; requires [Firebase CLI](https://firebase.google.com/docs/cli) and access to the `minibots-2367` project):

```bash
firebase deploy --only hosting
```

Config: [firebase.json](firebase.json) (public root is [web/](web/)), [`.firebaserc`](.firebaserc).

**Local development:** serve [web/](web/) over **HTTPS** or **http://localhost** (WebHID requirement):

```bash
cd web
python3 -m http.server 8080
```

Open `http://localhost:8080` for the same workflow as production.

## Security

WebHID grants the page access to your USB HID device; use a trusted origin and team hardware only.
