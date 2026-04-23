/**
 * Waveshare ESP32-S3-LCD-1.47: ST7789 172×320 SPI, GPIO48 backlight PWM, WS2812 GPIO38.
 * Pinout: https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47 — layout notes in ESP32_DONGLE.md.
 * Logical UI after 90° rotation: 320×172 landscape; layout uses the full area (column, padded).
 */

#include "waveshare_s3_lcd147_ui.h"

#include <stdio.h>

#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_lvgl_port.h"
#include "led_strip.h"
#include "lvgl.h"
#include "minicore_bridge.h"
#include "minicore_protocol.h"

static const char *TAG = "lcd147";

/* Muted and accent colors (dark background 0x101418). */
#define C_TITLE 0xE2E8F0u
#define C_MUTED 0x8A9199u
#define C_VALUE 0xF0F2F4u
#define C_ON 0x66BB60u
#define C_OFF 0x90A4AEu
#define C_LINK_OK 0x81C784u
#define C_ERR 0xE57373u
#define C_BAR_TR 0x2A3038u
#define C_BAR_FILL 0x4A6FA0u
#define C_ERR_BG 0x2D1818u

/* Use SPI2_HOST: matches prior working bring-up; avoids SPI3 peripheral quirks on some S3+LCD boards. */
#define LCD_HOST SPI2_HOST
/* Partial draw height (recommend >= ~1/10 of screen) — internal DMA RAM, reliable vs full-frame+PSRAM. */
#define LCD_BUF_LINES 24
/* 8–12 MHz both appear in Waveshare bring-up; 8 MHz is safer on marginal wiring. */
#define LCD_PIXEL_CLK_HZ (8 * 1000 * 1000)
#define PIN_MOSI 45
#define PIN_SCLK 40
#define PIN_CS 42
#define PIN_DC 41
#define PIN_RST 39
#define PIN_BL 48
#define PIN_RGB 38

#define LCD_H_RES 172
#define LCD_V_RES 320
/* ST7789 240×320 GRAM: center 172px in 240px; portrait uses X gap, landscape (after swap_xy) uses Y. */
#define LCD_ST7789_NARROW_INSET 34

static void ui_style_clear(lv_obj_t *obj)
{
    lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(obj, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(obj, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_row(obj, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_column(obj, 0, LV_PART_MAIN);
}

/* Full-width row: [ key | value ] */
static lv_obj_t *ui_kv_row_add(lv_obj_t *parent, const char *key)
{
    lv_obj_t *row = lv_obj_create(parent);
    ui_style_clear(row);
    lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t *kl = lv_label_create(row);
    lv_label_set_text(kl, key);
    lv_obj_set_style_text_font(kl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(kl, lv_color_hex(C_MUTED), 0);

    lv_obj_t *v = lv_label_create(row);
    lv_obj_set_style_text_font(v, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(v, lv_color_hex(C_VALUE), 0);
    lv_obj_set_flex_grow(v, 1);
    lv_obj_set_style_text_align(v, LV_TEXT_ALIGN_RIGHT, 0);
    return v;
}

static led_strip_handle_t s_led;
static uint32_t s_blink_phase;

static lv_obj_t *s_val_channel;
static lv_obj_t *s_val_link;
static lv_obj_t *s_val_motors;
static lv_obj_t *s_val_paired;
static lv_obj_t *s_paired_bar;
static lv_obj_t *s_err_cont;
static lv_obj_t *s_err_lbl;

static void backlight_pwm_init(void)
{
    const ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_13_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 5000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&t));
    const ledc_channel_config_t c = {
        .gpio_num = PIN_BL,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = ((1u << 13) - 1u) * 50u / 100u,
        .hpoint = 0,
        .flags = {.output_invert = 0},
    };
    ESP_ERROR_CHECK(ledc_channel_config(&c));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0));
}

/* Keep in sync with `lvgl_port_display_cfg_t.rotation` below; matches esp_lvgl_port
 * lvgl_port_disp_rotation_update() for LV_DISPLAY_ROTATION_90. */
static void waveshare_st7789_apply_hw_rotation_90(esp_lcd_panel_handle_t panel)
{
    const bool base_swap = false;
    const bool base_mx = true;
    const bool base_my = true;
    ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(panel, !base_swap));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel, base_mx, !base_my));
}

static void rgb_led_init(void)
{
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
}

void waveshare_s3_lcd147_ui_init(void)
{
    backlight_pwm_init();

    spi_bus_config_t bus = {
        .mosi_io_num = PIN_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = PIN_SCLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = LCD_H_RES * LCD_BUF_LINES * (int)sizeof(uint16_t) + 8,
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
        .trans_queue_depth = 20,
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
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, false));
    /* Gap re-applied after `lv_display_set_rotation` in init (axis follows MADCTL swap_xy). */
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));

    const lvgl_port_cfg_t lvgl_cfg = ESP_LVGL_PORT_INIT_CONFIG();
    ESP_ERROR_CHECK(lvgl_port_init(&lvgl_cfg));

    lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = io,
        .panel_handle = panel,
        .buffer_size = (uint32_t)LCD_H_RES * (uint32_t)LCD_BUF_LINES,
        .double_buffer = true,
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
                /* Internal DMA: avoids spi transmit (queue) color failed with full-screen PSRAM+SPI. */
                .buff_dma = true,
                .buff_spiram = false,
#if LVGL_VERSION_MAJOR >= 9
                .swap_bytes = true,
#endif
                .full_refresh = false,
            },
    };
    ESP_LOGI(TAG, "heap before display: %u", (unsigned)esp_get_free_heap_size());
    lv_display_t *lv_disp = lvgl_port_add_disp(&disp_cfg);
    if (lv_disp == NULL) {
        ESP_LOGE(TAG, "lvgl_port_add_disp failed");
        return;
    }
    ESP_LOGI(TAG, "display OK, heap: %u", (unsigned)esp_get_free_heap_size());

    if (!lvgl_port_lock(1000)) {
        ESP_LOGE(TAG, "lvgl_port_lock failed; UI not started");
        return;
    }
    lv_display_set_default(lv_disp);
    lv_display_set_rotation(lv_disp, LV_DISPLAY_ROTATION_90);
    /* LV_EVENT_RESOLUTION_CHANGED may not update MADCTL in time; set MV/MX/MY explicitly. */
    waveshare_st7789_apply_hw_rotation_90(panel);
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, 0, LCD_ST7789_NARROW_INSET));
    int32_t ui_w = lv_display_get_horizontal_resolution(lv_disp);
    int32_t ui_h = lv_display_get_vertical_resolution(lv_disp);
    ESP_LOGI(TAG, "LVGL logical size after rotation: %d x %d", (int)ui_w, (int)ui_h);
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_scr_load(scr);
    lv_obj_set_size(scr, ui_w, ui_h);
    lv_obj_set_style_bg_color(scr, lv_color_hex(0x101418), LV_PART_MAIN);
    lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
    lv_obj_set_style_pad_left(scr, 14, LV_PART_MAIN);
    lv_obj_set_style_pad_right(scr, 14, LV_PART_MAIN);
    lv_obj_set_style_pad_top(scr, 6, LV_PART_MAIN);
    lv_obj_set_style_pad_bottom(scr, 6, LV_PART_MAIN);
    lv_obj_set_style_pad_row(scr, 0, LV_PART_MAIN);

    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "MiniCore");
    lv_obj_set_width(title, LV_PCT(100));
    lv_obj_set_style_text_font(title, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(title, lv_color_hex(C_TITLE), 0);
    lv_obj_set_style_text_align(title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_letter_space(title, 2, 0);

    lv_obj_t *body = lv_obj_create(scr);
    ui_style_clear(body);
    lv_obj_set_width(body, LV_PCT(100));
    lv_obj_set_flex_grow(body, 1);
    lv_obj_set_flex_flow(body, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(body, LV_FLEX_ALIGN_SPACE_EVENLY, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
    lv_obj_set_style_pad_row(body, 2, LV_PART_MAIN);

    s_val_channel = ui_kv_row_add(body, "Channel");
    s_val_link = ui_kv_row_add(body, "Link");
    s_val_motors = ui_kv_row_add(body, "Motors");
    s_val_paired = ui_kv_row_add(body, "Paired");

    s_paired_bar = lv_bar_create(body);
    lv_obj_set_size(s_paired_bar, LV_PCT(100), 10);
    lv_bar_set_range(s_paired_bar, 0, (int32_t)MC_MAX_ROBOTS);
    lv_obj_set_style_radius(s_paired_bar, 4, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_paired_bar, lv_color_hex(C_BAR_TR), LV_PART_MAIN);
    lv_obj_set_style_radius(s_paired_bar, 3, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(s_paired_bar, lv_color_hex(C_BAR_FILL), LV_PART_INDICATOR);
    lv_bar_set_value(s_paired_bar, 0, LV_ANIM_OFF);

    s_err_cont = lv_obj_create(scr);
    ui_style_clear(s_err_cont);
    lv_obj_set_width(s_err_cont, LV_PCT(100));
    lv_obj_set_height(s_err_cont, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(s_err_cont, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_err_cont, lv_color_hex(C_ERR_BG), LV_PART_MAIN);
    lv_obj_set_style_pad_ver(s_err_cont, 4, LV_PART_MAIN);
    lv_obj_set_style_pad_hor(s_err_cont, 6, LV_PART_MAIN);
    lv_obj_set_style_radius(s_err_cont, 3, LV_PART_MAIN);
    lv_obj_add_flag(s_err_cont, LV_OBJ_FLAG_HIDDEN);

    s_err_lbl = lv_label_create(s_err_cont);
    lv_obj_set_width(s_err_lbl, LV_PCT(100));
    lv_label_set_text(s_err_lbl, "Radio send error (ESP-NOW)");
    lv_obj_set_style_text_font(s_err_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_err_lbl, lv_color_hex(C_ERR), 0);
    lv_obj_set_style_text_align(s_err_lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(s_err_lbl, LV_LABEL_LONG_WRAP);

    lv_refr_now(lv_disp);
    lvgl_port_unlock();

    rgb_led_init();
    ESP_LOGI(TAG, "UI ready");
}

void waveshare_s3_lcd147_ui_poll(void)
{
    bool en = minicore_global_enabled();
    uint8_t err = minicore_error_flags();
    bool blink = ((s_blink_phase++ / 8) % 2) == 1;

    uint8_t r = en ? 0 : 32;
    uint8_t g = en ? 32 : 0;
    uint8_t b = 0;
    if (err && blink) {
        r = 48;
        g = 24;
    }
    led_strip_set_pixel(s_led, 0, r, g, b);
    led_strip_refresh(s_led);

    if (s_val_channel == NULL) {
        return;
    }
    const bool espnow_err = (err & 0x01u) != 0;

    char nbuf[16];
    char pbuf[16];

    snprintf(nbuf, sizeof(nbuf), "%u", (unsigned)minicore_get_channel());
    lvgl_port_lock(1000);
    lv_label_set_text(s_val_channel, nbuf);
    if (espnow_err) {
        lv_label_set_text(s_val_link, "Error");
        lv_obj_set_style_text_color(s_val_link, lv_color_hex(C_ERR), 0);
    } else {
        lv_label_set_text(s_val_link, "OK");
        lv_obj_set_style_text_color(s_val_link, lv_color_hex(C_LINK_OK), 0);
    }
    if (en) {
        lv_label_set_text(s_val_motors, "ON");
        lv_obj_set_style_text_color(s_val_motors, lv_color_hex(C_ON), 0);
    } else {
        lv_label_set_text(s_val_motors, "OFF");
        lv_obj_set_style_text_color(s_val_motors, lv_color_hex(C_OFF), 0);
    }
    unsigned pc = minicore_paired_count();
    if (pc > MC_MAX_ROBOTS) {
        pc = MC_MAX_ROBOTS;
    }
    snprintf(pbuf, sizeof(pbuf), "%u / %u", (unsigned)pc, (unsigned)MC_MAX_ROBOTS);
    lv_label_set_text(s_val_paired, pbuf);
    lv_bar_set_value(s_paired_bar, (int32_t)pc, LV_ANIM_OFF);
    if (err != 0) {
        lv_obj_remove_flag(s_err_cont, LV_OBJ_FLAG_HIDDEN);
        if (espnow_err && (err & ~(uint8_t)0x01u) == 0) {
            lv_label_set_text(s_err_lbl, "ESP-NOW send fault");
        } else if (espnow_err) {
            lv_label_set_text(s_err_lbl, "Multiple faults (incl. ESP-NOW)");
        } else {
            lv_label_set_text(s_err_lbl, "System error");
        }
    } else {
        lv_obj_add_flag(s_err_cont, LV_OBJ_FLAG_HIDDEN);
    }
    lvgl_port_unlock();
}
