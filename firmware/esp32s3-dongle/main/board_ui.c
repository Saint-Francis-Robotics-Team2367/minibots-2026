#include "board_ui.h"

#include <stdio.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "led_strip.h"
#include "lvgl.h"
#include "minicore_protocol.h"

#include "espnow_bridge.h"

static const char *TAG = "board_ui";

#define LCD_HOST SPI2_HOST
#define PIN_MOSI 45
#define PIN_SCLK 40
#define PIN_CS 42
#define PIN_DC 41
#define PIN_RST 39
#define PIN_BL 48
#define PIN_RGB 38

#define LCD_H_RES 172
#define LCD_V_RES 320

static lv_obj_t *s_lbl;
static led_strip_handle_t s_led;
static uint32_t s_blink;

void board_ui_init(void)
{
    gpio_config_t bl = {
        .pin_bit_mask = 1ULL << PIN_BL,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = false,
        .pull_down_en = false,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&bl));
    gpio_set_level(PIN_BL, 1);

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
        .pclk_hz = 40 * 1000 * 1000,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 10,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((spi_host_device_t)LCD_HOST, &iocfg, &io));

    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_dev_config_t pcfg = {
        .reset_gpio_num = PIN_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &pcfg, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));

    const lvgl_port_cfg_t lvgl_cfg = ESP_LVGL_PORT_INIT_CONFIG();
    ESP_ERROR_CHECK(lvgl_port_init(&lvgl_cfg));

    lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = io,
        .panel_handle = panel,
        .buffer_size = LCD_H_RES * 40,
        .double_buffer = true,
        .hres = LCD_H_RES,
        .vres = LCD_V_RES,
        .monochrome = false,
        .rotation =
            {
                .swap_xy = true,
                .mirror_x = true,
                .mirror_y = false,
            },
    };
    if (lvgl_port_add_disp(&disp_cfg) == NULL) {
        ESP_LOGE(TAG, "lvgl_port_add_disp failed");
        return;
    }

    lvgl_port_lock(1000);
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_scr_load(scr);
    lv_obj_set_style_bg_color(scr, lv_color_hex(0x101418), LV_PART_MAIN);
    s_lbl = lv_label_create(scr);
    lv_obj_set_style_text_color(s_lbl, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_label_set_text(s_lbl, "MiniCore");
    lv_obj_align(s_lbl, LV_ALIGN_TOP_MID, 0, 12);
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
