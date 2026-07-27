# ESP32-S3-LCD-1.47-Test — developer guide

This document describes the **Waveshare ESP32-S3-LCD-1.47** demo firmware in this folder: how the project is laid out, how to build and configure it, and how to drive the **LCD**, **LVGL UI**, **backlight**, **addressable RGB LED**, **SD card**, and **wireless** pieces.

Official hardware reference: [Waveshare ESP32-S3-LCD-1.47 wiki](https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47).

---

## 1. Hardware this code expects

| Subsystem | Detail |
|-----------|--------|
| MCU | ESP32-S3 (this tree targets **esp32s3**) |
| PSRAM | **8 MB Octal PSRAM** — enabled in `sdkconfig.defaults` (`CONFIG_SPIRAM`, octal @ 80 MHz) |
| Flash | **16 MB** image layout assumed (`CONFIG_ESPTOOLPY_FLASHSIZE_16MB`) |
| LCD | **ST7789T**, **172×320** RGB565, SPI |
| Onboard LED | **1× WS2812-style** pixel on **GPIO 38** (RMT driver via `espressif/led_strip`) |
| Backlight | **GPIO 48**, PWM via LEDC (not a simple on/off GPIO in final setup) |
| SD | **SDMMC** 1-bit (or wider) on GPIOs defined in `SD_MMC.h` |

Pin definitions for the panel and backlight live in `main/LCD_Driver/ST7789.h`. SD lines are in `main/SD_Card/SD_MMC.h`.

---

## 2. Software prerequisites

- **ESP-IDF v5.x** (the repo was verified with IDF 5.3). Older IDF may differ for `esp_lcd_new_panel_st7789t` and component APIs.
- Python environment as required by ESP-IDF.

### 2.1 First-time build

From a shell where ESP-IDF is exported (`source $IDF_PATH/export.sh`):

```bash
cd ESP32-S3-LCD-1.47-Test
idf.py set-target esp32s3
idf.py build
```

On first build, the **component manager** resolves:

- `lvgl/lvgl` **~8.3.0** (`main/idf_component.yml`)
- `espressif/led_strip` **^2.4.1**

### 2.2 Flash and monitor

```bash
idf.py -p /dev/cu.usbmodemXXX flash monitor
```

Use your OS serial device (macOS: `/dev/cu.usbmodem…` or `/dev/cu.usbserial…`). If upload fails, put the board in **download mode** (hold **BOOT**, tap **RESET**, release **BOOT**), then flash again.

### 2.3 Configuration menus

- **Kconfig (project)**: `idf.py menuconfig` → **Example Configuration** — LVGL demo toggles, font options, Bluetooth options (`main/Kconfig.projbuild`).
- **Default sdkconfig fragments**: `sdkconfig.defaults` (SPIRAM, LVGL options, flash size, custom partition table).

Partition layout is `partitions.csv` (factory app at `0x10000`, `nvs`, small **FAT** partition `flash_test` for experiments).

---

## 3. Repository layout (what each part does)

| Path | Role |
|------|------|
| `main/main.c` | Application entry: init order, demo selection, **LVGL main loop** |
| `main/LCD_Driver/ST7789.c` / `ST7789.h` | SPI bus, `esp_lcd` panel IO, **ST7789T** panel, **backlight LEDC** |
| `main/LCD_Driver/Vernon_ST7789T/` | Local copy of **ST7789T** panel API typedefs / prototype used with this IDF |
| `main/LVGL_Driver/LVGL_Driver.c` | `lv_init`, display driver registration, **flush** and **rotation** callbacks, **2 ms tick** timer |
| `main/LVGL_UI/LVGL_Example.c` | Demo UI (`Lvgl_Example1`: tab view, onboard stats) |
| `main/RGB/RGB.c` | **WS2812** on GPIO 38 via RMT; `Set_RGB`, rainbow task |
| `main/SD_Card/SD_MMC.c` | **SDMMC** mount `/sdcard`, capacity for UI |
| `main/Wireless/Wireless.c` | NVS, **Wi-Fi scan** task, **BLE scan** task; global counts for UI |
| `components/lvgl__lvgl/` | Managed LVGL sources |
| `components/espressif__led_strip/` | Managed LED strip driver |

---

## 4. Boot sequence and why order matters

`app_main()` in `main/main.c` runs subsystems in a fixed order:

1. **`Wireless_Init()`** — Initializes NVS, then starts **FreeRTOS tasks** on core 0 for Wi-Fi and BLE setup/scans (non-blocking return; scans continue asynchronously).
2. **`Flash_Searching()`** — Reads **flash chip size** into global `Flash_Size` (MB) for the UI.
3. **`RGB_Init()`** / **`RGB_Example()`** — Creates the addressable LED driver and starts the **rainbow demo task** on core 0.
4. **`SD_Init()`** — Mounts the SD card at **`/sdcard`**; sets `SDCard_Size` (MB). On failure it logs and returns early (LCD/LVGL still run if you do not depend on SD).
5. **`LCD_Init()`** — SPI + panel + default mirror; enables display; runs **`BK_Init()`** and sets initial backlight duty.
6. **`BK_Light(50)`** — Adjusts backlight after `LCD_Init()` (overrides the 75% set inside `LCD_Init()` for the demo path in `main.c`).
7. **`LVGL_Init()`** — Registers LVGL display driver bound to `panel_handle`.
8. **`Lvgl_Example1()`** — Builds the demo widgets.

**Main loop** (critical for LVGL):

```c
while (1) {
    vTaskDelay(pdMS_TO_TICKS(10));
    lv_timer_handler();
}
```

- **`lv_timer_handler()`** must run periodically (here every ~10 ms wall time) to refresh animations, input, and redraw scheduling.
- A **2 ms** `esp_timer` drives **`lv_tick_inc(2)`** (`LVGL_Driver.c`), so LVGL’s internal time base advances correctly.

**Task priority note** (from comments in `main.c`): the task calling `lv_timer_handler()` should generally be **lower priority** than whatever runs `lv_tick_inc` (here the timer callback runs in timer context). Avoid starving `lv_timer_handler()` with long CPU-bound work on the same core without yielding.

---

## 5. LCD: low-level setup and manipulation

### 5.1 SPI and pins

Defined in `ST7789.h` (excerpt of important macros):

- **SPI host**: `LCD_HOST` → **`SPI3_HOST`** (comment in the header mentions SPI2; the active define is **SPI3** — follow `LCD_HOST` in code).
- **GPIO**: SCLK **40**, MOSI **45**, MISO unused (**-1**), DC **41**, RST **39**, CS **42**, backlight **48**.
- **Pixel clock**: 12 MHz (`EXAMPLE_LCD_PIXEL_CLOCK_HZ`).
- **Resolution**: **172×320** (`EXAMPLE_LCD_H_RES` / `EXAMPLE_LCD_V_RES`).
- **Panel**: `esp_lcd_new_panel_st7789t()` with **BGR** endian and **16 bpp** (`ST7789.c`).

### 5.2 Memory offset (important for full-screen LVGL)

`ST7789.h` defines:

```c
#define Offset_X 34
#define Offset_Y 0
```

The LVGL **flush callback** adds `Offset_X` / `Offset_Y` when calling `esp_lcd_panel_draw_bitmap()` so the 172×320 logical framebuffer maps correctly on the physical ST7789T panel geometry.

If you change panel init or rotation, re-validate these offsets against the Waveshare panel datasheet or wiki (wrong offsets produce a shifted or wrapped image).

### 5.3 Mirror and rotation

- After `esp_lcd_panel_init()`, the code calls **`esp_lcd_panel_mirror(panel_handle, true, false)`** once (`ST7789.c`).
- LVGL rotation is handled in **`example_lvgl_port_update_callback()`** in `LVGL_Driver.c` (`LV_DISP_ROT_*` maps to `esp_lcd_panel_swap_xy` / `esp_lcd_panel_mirror`). To rotate the UI, set `disp_drv.rotated` before register (see commented `LV_DISP_ROT_90` in `LVGL_Init()`).

### 5.4 Direct drawing without LVGL

`panel_handle` is a global (`ST7789.h`). After `LCD_Init()`, you can call **`esp_lcd_panel_draw_bitmap()`** yourself for tests, but mixing raw draws with LVGL without invalidating LVGL’s buffers will cause tearing or overwrites. Prefer LVGL objects for UI, or pause LVGL and take over the panel explicitly if you need a full custom renderer.

### 5.5 Backlight (brightness)

- **`BK_Init()`** — Called from `LCD_Init()`; configures **GPIO 48** and **LEDC** (timer 0, channel 0, 13-bit duty, 5 kHz PWM).
- **`BK_Light(uint8_t Light)`** — Input **0–100** (clamped). Maps to PWM duty with a non-linear curve; **0** forces duty **0** (backlight off).

Call `BK_Light(n)` any time after `LCD_Init()` to change brightness (UI slider, ambient sensor, etc.).

---

## 6. LVGL: graphics stack

### 6.1 Version and demos

- Managed dependency: **LVGL 8.3.x** (`main/idf_component.yml`).
- `LVGL_Driver.h` includes **`demos/lv_demos.h`**.
- `main.c` ships with **`Lvgl_Example1()`** enabled; stock demos are commented but available:

  - `lv_demo_widgets`
  - `lv_demo_keypad_encoder`
  - `lv_demo_benchmark`
  - `lv_demo_stress`
  - `lv_demo_music`

Enable exactly **one** top-level demo by commenting/uncommenting calls in `main.c` after `LVGL_Init()`.

### 6.2 Display buffers

In `LVGL_Driver.c`:

- Two line buffers **`buf1`** / **`buf2`** of length `LVGL_BUF_LEN` = **`EXAMPLE_LCD_H_RES * EXAMPLE_LCD_V_RES / 10`** (about **one tenth** of the full frame each), in **internal SRAM** (`lv_color_t`).
- **`lv_disp_draw_buf_init(..., EXAMPLE_LCD_H_RES * 20)`** — the third parameter is the **size in pixels** of a partial buffer mode (20 lines × width); this matches common LVGL “two buffers × partial height” setup.

There are **commented** lines showing how to allocate buffers in **PSRAM** (`MALLOC_CAP_SPIRAM`) if you need larger draw buffers for heavier effects (trade-off: SPIRAM bandwidth vs internal RAM).

### 6.3 Flush path

`example_lvgl_flush_cb()` forwards each invalidated region to:

`esp_lcd_panel_draw_bitmap(panel_handle, x1+Offset_X, y1+Offset_Y, x2+Offset_X+1, y2+Offset_Y+1, color_map)`.

Optional **`example_notify_lvgl_flush_ready()`** is wired as `on_color_trans_done` in the SPI panel IO config (`ST7789.c`) to signal **`lv_disp_flush_ready()`** — can reduce blocking in the flush path depending on IDF/driver behavior.

### 6.4 Building your own UI

1. Keep **`LVGL_Init()`** as-is unless you change resolution, rotation, or buffer strategy.
2. After `LVGL_Init()`, create your UI from **`lv_scr_act()`** (default screen) or create a new screen with `lv_obj_create(NULL)` and load it with `lv_scr_load()`.
3. Use standard **LVGL 8.3** APIs: `lv_label_create`, `lv_btn_create`, `lv_img_create`, styles, `lv_timer_create` for periodic updates, etc.
4. Ensure **`lv_timer_handler()`** keeps running in a loop or dedicated task.

**Example pattern** (new file + call from `main.c` after `LVGL_Init()`):

- Create `void my_ui_init(void)` that builds widgets attached to `lv_scr_act()`.
- Use `lv_timer_create()` to poll sensors and `lv_label_set_text()` / `lv_bar_set_value()` etc.

### 6.5 Fonts and `menuconfig`

Montserrat sizes are toggled under **Example Configuration** (`Kconfig.projbuild`). `LVGL_Example.c` uses `lv_font_montserrat_18` / `_12` when enabled; otherwise it falls back to `LV_FONT_DEFAULT`.

### 6.6 LVGL memory size

`Kconfig.projbuild` sets **`LV_MEM_SIZE_KILOBYTES`** default **48**. Increase via `menuconfig` if large images or many widgets cause allocation failures (watch the log for LVGL mem errors).

---

## 7. RGB addressable LED (WS2812 on GPIO 38)

### 7.1 API

| Function | Purpose |
|----------|---------|
| `RGB_Init()` | Creates **RMT** LED strip device: **1** pixel, GPIO **`BLINK_GPIO` (38)**, 10 MHz resolution |
| `Set_RGB(uint8_t r, uint8_t g, uint8_t b)` | Sets pixel 0 to 0–255 per channel and **`led_strip_refresh()`** |
| `RGB_Example()` | Starts **`_RGB_Example`** FreeRTOS task: cycles through a **192-step** hue table (`RGB_Data`) every 20 ms |

### 7.2 Custom patterns

- Call **`RGB_Init()`** once at startup.
- Either **do not** call `RGB_Example()` and drive colors from your own task/timer, or stop/delete the demo task if you created it.
- Use **`Set_RGB(r,g,b)`** for static colors; for animations, throttle updates (e.g. 50–100 Hz max is plenty for one LED).

### 7.3 Hardware caveats

- WS2812 timing is bit-banged via RMT; long wires or missing level shifters can cause glitches.
- Only **one** logical LED is configured (`max_leds = 1`). The Waveshare board has a single status NeoPixel-style LED.

---

## 8. SD card

- **Mount point**: **`/sdcard`** (`SD_MMC.c`).
- **Host**: default SDMMC host; **slot** pins from `SD_MMC.h`:

  - CLK **14**, CMD **15**, D0 **16**, D1 **18**, D2 **17**, D3 **21**

- **`format_if_mount_failed`** is **true** in the example — first mount may format a card that cannot be mounted (destructive). Tighten this for production.
- **`SDCard_Size`** (MB) is derived from CSD for display in `Lvgl_Example1`.

File helpers `s_example_write_file` / `s_example_read_file` illustrate POSIX **`fopen`** on the mount point.

---

## 9. Wireless (Wi-Fi + BLE) and UI globals

- **`Wireless_Init()`** — `nvs_flash_init()` (erase on missing pages / new version), then starts **`WIFI_Init`** and **`BLE_Init`** tasks.
- **`WIFI_Init`** — STA mode, blocking **`WIFI_Scan()`** once, sets **`WIFI_NUM`**, deletes task.
- **`BLE_Init`** — BLE controller + Bluedroid, registers GAP callback, runs **`BLE_Scan()`** for **`SCAN_DURATION`** seconds, increments **`BLE_NUM`** for unique addresses, sets flags, deletes task.

Globals consumed by the LVGL demo (`LVGL_Example.c`):

- **`WIFI_NUM`**, **`BLE_NUM`**, **`Scan_finish`**
- Timer **`example1_increase_lvgl_tick`** updates textarea **placeholder** text (not the main text buffer) with SD / flash / wireless summary every **100 ms**.

For your own app: reuse **`Wireless_Init()`** or replace with your provisioning / STA connection logic; avoid blocking `lv_timer_handler()` with long scans on the same task.

---

## 10. Changing the demo or adding a new module

### 10.1 Swap LVGL demo

In `main.c`, comment `Lvgl_Example1()` and uncomment one `lv_demo_*` line, or call your own init function after `LVGL_Init()`.

### 10.2 Add a new source file under `main/`

1. Add `.c` to **`main/CMakeLists.txt`** in `SRCS` and any **`INCLUDE_DIRS`**.
2. Add `#include` in `main.c` or your module’s header.
3. Re-run **`idf.py build`**.

### 10.3 Dependencies

Edit **`main/idf_component.yml`** for new managed components, then build (IDF fetches them automatically).

---

## 11. Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| Black screen, backlight on | SPI wiring / `Offset_X` / panel init; try `esp_lcd` logs at **Debug** level |
| Garbled colors | `LCD_RGB_ENDIAN_BGR` vs RGB; LVGL color depth **16** must match panel |
| LVGL frozen / no refresh | `lv_timer_handler()` not called often enough; tick timer not started |
| Build errors on ST7789T API | IDF version mismatch — `esp_lcd_new_panel_st7789t` is IDF-specific |
| LED stuck or wrong color | GPIO **38**, power, timing; ensure `RGB_Init()` + `Set_RGB` / refresh |
| SD mount fails | Pins vs Waveshare schematic, **10k pull-ups**, card format, **`format_if_mount_failed`** behavior |
| Wi-Fi / BLE init fail | NVS partition, **`menuconfig`** BT options, RF coexistence |

---

## 12. Quick reference — key APIs

```text
LCD_Init()              // SPI + ST7789T + backlight PWM init
BK_Light(0–100)         // Backlight brightness
LVGL_Init()             // LVGL display binding
Lvgl_Example1()         // Current demo UI
lv_timer_handler()      // Call ~every 10 ms in main loop
Set_RGB(r, g, b)        // Onboard WS2812 (after RGB_Init)
Wireless_Init()         // NVS + Wi-Fi/BLE scan tasks
SD_Init()               // Mount /sdcard, set SDCard_Size
Flash_Searching()       // Sets Flash_Size (MB)
```

---

## 13. Further reading

- [LVGL 8.3 documentation](https://docs.lvgl.io/8.3/)
- [ESP-IDF LCD SPI guide](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/peripherals/lcd.html)
- [ESP-IDF LED strip component](https://components.espressif.com/components/espressif/led_strip)
- [Waveshare ESP32-S3-LCD-1.47 wiki](https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47)

This file documents the **code in this folder** as of the time it was written; upstream Waveshare or Espressif examples may drift from the same layout.
