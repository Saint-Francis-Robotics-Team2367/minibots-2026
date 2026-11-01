/**
 * TinyUSB composite HID: report layout matches web/js/constants.js and minicore_protocol.h.
 */

#include "minicore_usb.h"

#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "tinyusb.h"
#include "class/hid/hid_device.h"
#include "minicore_bridge.h"
#include "minicore_protocol.h"
#include "tusb_config.h"
#include "tusb.h"

#define TUSB_DESC_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN)

static const char *TAG = "mc_usb";

/* --- Dongle -> host report queue -------------------------------------------
 *
 * There is one HID IN endpoint, and tud_hid_report() fails (returns false) while
 * the previous report is still waiting to be polled. Reports used to be sent
 * straight from the ESP-NOW receive callback and the status task with that
 * return value ignored, so whenever two arrived within one poll interval the
 * second was simply gone.
 *
 * Robots answer in bursts: a scan gets a discovery response, a neutral ack and a
 * speed-limit ack back to back, about 1 ms apart, and N robots answer the same
 * scan at once. Most of every burst was dropped, which is what left robots
 * missing from scans, calibration never filling in, and the station re-scanning
 * and re-pushing the limit forever.
 *
 * Now every robot-originated report goes through this FIFO and a single task
 * puts them on the wire one at a time, woken by tud_hid_report_complete_cb. The
 * status report is not queued: it is latest-only, since a status that waited
 * behind a burst is stale by the time it leaves and the next one is 200 ms away.
 * Robot reports go first; the status fills the gaps. */
#define MC_IN_QUEUE_DEPTH 48
#define MC_IN_MAX_LEN 32 /* largest IN payload is 26 bytes */

typedef struct {
    uint8_t rid;
    uint8_t len;
    uint8_t data[MC_IN_MAX_LEN];
} in_report_t;

static QueueHandle_t s_in_q;
static TaskHandle_t s_in_task;
static portMUX_TYPE s_status_lock = portMUX_INITIALIZER_UNLOCKED;
static uint8_t s_status_buf[MC_IN_MAX_LEN];
static uint8_t s_status_len;
static bool s_status_pending;
static volatile uint32_t s_in_dropped;

bool minicore_usb_send_in(uint8_t report_id, const void *data, size_t len)
{
    if (!s_in_q || len > MC_IN_MAX_LEN || !tud_mounted()) {
        return false;
    }
    in_report_t r = {.rid = report_id, .len = (uint8_t)len};
    memcpy(r.data, data, len);
    if (xQueueSend(s_in_q, &r, 0) != pdTRUE) {
        /* Only reachable if the host stops polling for ~50 ms with traffic
         * arriving; counted rather than blocking the Wi-Fi task. */
        s_in_dropped++;
        return false;
    }
    xTaskNotifyGive(s_in_task);
    return true;
}

void minicore_usb_set_status(const void *data, size_t len)
{
    if (!s_in_task || len > MC_IN_MAX_LEN) {
        return;
    }
    taskENTER_CRITICAL(&s_status_lock);
    memcpy(s_status_buf, data, len);
    s_status_len = (uint8_t)len;
    s_status_pending = true;
    taskEXIT_CRITICAL(&s_status_lock);
    xTaskNotifyGive(s_in_task);
}

uint32_t minicore_usb_in_dropped(void)
{
    return s_in_dropped;
}

/* Called by TinyUSB once the host has taken the last report: the endpoint is
 * free, so wake the sender for the next one. */
void tud_hid_report_complete_cb(uint8_t instance, uint8_t const *report, uint16_t len)
{
    (void)instance;
    (void)report;
    (void)len;
    if (s_in_task) {
        xTaskNotifyGive(s_in_task);
    }
}

static void usb_in_task(void *arg)
{
    (void)arg;
    for (;;) {
        /* The timeout is only a backstop for a completion that never came
         * (host suspended mid-transfer, bus reset). */
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(5));
        if (!tud_mounted()) {
            /* Nothing will poll; anything waiting describes a link that is gone. */
            xQueueReset(s_in_q);
            taskENTER_CRITICAL(&s_status_lock);
            s_status_pending = false;
            taskEXIT_CRITICAL(&s_status_lock);
            continue;
        }
        if (!tud_hid_ready()) {
            continue; /* busy: the completion callback wakes us */
        }
        in_report_t r;
        if (xQueuePeek(s_in_q, &r, 0) == pdTRUE) {
            /* Peek, then remove only once TinyUSB has accepted it, so losing the
             * race with the endpoint never loses the report. */
            if (tud_hid_report(r.rid, r.data, r.len)) {
                xQueueReceive(s_in_q, &r, 0);
            }
            continue;
        }
        bool have = false;
        taskENTER_CRITICAL(&s_status_lock);
        if (s_status_pending) {
            r.rid = MC_HID_RID_DONGLE_STATUS;
            r.len = s_status_len;
            memcpy(r.data, s_status_buf, s_status_len);
            have = true;
        }
        taskEXIT_CRITICAL(&s_status_lock);
        if (have && tud_hid_report(r.rid, r.data, r.len)) {
            taskENTER_CRITICAL(&s_status_lock);
            s_status_pending = false;
            taskEXIT_CRITICAL(&s_status_lock);
        }
    }
}

static uint8_t const hid_report_desc[] = {
    0x06, 0x00, 0xFF,
    0x09, 0x01,
    0xA1, 0x01,
    0x85, MC_HID_RID_JOYSTICK,
    0x09, 0x20,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, 0x19,
    0x91, 0x02,
    0x85, MC_HID_RID_ENABLE,
    0x09, 0x21,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, 0x08,
    0x91, 0x02,
    0x85, MC_HID_RID_DISCOVERY,
    0x09, 0x22,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, 0x08,
    0x91, 0x02,
    0x85, MC_HID_RID_PAIR,
    0x09, 0x23,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, 0x08,
    0x91, 0x02,
    0x85, MC_HID_RID_UNPAIR,
    0x09, 0x24,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, 0x08,
    0x91, 0x02,
    0x85, MC_HID_RID_SET_NEUTRAL,
    0x09, 0x25,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, MC_HID_OUT_SET_NEUTRAL_LEN,
    0x91, 0x02,
    0x85, MC_HID_RID_SET_SPEED_LIMIT,
    0x09, 0x26,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, MC_HID_OUT_SET_SPEED_LIMIT_LEN,
    0x91, 0x02,
    0x85, MC_HID_RID_HEARTBEAT_IN,
    0x09, 0x30,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, 0x1A,
    0x81, 0x02,
    0x85, MC_HID_RID_DISCOVERY_IN,
    0x09, 0x31,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, 0x18,
    0x81, 0x02,
    0x85, MC_HID_RID_NEUTRAL_IN,
    0x09, 0x33,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, MC_HID_IN_NEUTRAL_LEN,
    0x81, 0x02,
    0x85, MC_HID_RID_SPEED_LIMIT_IN,
    0x09, 0x34,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, MC_HID_IN_SPEED_LIMIT_LEN,
    0x81, 0x02,
    0x85, MC_HID_RID_DONGLE_STATUS,
    0x09, 0x32,
    0x15, 0x00,
    0x26, 0xFF, 0x00,
    0x75, 0x08,
    0x95, 0x10,
    0x81, 0x02,
    0xC0,
};

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance)
{
    (void)instance;
    return hid_report_desc;
}

static const tusb_desc_device_t minicore_device_descriptor = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200,
    .bDeviceClass = 0x00,
    .bDeviceSubClass = 0x00,
    .bDeviceProtocol = 0x00,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = MINICORE_USB_VID,
    .idProduct = MINICORE_USB_PID,
    .bcdDevice = 0x0100,
    .iManufacturer = 0x01,
    .iProduct = 0x02,
    .iSerialNumber = 0x03,
    .bNumConfigurations = 0x01,
};

static const uint8_t minicore_configuration_descriptor[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    /* bInterval 1 ms (was 10). Polling is what paces the IN endpoint, and a
     * scan answered by four robots is a dozen reports; at 10 ms that alone took
     * 120 ms to drain. */
    TUD_HID_DESCRIPTOR(0, 4, false, sizeof(hid_report_desc), 0x81, 64, CFG_TUD_HID_EP_INTERVAL),
};

/* Product and serial are per-chip, from the factory MAC. Every dongle used to
 * report serial "01" and the same product name, so two on one computer showed as
 * identical entries in the browser's picker, shared one permission grant, and
 * could not be told apart by the page. WebHID does not expose the serial number,
 * so the product name carries the same suffix -- that is what the driver station
 * keys on to remember which dongle a tab was using. */
static char s_product[32];
static char s_serial[16];

static const char *minicore_string_descriptor[] = {
    (char[]){0x09, 0x04},
    "Lancer Robotics",
    s_product,
    s_serial,
    "MiniCore HID",
};

static void build_identity_strings(void)
{
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
        ESP_LOGW(TAG, "MAC read failed; USB serial will not be unique");
    }
    snprintf(s_serial, sizeof(s_serial), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4],
             mac[5]);
    /* The MAC suffix matches the last three bytes the dongle's ESP-NOW frames
     * carry, so the name on screen is also the address robots see. */
    snprintf(s_product, sizeof(s_product), "MiniCore Dongle %02X%02X%02X", mac[3], mac[4], mac[5]);
}

void minicore_usb_start(void)
{
    build_identity_strings();
    s_in_q = xQueueCreate(MC_IN_QUEUE_DEPTH, sizeof(in_report_t));
    configASSERT(s_in_q);
    /* Above the status task (5): draining the endpoint is what everything
     * upward waits on. Below the joystick tx task (6). */
    xTaskCreate(usb_in_task, "mc_usb_in", 3072, NULL, 5, &s_in_task);

    const tinyusb_config_t tusb_cfg = {
        .device_descriptor = &minicore_device_descriptor,
        .string_descriptor = minicore_string_descriptor,
        .string_descriptor_count = (int)(sizeof(minicore_string_descriptor) / sizeof(minicore_string_descriptor[0])),
        .external_phy = false,
        .configuration_descriptor = minicore_configuration_descriptor,
    };
    ESP_ERROR_CHECK(tinyusb_driver_install(&tusb_cfg));
}

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type, uint8_t *buffer,
                               uint16_t reqlen)
{
    (void)instance;
    (void)report_id;
    (void)report_type;
    (void)buffer;
    (void)reqlen;
    return 0;
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type, uint8_t const *buffer,
                           uint16_t bufsize)
{
    (void)instance;
    if (report_type != HID_REPORT_TYPE_OUTPUT) {
        return;
    }
    if (buffer == NULL || bufsize == 0) {
        return;
    }
    minicore_bridge_hid_output(report_id, buffer, bufsize);
}
