/* LCD wiring and specs: https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47 (ST7789, 172×320, GPIOs below).
 * Not added to main/CMakeLists.txt — on-device UI is waveshare_s3_lcd147_ui.c (full-width status layout, bar, errors).
 * Keep this file in sync for reference or delete when no longer needed. */

#include "board_ui.h"

#include <stdio.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_lvgl_port.h"
#include "led_strip.h"
#include "lvgl.h"
#include "minicore_protocol.h"

#include "espnow_bridge.h"
#include "sdkconfig.h"

static const char *TAG = "board_ui";

#define LCD_HOST SPI2_HOST
/* ST7789 SPI: Waveshare/Arduino bring-up used ~8MHz; 40MHz can fail on this board (black/no image). */
#define LCD_PIXEL_CLK_HZ (8 * 1000 * 1000)
#define PIN_MOSI 45
#define PIN_SCLK 40
#define PIN_CS 42
#define PIN_DC 41
#define PIN_RST 39
#define PIN_BL 48
#define PIN_RGB 38

/* Native panel: 172×320 (portrait). LVGL is configured in landscape: 320×172 (see `lv_display_set_rotation`). */
#define LCD_H_RES 172
#define LCD_V_RES 320
/* ST7789 240×320 GRAM: inset to center 172px along the 240px axis (portrait: X; landscape: Y after `swap_xy`). */
#define LCD_ST7789_NARROW_INSET 35

/* Waveshare IDF/Arduino examples drive LCD_BL (GPIO48) with PWM (e.g. BK_Light(50)), not a static level. */
static void board_backlight_init(void)
{
    const ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 10000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&t));
    const ledc_channel_config_t c = {
        .gpio_num = PIN_BL,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = 800,
        .hpoint = 0,
        .flags = {.output_invert = 0},
    };
    ESP_ERROR_CHECK(ledc_channel_config(&c));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0));
}

static lv_obj_t *s_lbl;
static led_strip_handle_t s_led;
static uint32_t s_blink;

/* Keep in sync with `lvgl_port_display_cfg_t.rotation` in `board_ui_init` (swap_xy, mirror_x, mirror_y)
 * and `esp_lvgl_port` lvgl_port_disp_rotation_update() for LV_DISPLAY_ROTATION_90. */
static void board_st7789_apply_hw_rotation_90(esp_lcd_panel_handle_t panel)
{
    const bool base_swap = false;
    const bool base_mx = true;
    const bool base_my = true;
    ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(panel, !base_swap));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel, base_mx, !base_my));
}

void board_ui_init(void)
{
    board_backlight_init();

    spi_bus_config_t bus = {
        .mosi_io_num = PIN_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = PIN_SCLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = LCD_H_RES * LCD_V_RES * sizeof(uint16_t),
    };
    ESP_ERROR_CHECK(spi_bus_initialize(LCD_HOST, &bus, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t iocfg = {
        .dc_gpio_num = PIN_DC,
        .cs_gpio_num = PIN_CS,
        .pclk_hz = LCD_PIXEL_CLK_HZ,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 10,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((spi_host_device_t)LCD_HOST, &iocfg, &io));

    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_dev_config_t pcfg = {
        .reset_gpio_num = PIN_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &pcfg, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    /* Leave invert off unless this panel needs photo-negative (see Waveshare/IPS notes). */
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, false));
    /* Gap set in `board_ui_init` after LVGL display rotation; axis depends on `esp_lcd_panel_swap_xy`. */
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));

    const lvgl_port_cfg_t lvgl_cfg = ESP_LVGL_PORT_INIT_CONFIG();
    ESP_ERROR_CHECK(lvgl_port_init(&lvgl_cfg));

    lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = io,
        .panel_handle = panel,
        .buffer_size = (uint32_t)LCD_H_RES * (uint32_t)LCD_V_RES,
#if defined(CONFIG_SPIRAM) && CONFIG_SPIRAM
        .double_buffer = true,
#else
        .double_buffer = false,
#endif
        .hres = LCD_H_RES,
        .vres = LCD_V_RES,
        .monochrome = false,
#if LVGL_VERSION_MAJOR >= 9
        .color_format = LV_COLOR_FORMAT_RGB565,
#endif
        .rotation =
            {
                .swap_xy = false,
                .mirror_x = true,
                .mirror_y = true,
            },
        .flags =
            {
                .buff_dma = true,
#if LVGL_VERSION_MAJOR >= 9 && defined(CONFIG_SPIRAM) && CONFIG_SPIRAM
                .buff_spiram = true,
#endif
#if LVGL_VERSION_MAJOR >= 9
                .swap_bytes = true,
#endif
                .full_refresh = true,
            },
    };
    ESP_LOGI(TAG, "heap before lvgl display: %u bytes", (unsigned)esp_get_free_heap_size());
    lv_display_t *lv_disp = lvgl_port_add_disp(&disp_cfg);
    if (lv_disp == NULL) {
        ESP_LOGE(TAG, "lvgl_port_add_disp failed (out of memory?)");
        return;
    }
    ESP_LOGI(TAG, "lvgl display OK, heap after: %u bytes", (unsigned)esp_get_free_heap_size());

    if (!lvgl_port_lock(1000)) {
        ESP_LOGE(TAG, "lvgl_port_lock failed; cannot configure display rotation");
        return;
    }
    /* Default first display: ensures LV task runs lv_timer_handler. */
    lv_display_set_default(lv_disp);
    lv_display_set_rotation(lv_disp, LV_DISPLAY_ROTATION_90);
    /* LV_EVENT_RESOLUTION_CHANGED may not run before first frame on some paths; set MADCTL (MV/MX/MY) explicitly. */
    board_st7789_apply_hw_rotation_90(panel);
    /* Re-tune: narrow axis centering in GRAM; try (0,y) or (x,0) if image is shifted. */
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, 0, LCD_ST7789_NARROW_INSET));
    int32_t ui_w = lv_display_get_horizontal_resolution(lv_disp);
    int32_t ui_h = lv_display_get_vertical_resolution(lv_disp);
    ESP_LOGI(TAG, "LVGL logical size after rotation: %d x %d", (int)ui_w, (int)ui_h);
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_scr_load(scr);
    lv_obj_set_size(scr, ui_w, ui_h);
    lv_obj_set_style_bg_color(scr, lv_color_hex(0x101418), LV_PART_MAIN);
    s_lbl = lv_label_create(scr);
    lv_obj_set_style_text_font(s_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_lbl, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_label_set_text(s_lbl, "MiniCore");
    lv_obj_set_width(s_lbl, ui_w);
    lv_obj_align(s_lbl, LV_ALIGN_TOP_MID, 0, 12);
    lv_refr_now(lv_disp);
    lvgl_port_unlock();

    led_strip_config_t scfg = {
        .strip_gpio_num = PIN_RGB,
        .max_leds = 1,
        .led_pixel_format = LED_PIXEL_FORMAT_GRB,
        .led_model = LED_MODEL_WS2812,
    };
    led_strip_rmt_config_t rcfg = {
        .resolution_hz = 10 * 1000 * 1000,
    };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&scfg, &rcfg, &s_led));
    led_strip_clear(s_led);
    ESP_LOGI(TAG, "UI ready");
}

void board_ui_update(void)
{
    bool en = minicore_global_enabled();
    uint8_t err = minicore_error_flags();
    bool blink = ((s_blink++ / 8) % 2) == 1;

    uint8_t r = en ? 0 : 32;
    uint8_t g = en ? 32 : 0;
    uint8_t b = 0;
    if (err && blink) {
        r = 48;
        g = 24;
    }
    led_strip_set_pixel(s_led, 0, r, g, b);
    led_strip_refresh(s_led);

    if (s_lbl == NULL) {
        return;
    }
    char line[96];
    snprintf(line, sizeof(line), "Ch %u  Pair %u  %s", (unsigned)minicore_get_channel(),
             (unsigned)minicore_paired_count(), en ? "EN" : "DIS");
    lvgl_port_lock(1000);
    lv_label_set_text(s_lbl, line);
    lvgl_port_unlock();
}
