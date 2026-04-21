#include <string.h>

#include "board_ui.h"
#include "esp_log.h"
#include "espnow_bridge.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "minicore_protocol.h"
#include "nvs_flash.h"
#include "class/hid/hid_device.h"
#include "tinyusb.h"
#include "tusb.h"

extern const tusb_desc_device_t *minicore_device_descriptor_ptr(void);
extern const uint8_t *minicore_configuration_descriptor_ptr(void);
extern const char *minicore_string_descriptor[];
extern size_t minicore_string_descriptor_count(void);

static const char *TAG = "main";

#ifndef CONFIG_MINICORE_WIFI_CHANNEL
#define CONFIG_MINICORE_WIFI_CHANNEL 6
#endif

static void status_task(void *arg)
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
        board_ui_update();
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "MiniCore dongle");
    ESP_ERROR_CHECK(nvs_flash_init());

    minicore_espnow_init(CONFIG_MINICORE_WIFI_CHANNEL);
    board_ui_init();

    const tinyusb_config_t tusb_cfg = {
        .device_descriptor = minicore_device_descriptor_ptr(),
        .string_descriptor = minicore_string_descriptor,
        .string_descriptor_count = (int)minicore_string_descriptor_count(),
        .external_phy = false,
        .configuration_descriptor = minicore_configuration_descriptor_ptr(),
    };

    ESP_ERROR_CHECK(tinyusb_driver_install(&tusb_cfg));
    ESP_LOGI(TAG, "USB HID ready");

    xTaskCreate(status_task, "status", 4096, NULL, 5, NULL);
}
