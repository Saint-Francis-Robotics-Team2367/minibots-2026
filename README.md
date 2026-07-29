# minibots-2026 — MiniCore stack

End-to-end MiniCore system from [MINICORE_CLAUDE.md](docs/MINICORE_CLAUDE.md): a **browser driver station** (Gamepad API + WebHID), an **ESP32-S3** USB HID dongle (ESP-NOW + optional ST7789 + RGB), and an **ESP32** robot running **MicroPython** (ESP-NOW, tank drive, 250 ms failsafe) — students program the robot in Python (`firmware/esp32-robot/main.py`).

## Quickstart (fresh machine)

There's **no separate setup step** — each flash script installs the toolchain it
needs on its first run, then flashes. `flash-robot.*` installs `esptool` + `mpremote`
(pip); `flash-dongle.*` clones the pinned **ESP-IDF v5.3.2** into a repo-local,
git-ignored `.esp-idf/` and runs its installer. Both checks are idempotent, so
subsequent runs skip straight to flashing.

**macOS / Linux:**

```bash
git clone <this-repo> minibots-2026
cd minibots-2026

./scripts/reset-robot.sh             # first run installs tools + MicroPython on the ESP32 robot (firmware image auto-downloaded)
./scripts/flash-robot.sh             # upload your robot code (main.py + minibot.py)
./scripts/repl-robot.sh              # open a live MicroPython prompt (see print() output)
./scripts/flash-dongle.sh            # first run installs ESP-IDF v5.3.2, then builds + flashes the ESP32-S3 dongle
```

**Windows:** use the `.cmd` launchers — **double-click** them, or run from a terminal:

```bat
git clone <this-repo> minibots-2026
cd minibots-2026

reset-robot.cmd              :: first run installs tools + MicroPython on the ESP32 robot (firmware image auto-downloaded)
flash-robot.cmd              :: upload your robot code (main.py + minibot.py)
repl-robot.cmd               :: open a live MicroPython prompt (see print() output)
flash-dongle.cmd             :: first run installs ESP-IDF v5.3.2, then builds + flashes the ESP32-S3 dongle
```

> **Robot MicroPython image.** `reset-robot` downloads and verifies the pinned ESP32 MicroPython
> `.bin` into `firmware/esp32-robot/micropython/` automatically — no manual download needed. See
> [that folder's README](firmware/esp32-robot/micropython/README.md) for the pinned version and an
> offline fallback.

The `.cmd` files launch the matching `.ps1` with `-ExecutionPolicy Bypass`, so they work even
when PowerShell's execution policy blocks `.ps1` files directly
([about_Execution_Policies](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_execution_policies)) —
no machine-wide setting to change. Flags pass through, e.g. `flash-robot.cmd -Port COM5`.

> **Advanced:** to call the `.ps1` scripts directly, first allow local scripts once with
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or invoke ad-hoc with
> `powershell -ExecutionPolicy Bypass -File .\scripts\flash-robot.ps1`.
>
> The flash scripts add pip's user Scripts dir to PATH for their own run; if `mpremote`/`esptool`
> still aren't found afterward, open a **new** terminal so they're on PATH. The scripts pause on
> error (they won't flash-and-close). To capture a full log:
> `powershell -ExecutionPolicy Bypass -File .\scripts\flash-dongle.ps1 *>&1 | Tee-Object flash.log`
>
> Already have the tools (or a system ESP-IDF)? Pass `--skip-setup` / `-SkipSetup` to bypass the
> first-run install check.

The first-run install baked into each flash script is idempotent (safe to re-run). `flash-robot.*`
installs `esptool` + `mpremote` via pip; `flash-dongle.*` clones ESP-IDF into a repo-local,
git-ignored `.esp-idf/` and sources that SDK automatically — no manual `export` step.

> **Download size.** The ESP-IDF clone is shallow (`--depth 1 --shallow-submodules`), so it
> pulls current source only — a few hundred MB, not the multi-GB full history. The larger
> one-time cost is the compiler toolchain that `install` downloads into a per-user ESP-IDF
> cache (`~/.espressif`), shared across projects. All of it is one-time; the flash script's
> first-run install is incremental on later runs.

**Prerequisites** the scripts expect already present: `git`, **Python 3.9–3.12**, and
`cmake`/`ninja` (for the dongle's ESP-IDF).

> **Python version matters.** ESP-IDF v5.3.2 is only tested against **Python 3.9–3.12** —
> **3.11 is recommended**. Newer Pythons (3.13/3.14) can fail to install ESP-IDF's pinned
> tooling, so `flash-dongle` refuses its first-run install on them (the robot flash has no such
> restriction). ESP-IDF creates its own virtualenv, so 3.11 only needs to be on PATH when
> `flash-dongle` installs it — it doesn't have to be your system default.

- macOS: `brew install python@3.11 cmake ninja dfu-util` (then run `flash-dongle.sh` with `python3.11` on PATH)
- Debian/Ubuntu: `sudo apt-get install -y python3.11 cmake ninja-build dfu-util`
- Windows: install [Git for Windows](https://git-scm.com), [Python 3.11](https://python.org/downloads/release/python-3119/)
  (check *Add to PATH*), and `winget install Kitware.CMake`.

### Flash script options

**Robot** (`flash-robot.*`, MicroPython). There are also two convenience
wrappers: **`reset-robot.*`** (= `flash-robot --firmware`) and **`repl-robot.*`**
(= `flash-robot --repl`).

| bash (`--flag`) | PowerShell (`-Flag`) | Effect |
|-----------------|----------------------|--------|
| `--port /dev/…` (`-p`) | `-Port COM5` | Target a specific serial port (otherwise auto-detected). |
| `--firmware` | `-Firmware` | One-time: erase + write MicroPython (image auto-downloaded). Same as `reset-robot.*`. |
| `--repl` | `-Repl` | Open a live MicroPython prompt (see `print()` output). Same as `repl-robot.*`. |
| `--skip-setup` | `-SkipSetup` | Skip the first-run `esptool` + `mpremote` install check. |
| *(no flag)* | *(no flag)* | Upload `main.py` + `minibot.py` and reboot into it. |

**Dongle** (`flash-dongle.*`, ESP-IDF): `--port`/`-Port`, `--build-only`/`-BuildOnly`,
`--monitor`/`-Monitor`, `--skip-setup`/`-SkipSetup` (skip the first-run ESP-IDF install check).

**Dongle in download mode** (if flashing fails on native USB): hold **BOOT**, press+release
**RESET**, release **BOOT**, then re-run the dongle flash script.

### VSCode

VSCode works on any OS with the CLI flow above via its integrated terminal. For the robot,
edit `firmware/esp32-robot/main.py` and re-run `./scripts/flash-robot.sh`; the
[MicroPython (`ms-python`/` pico-w-go`-style)](https://marketplace.visualstudio.com/) extensions
can also upload over the same serial port if you prefer a button. For the dongle you can install
the **Espressif ESP-IDF** extension (open `firmware/esp32s3-dongle`, target `esp32s3`). The
scripts remain the source of truth for the pinned versions.

## Repository layout

| Path | Description |
|------|-------------|
| `flash-robot.*` / `reset-robot.*` / `repl-robot.*` / `flash-dongle.*` (`.sh`, `.cmd`, `.ps1`) | Flash helpers for each firmware; each installs its own toolchain on first run (robot: esptool + mpremote; dongle: ESP-IDF v5.3.2). `reset-robot` = firmware reset, `repl-robot` = live REPL (both wrap `flash-robot`). Windows: use the `.cmd` launchers. |
| [firmware/common/minicore_protocol.h](firmware/common/minicore_protocol.h) | Shared C structs, USB VID/PID, HID report IDs (keep in sync with JS + `minibot.py`). |
| [firmware/esp32s3-dongle/](firmware/esp32s3-dongle/) | ESP-IDF project for the Waveshare ESP32-S3-LCD-1.47 class USB HID dongle. |
| [firmware/esp32-robot/](firmware/esp32-robot/) | MicroPython robot code (classic ESP32) — students edit `main.py`. |
| [web/](web/) | Static driver station (Chrome or Edge; HTTPS or localhost). Deployed to <https://minibots.team2367.org>. |

## USB identity (WebHID filter)

- **VID** `0x303A` (Espressif)
- **PID** `0x4002` (project-specific; change in [minicore_protocol.h](firmware/common/minicore_protocol.h) and [web/js/constants.js](web/js/constants.js) together)

## Wi-Fi channel

ESP-NOW requires the same **802.11 channel** on the dongle and every robot.

- Dongle: default channel **6** at boot ([minicore_app.c](firmware/esp32s3-dongle/main/minicore_app.c) `CONFIG_MINICORE_WIFI_CHANNEL`, or add `CONFIG_MINICORE_WIFI_CHANNEL` via `sdkconfig`).
- Robot: the `channel=` argument to `Minibot(...)` in [main.py](firmware/esp32-robot/main.py) (must match the dongle).

## Robot code (MicroPython) — details

Students write robot behavior in [firmware/esp32-robot/main.py](firmware/esp32-robot/main.py)
using the `Minibot` class from `minibot.py`. Set the robot name, motor pins, and Wi-Fi channel
in the `Minibot(...)` constructor there — no rebuild, just re-upload.

- **One-time:** `./scripts/flash-robot.sh --firmware` installs the MicroPython runtime (download the
  `.bin` first — see [firmware/esp32-robot/micropython/README.md](firmware/esp32-robot/micropython/README.md)).
- **Each change:** `./scripts/flash-robot.sh` copies `main.py` + `minibot.py` to the board with
  `mpremote` and reboots; `./scripts/flash-robot.sh --repl` opens a live prompt to see `print()` output.

`minibot.py` handles ESP-NOW discovery/enable/joystick/heartbeat and the 250 ms motor failsafe,
speaking the same wire protocol as before ([minicore_protocol.h](firmware/common/minicore_protocol.h)),
so the dongle and web driver station are unchanged. See
[firmware/esp32-robot/README.md](firmware/esp32-robot/README.md) for the full student API.

## Dongle firmware (ESP-IDF) — details

**Target:** `esp32s3`, ESP-IDF **v5.3.x** (pinned to 5.3.2 in
[dependencies.lock](firmware/esp32s3-dongle/dependencies.lock)). Managed components
([main/idf_component.yml](firmware/esp32s3-dongle/main/idf_component.yml)) — TinyUSB, LVGL,
`esp_lvgl_port`, addressable LED — are fetched on first build.

`sdkconfig` is **generated per-machine** from
[sdkconfig.defaults](firmware/esp32s3-dongle/sdkconfig.defaults) and is git-ignored, so a fresh
clone always gets a correct config. `./scripts/flash-dongle.sh` runs `idf.py set-target esp32s3 && build`
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

**Live: <https://minibots.team2367.org>** — the deployed driver station. Open it in Chrome or
Edge, connect the dongle, run **Scan**, **Pair** a slot to a robot, enable **Global enable**, and
use gamepads at indices **0–3** matching each slot.

To run it locally instead, serve [web/](web/) over **HTTPS** or **http://localhost** (WebHID
requirement) and open `http://localhost:8080`:

```bash
cd web
python3 -m http.server 8080
```

### Deploying

`web/` is hosted on Firebase Hosting (project `minibots-2367`, configured in
[firebase.json](firebase.json) / [.firebaserc](.firebaserc)). To publish changes:

```bash
firebase deploy --only hosting
```

`minibots.team2367.org` is a Firebase Hosting custom domain. Its two Cloudflare DNS records in the
`team2367.org` zone must stay as-is:

| Record | Name | Value | Proxy |
| --- | --- | --- | --- |
| `CNAME` | `minibots` | `minibots-2367.web.app` | **DNS only** (grey cloud) |
| `TXT` | `_acme-challenge.minibots` | Firebase-issued challenge token | n/a |

> The CNAME must stay **DNS only**. Turning on Cloudflare's orange-cloud proxy puts Cloudflare's
> certificate in front of Firebase's and breaks the automatic cert renewal that reads the
> `_acme-challenge` TXT record. Don't delete that TXT record either — Firebase reuses it to renew.

## Security

WebHID grants the page access to your USB HID device; use a trusted origin and team hardware only.
