# MiniCore Robot (MicroPython)

Your robot runs **MicroPython** on a classic ESP32. You program its behavior in
**`main.py`** using the friendly `Minibot` library — no compiling, no C++.

```
firmware/esp32-robot/
  main.py       <-- YOUR code. Edit this.
  minibot.py    <-- the library (don't edit)
  boot.py       <-- runs at power-up (don't edit)
  micropython/  <-- the MicroPython firmware .bin goes here
```

## One-time: flash MicroPython onto the board

You only do this **once per robot** (or when upgrading MicroPython). It installs
the Python runtime onto the ESP32. The firmware image is downloaded and verified
automatically on first use — you don't need to fetch anything by hand.

```bash
# from the repo root
./scripts/flash-robot.sh --firmware            # auto-detects the port
./scripts/flash-robot.sh --firmware -p /dev/cu.usbserial-XXXX
```

Windows: run `flash-robot.cmd -Firmware` from the repo root (or `scripts\flash-robot.ps1 -Firmware`).

See `micropython/README.md` for details on the firmware `.bin`.

## Every time: upload your code

After editing `main.py` (and only if you changed it, `minibot.py`), push it to
the robot:

```bash
./scripts/flash-robot.sh                       # copies main.py + minibot.py, then reboots
./scripts/flash-robot.sh -p /dev/cu.usbserial-XXXX
./scripts/flash-robot.sh --repl                # open a live Python prompt / see print() output
```

Windows: run `flash-robot.cmd` from the repo root (or `scripts\flash-robot.ps1`), e.g.
`flash-robot.cmd -Repl`.

On power-up the robot waits ~1.5 s before running your `main.py` (you'll see a
`[boot] Starting in 1500 ms…` message). That pause is the window the upload
tool uses to interrupt the board, so uploads work even though `main.py` runs a
tight loop. It's handled in `boot.py` — you don't need to do anything.

## Writing robot code

Open `main.py`. The `Minibot` object gives you everything:

| What | Call |
|------|------|
| Set up (once) | `bot.begin()` |
| Refresh each loop (call first) | `bot.update()` |
| Sticks (−1.0..1.0) | `get_left_x/y()`, `get_right_x/y()` |
| Triggers (−1.0..1.0) | `get_left_trigger()`, `get_right_trigger()` |
| Buttons (bool) | `get_cross()`, `get_circle()`, `get_square()`, `get_triangle()` |
| Enabled? | `get_game_status()` → `Minibot.TELEOP` / `Minibot.STANDBY` |
| Motors (−1.0..1.0) | `drive_left_motor(v)`, `drive_right_motor(v)`, `stop_all_motors()` |

Set your robot's **name**, **motor pins**, and **Wi-Fi channel** in the
`Minibot(...)` line at the top of `main.py`. The channel must match the dongle
(default `6`).

### Motor commands ramp

`drive_left_motor()` / `drive_right_motor()` move *toward* the value you pass
rather than jumping to it — by default a full forward-to-reverse reversal takes
500 ms. Slamming the sticks through neutral otherwise puts the battery voltage
and the motor's back-EMF in series, drawing roughly twice stall current; the rail
sags and the ESP32's brownout detector resets the board, which looks from the
driver station like the robot dropping its connection.

The rate is fixed in the library (`_SLEW_PER_S` in `minibot.py`) and is **not** a
`Minibot(...)` option — it guards the hardware, so robot code can't turn it off.
If a drivetrain genuinely needs a different rate, change it there and it applies
to every robot. Going below ~300 ms per reversal stops helping anyway: the motor
hasn't shed enough speed by then for the ramp to bound the current.

`stop_all_motors()` is **never** ramped, so the 250 ms link failsafe and the
disable path still cut the motors instantly.

> Slew limiting bounds the current; it doesn't fix the wiring that couldn't
> supply it. If a robot browns out, still add bulk capacitance across the ESC's
> power input and check the battery connectors.

## How it connects

The robot speaks **ESP-NOW** to the USB dongle, which the browser driver station
(`web/`) talks to over USB. The wire format is identical to the previous C++
firmware (`firmware/common/minicore_protocol.h`), so the dongle and web app are
unchanged. `minibot.py` answers discovery, honors enable/disable, decodes
joystick packets, sends heartbeats, and stops the motors if the link drops for
more than 250 ms.
