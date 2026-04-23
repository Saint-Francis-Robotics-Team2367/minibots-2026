/**
 * MiniCore control-station dongle: native USB HID (TinyUSB) + ESP-NOW + Waveshare 1.47" UI.
 * See MINICORE_CLAUDE.md, ESP32_DONGLE.md, and https://www.waveshare.com/wiki/ESP32-S3-LCD-1.47
 */

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "minicore_bridge.h"
#include "minicore_protocol.h"
#include "minicore_usb.h"
#include "nvs_flash.h"
#include "class/hid/hid_device.h"
#include "tusb.h"
#include "waveshare_s3_lcd147_ui.h"

static const char *TAG = "mc_dongle";

#ifndef CONFIG_MINICORE_WIFI_CHANNEL
#define CONFIG_MINICORE_WIFI_CHANNEL 6
#endif

static void dongle_status_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(200));
        dongle_status_t st;
        memset(&st, 0, sizeof(st));
        st.wifi_channel = minicore_get_channel();
        st.paired_count = (uint8_t)minicore_paired_count();
        st.global_enabled = minicore_global_enabled() ? 1u : 0u;
        st.error_flags = minicore_error_flags();
        if (tud_mounted()) {
            tud_hid_report(MC_HID_RID_DONGLE_STATUS, &st, sizeof(st));
        }
        waveshare_s3_lcd147_ui_poll();
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "MiniCore dongle (Waveshare ESP32-S3-LCD-1.47)");
    ESP_ERROR_CHECK(nvs_flash_init());

    minicore_bridge_init(CONFIG_MINICORE_WIFI_CHANNEL);
    waveshare_s3_lcd147_ui_init();

    minicore_usb_start();
    ESP_LOGI(TAG, "USB HID ready");

    xTaskCreate(dongle_status_task, "mc_status", 4096, NULL, 5, NULL);
}
