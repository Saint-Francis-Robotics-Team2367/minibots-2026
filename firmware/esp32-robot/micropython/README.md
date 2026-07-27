# MicroPython firmware for the robot ESP32

The robot runs stock **MicroPython for generic ESP32**. This folder is where the
firmware image (`.bin`) lives so `scripts/flash-robot.sh --firmware` can find it.

## Getting the firmware

The `.bin` is **not committed** to the repo (it's large and versioned upstream).
Download it once from the official site:

- Download page: <https://micropython.org/download/ESP32_GENERIC/>
- Pinned version: **v1.28.0** → `ESP32_GENERIC-20260406-v1.28.0.bin`

Save the `.bin` into **this folder** (`firmware/esp32-robot/micropython/`).
`scripts/flash-robot.sh --firmware` picks up the newest `ESP32_GENERIC-*.bin` here.

> Verify the download against the SHA256 published on the download page before
> flashing.

## What the flash does

For a classic ESP32, MicroPython is written at offset **`0x1000`**:

```bash
esptool.py --chip esp32 --port <PORT> erase_flash
esptool.py --chip esp32 --port <PORT> write_flash -z 0x1000 ESP32_GENERIC-*.bin
```

`scripts/flash-robot.sh --firmware` runs both steps for you. After it finishes, use
`./scripts/flash-robot.sh` (no flags) to upload `main.py` + `minibot.py`.

## Notes

- Requires `esptool` and `mpremote` (installed by `scripts/setup.sh` / `scripts/setup.ps1`).
- The ESP-NOW and PWM APIs used by `minibot.py` are part of the standard ESP32
  MicroPython build — no custom firmware needed.
