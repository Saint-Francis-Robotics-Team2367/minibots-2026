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

./scripts/flash-robot.sh --firmware  # first run installs tools + MicroPython on the ESP32 robot (firmware image auto-downloaded)
./scripts/flash-robot.sh             # upload your robot code (main.py + minibot.py)
./scripts/flash-robot.sh --repl      # open a live MicroPython prompt (see print() output)
./scripts/flash-dongle.sh            # first run installs ESP-IDF v5.3.2, then builds + flashes the ESP32-S3 dongle
```

**Windows:** use the `.cmd` launchers — `flash-robot.cmd` sits at the repo root so you can
**double-click** it to upload your code. For the flagged variants, run them from a terminal:

```bat
git clone <this-repo> minibots-2026
cd minibots-2026

flash-robot.cmd -Firmware            :: first run installs tools + MicroPython on the ESP32 robot (firmware image auto-downloaded)
flash-robot.cmd                      :: upload your robot code (main.py + minibot.py)
flash-robot.cmd -Repl                :: open a live MicroPython prompt (see print() output)
scripts\flash-dongle.cmd             :: first run installs ESP-IDF v5.3.2, then builds + flashes the ESP32-S3 dongle
```

> **Robot MicroPython image.** `flash-robot --firmware` downloads and verifies the pinned ESP32 MicroPython
> `.bin` into `firmware/esp32-robot/micropython/` automatically — no manual download needed. See
> [that folder's README](firmware/esp32-robot/micropython/README.md) for the pinned version and an
> offline fallback.

The `.cmd` files launch the matching `.ps1` with `-ExecutionPolicy Bypass`, so they work even
when PowerShell's execution policy blocks `.ps1` files directly
([about_Execution_Policies](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_execution_policies)) —
no machine-wide setting to change. Flags pass through, e.g. `flash-robot.cmd -Port COM5`.
`flash-robot.cmd` lives at the repo root and drives `scripts\flash-robot.ps1`; `flash-dongle.cmd`
stays in `scripts\` next to its own `.ps1`.

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

**Prerequisites** the scripts expect already present: `git` and `cmake`/`ninja` (for the
dongle's ESP-IDF). **Python 3.9–3.12** is needed too, but on Windows the scripts install it
for you if it's missing.

> **Python version matters.** ESP-IDF v5.3.2 is only tested against **Python 3.9–3.12** —
> **3.11 is recommended**. Newer Pythons (3.13/3.14) can fail to install ESP-IDF's pinned
> tooling, so `flash-dongle` won't build with them (the robot flash has no such restriction).
> Both scripts pick an interpreter by *running* each candidate, so an installed `python3.11`
> is found even when a newer Python owns the plain `python`/`python3` name — 3.11 doesn't
> have to be your system default.

> **Windows installs Python automatically.** If `flash-dongle.ps1`/`flash-robot.ps1` find no
> supported interpreter, they download Python 3.11 from python.org, verify its SHA256, and
> install it for your user account only (no administrator rights, no UAC prompt). They add it
> to your PATH only when you had no working Python at all — if you already have one, it stays
> in charge of the `python` name and the new one is reached via `py -3.11`. To be told what to
> install instead, set `$env:MINICORE_NO_PYINSTALL='1'`.
>
> The `.sh` scripts don't auto-install: every option there is either privileged (`apt`/`dnf`
> need `sudo`) or reshapes a package manager you own (`brew`), so they print the one command
> to run instead.

- macOS: `brew install python@3.11 cmake ninja dfu-util`
- Debian/Ubuntu: `sudo apt-get install -y python3.11 cmake ninja-build dfu-util`
- Windows: install [Git for Windows](https://git-scm.com) and `winget install Kitware.CMake`
  (Python is handled for you; to do it by hand, use
  [Python 3.11](https://python.org/downloads/release/python-3119/) with *Add to PATH* checked).

## Type Checking with Pyright

Before flashing your code, check for type errors with **pyright**:

**Install & run:**
```bash
cd firmware/esp32-robot
uv pip install pyright
uv run pyright .
```

Or with your system Python:
```bash
pip install pyright
pyright firmware/esp32-robot
```

Pyright will catch attribute typos and type mismatches. Type checks also run automatically on pull requests against `main`.

### Flash script options

**Robot** (`flash-robot.*`, MicroPython).

| bash (`--flag`) | PowerShell (`-Flag`) | Effect |
|-----------------|----------------------|--------|
| `--port /dev/…` (`-p`) | `-Port COM5` | Target a specific serial port (otherwise auto-detected). |
| `--firmware` | `-Firmware` | One-time: erase + write MicroPython (image auto-downloaded). |
| `--repl` | `-Repl` | Open a live MicroPython prompt (see `print()` output). |
| `--skip-setup` | `-SkipSetup` | Skip the first-run `esptool` + `mpremote` install check. |
| *(no flag)* | *(no flag)* | Upload `main.py` + `minibot.py` and reboot into it. |

**Dongle** (`flash-dongle.*`, ESP-IDF): `--port`/`-Port`, `--build-only`/`-BuildOnly`,
`--monitor`/`-Monitor`, `--skip-setup`/`-SkipSetup` (skip the first-run ESP-IDF install check).

> **After flashing, the dongle stays in the bootloader.** esptool's `--after hard_reset`
> drives reset over RTS, which does not stick on this board's native USB — it will still
> enumerate as `PID_1001` with a COM port. Press **RESET** (without holding BOOT) or replug
> the cable; it then comes back as `PID_4002` with no COM port, which is the HID firmware
> running normally.

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
| `flash-robot.cmd` (repo root) | Windows one-stop launcher for the robot — **double-click** it, or pass flags from a terminal. Drives `scripts/flash-robot.ps1`. |
| [scripts/](scripts/) | The rest of the flash helpers: `flash-robot.{sh,ps1}` and `flash-dongle.{sh,cmd,ps1}`. Each installs its own toolchain on first run (robot: esptool + mpremote; dongle: ESP-IDF v5.3.2). `flash-robot` also does firmware reset (`--firmware`) and live REPL (`--repl`). |
| [firmware/common/minicore_protocol.h](firmware/common/minicore_protocol.h) | **Wire format**: packet structs, message types, USB VID/PID, HID report IDs, `MC_PROTOCOL_VERSION`. **Compiled into the dongle** — editing it means `flash-dongle` *and* `flash-robot` *and* a web reload, and bump the version so a stale dongle is detected. |
| [firmware/common/minicore_policy.h](firmware/common/minicore_policy.h) | **Behaviour**: timeouts, neutral-trim range. The dongle neither uses nor includes it, so changes here need only `flash-robot` + a web reload. Put new policy constants here, not in the protocol header. |
| [firmware/esp32s3-dongle/](firmware/esp32s3-dongle/) | ESP-IDF project for the Waveshare ESP32-S3-LCD-1.47 class USB HID dongle. |
| [firmware/esp32-robot/](firmware/esp32-robot/) | MicroPython robot code (classic ESP32) — students edit `main.py`. |
| [web/](web/) | The site: student documentation (`/`, `docs/`) plus the three hardware tools (Chrome or Edge; HTTPS or localhost). Deployed to <https://minibots.team2367.org>. `js/` is dependency-free ES modules; `lib/` is the robot library served for upload — **CI fails if it drifts** from `firmware/esp32-robot/`; `test/` is plain `node` scripts. |
| [firmware/prebuilt/](firmware/prebuilt/) | Flashable images the **browser** tools write. They live here because a page can only fetch from a CORS-enabled origin, and neither micropython.org nor a CI artifact qualifies. `dongle/` is written by CI — do not hand-edit it. |

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

`minibot.py` handles ESP-NOW discovery/enable/joystick/heartbeat, the 250 ms motor failsafe,
the motor slew limit and the driver-station neutral trim, all speaking
[minicore_protocol.h](firmware/common/minicore_protocol.h). That header is shared with the
dongle and the web app, so protocol changes land in all three at once. See
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

## The website

**Live: <https://minibots.team2367.org>** — student documentation plus three hardware
tools, and everything the robots need is reachable from a browser. **Chrome or Edge**,
over HTTPS or `http://localhost`: the tools talk to USB through WebHID and Web Serial,
which Safari and Firefox do not implement. Devices are granted once per browser, then
reconnect on their own. The documentation pages read in any browser.

**Documentation** — a wiki for students, with a sidebar nav shared by these four pages.
`/` is the landing page; the guides live under `/docs`.

| Page | What it does |
| --- | --- |
| [`/`](https://minibots.team2367.org/) | Home — what a Minibot is, and an index of everything else |
| [`/docs/build`](https://minibots.team2367.org/docs/build) | Building the robot — **placeholder**, content pending |
| [`/docs/wiring`](https://minibots.team2367.org/docs/wiring) | Wiring the robot — **placeholder**, content pending |
| [`/docs/programming`](https://minibots.team2367.org/docs/programming) | Programming the robot — the loop, the full `Minibot` API, and the traps |

**Tools** — each needs different hardware plugged in.

| Page | What it does | Needs |
| --- | --- | --- |
| [`/control`](https://minibots.team2367.org/control) | Driver station — pair, enable, speed limit, neutral trim | Dongle + gamepad |
| [`/code-robot`](https://minibots.team2367.org/code-robot) | Read, edit and push `main.py`; install MicroPython on a fresh board | Robot on USB |
| [`/flash-dongle`](https://minibots.team2367.org/flash-dongle) | Write the current dongle firmware | Dongle in its bootloader |

The rail nav at the top of every page holds **exactly four** entries (Home plus the
three tools) and must stay that way: `css/core.css`'s three-track rail grid is what
keeps that nav in the same position on every page, and a fifth entry wraps
`/control`'s telemetry onto a second row. New documentation pages go in the sidebar
(`.doc__side`), which is copied into each page's HTML — there is no build step, and a
docs nav has to work with JavaScript off.

`/docs/programming` is written from `firmware/esp32-robot/README.md`, `web/lib/minibot.py`
and `web/templates/main.py`. **Changing the student-facing API in those means updating
that page too** — nothing enforces it.

**No clone, no terminal, no Python install** for the everyday path. The flash scripts
remain the CLI route, the offline fallback, and the source of truth for pinned
versions.

### Editing robot code in the browser

`/code-robot` has three modes:

- **Pull** — read `main.py` and the saved calibration off a robot into the editor. A
  board with no `main.py` is offered the starter template instead of a blank page.
- **Upload and run** — write `main.py` plus the four library files, restart the robot,
  and stream its `print()` output. The library is served from the site, so what lands
  on a robot always matches the deployed page.
- **Reflash** — erase the board and install MicroPython, then write all six files
  (including `boot.py`, which no flash script sends). This is the fresh-ESP32 path.
  **It erases everything on the robot**, so it is separated from the other two, gated
  behind a typed confirmation, and offers to pull first.

The editor buffer lives in `sessionStorage`: it survives a reload but not closing the
tab, because the robot is the source of truth for code. After an upload the robot holds
the only copy — hence the close warning and the **Download main.py** button.

Two things this retires from the command line:

- **`calib.json` is visible.** A calibration applied from the driver station is saved on
  the robot and loaded *over* whatever `main.py` sets (`minibot.py:305`), which is a
  documented source of confusion. The page shows the saved neutrals and says so.
- **`clear_calibration()` has a button.** It used to require
  `flash-robot --repl`.

> **No type checking on browser-authored code.**
> [pyright](.github/workflows/pyright.yml) runs on pull requests to `main`, so a student
> who edits in the browser and never opens a PR loses that gate. Raw-paste mode compiles
> as it receives, so syntax errors still surface on upload — but the attribute and type
> errors pyright exists to catch do not. This is a real regression from the git flow.

### Flashing the dongle in the browser

`/flash-dongle` writes the three images at the offsets the build itself declares. The
dongle's firmware is **HID-only**, so while it runs there is no serial port at all — you
must hold **BOOT** and tap **RESET** to expose the ROM bootloader first. That is the same
step the CLI flasher needs, and the page leads with it.

The images come from `firmware/prebuilt/dongle/`, which
[esp32s3-dongle.yml](.github/workflows/esp32s3-dongle.yml) builds and commits on every
push: `raw.githubusercontent.com` sends `access-control-allow-origin: *`, so a page can
fetch them, while CI artifacts need authentication and expire. Each image's SHA256 is
checked before it reaches flash. **This page needs internet access** — an accepted trade,
recorded in [the migration plan](docs/WEB_MIGRATION_PLAN.md).

### Driver station

**Live: <https://minibots.team2367.org/control>** — the deployed driver station. Open it in Chrome or
Edge and click **Connect dongle** once to grant this browser access to it. After that the page
reconnects to that dongle by itself — on load, and when you plug it in with the page already
open — and **Connect dongle** stays as the manual fallback. **Disconnect** stays disconnected
until you click Connect or replug the dongle.

Connecting also scans, so robots and their calibration appear on their own; **Scan** re-runs it
by hand. **Pair** a slot to a robot, drag **Speed limit** down if the robots should be slower than
full output (it applies to every robot, survives a reload, and names any robot that hasn't
confirmed it), set the per-motor
**Neutral µs** if the robot creeps (see
[the robot README](firmware/esp32-robot/README.md#setting-neutral-from-the-driver-station)),
enable **Global enable**, and
use gamepads at indices **0–3** matching each slot.

### Local development

Use the **Firebase emulator**, not `python3 -m http.server`. The site relies on
`cleanUrls`, which nothing else emulates — under `http.server`, `/control` returns
**404** because only `control.html` exists on disk.

```bash
firebase emulators:start --only hosting   # http://127.0.0.1:5000
```

WebHID and Web Serial both accept `http://localhost`, so no local TLS is needed.

There are no dependencies to install: the browser code is plain ES modules, and the
only third-party asset is CodeMirror, loaded from a CDN with SRI. Tests are plain
`node` scripts — see [web/test/README.md](web/test/README.md).

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
