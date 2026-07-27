# MicroPython firmware for the robot ESP32

The robot runs stock **MicroPython for generic ESP32**. This folder is where the
firmware image (`.bin`) lives so `scripts/flash-robot.sh --firmware` can find it.

## Getting the firmware

**You normally don't need to do anything here.** The `.bin` is **not committed**
to the repo (it's large and versioned upstream), so on the first
`scripts/flash-robot.sh --firmware` (or `.ps1 -Firmware`) the script
**downloads the pinned firmware into this folder automatically and verifies it
by SHA256**.

- Pinned version: **v1.28.0** → `ESP32_GENERIC-20260406-v1.28.0.bin`
- Source: <https://micropython.org/download/ESP32_GENERIC/>

Manual fallback (only if the auto-download can't reach the internet): grab that
`.bin` from the download page and save it into **this folder**
(`firmware/esp32-robot/micropython/`). `--firmware` picks up the newest
`ESP32_GENERIC-*.bin` here.

## What the flash does

For a classic ESP32, MicroPython is written at offset **`0x1000`**:

```bash
esptool.py --chip esp32 --port <PORT> erase_flash
esptool.py --chip esp32 --port <PORT> write_flash -z 0x1000 ESP32_GENERIC-*.bin
```

`scripts/flash-robot.sh --firmware` runs both steps for you. After it finishes, use
`./scripts/flash-robot.sh` (no flags) to upload `main.py` + `minibot.py`.

## Notes

- Requires `esptool` and `mpremote` (installed automatically on the first run of
  `scripts/flash-robot.sh` / `scripts/flash-robot.ps1`).
- The ESP-NOW and PWM APIs used by `minibot.py` are part of the standard ESP32
  MicroPython build — no custom firmware needed.
