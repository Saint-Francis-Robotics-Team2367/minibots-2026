# Prebuilt flashable images

These are the images the **browser** tools flash. They exist because a page can only
fetch what a CORS-enabled origin will serve:

- `raw.githubusercontent.com` sends `access-control-allow-origin: *`, so anything
  committed here is reachable from JavaScript.
- `micropython.org` sends **no** CORS header, so `/code-robot` cannot download the
  MicroPython image from upstream the way `scripts/flash-robot.sh` does.
- GitHub Actions artifacts need authentication and expire, so the dongle build
  output is not reachable from a page either.

Firebase Hosting only publishes `web/`, so these are not served from the site itself.

## Contents

| File | Chip | Offset | Written by |
|---|---|---|---|
| `ESP32_GENERIC-20260406-v1.28.0.bin` | esp32 | `0x1000` | committed by hand (pinned v1.28.0) |
| `dongle/bootloader.bin` | esp32s3 | `0x0` | CI — `esp32s3-dongle.yml` |
| `dongle/partition-table.bin` | esp32s3 | `0x8000` | CI — `esp32s3-dongle.yml` |
| `dongle/minicore_dongle.bin` | esp32s3 | `0x10000` | CI — `esp32s3-dongle.yml` |

`manifest.json` carries the offsets, sizes and SHA256s. The pages verify the hash
before writing, mirroring the check at `scripts/flash-robot.sh:151`.

## Do not hand-edit the dongle images

`.github/workflows/esp32s3-dongle.yml` rebuilds and commits `dongle/` on every push
that touches `firmware/esp32s3-dongle/**` or `firmware/common/**`. That is deliberate:
a stale dongle image is a silent protocol downgrade. The May 2026 local build in
`firmware/esp32s3-dongle/build/` predated the August speed-limit protocol, and
committing it by hand would have shipped a dongle that could not honour
`MC_MSG_SET_SPEED_LIMIT`. Let CI own these files.

The MicroPython image is different — it is pinned upstream and only changes when
`MPY_BIN_NAME` in `scripts/flash-robot.sh` changes, so it is committed by hand.

## The scripts are still the source of truth

`scripts/flash-robot.*` and `scripts/flash-dongle.*` remain the CLI path and the
offline fallback, and they pin the versions (ESP-IDF v5.3.2, MicroPython v1.28.0).
`flash-dongle.sh` builds from source rather than reading this folder. If a version
moves there, update `manifest.json` to match.
