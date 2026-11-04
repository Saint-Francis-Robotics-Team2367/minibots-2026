/**
 * TinyUSB composite HID: report layout matches web/js/constants.js and minicore_protocol.h.
 */

#include "minicore_usb.h"

#include <stddef.h>
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

/* Interrupt-IN polling interval, ms. Was 10, which capped the dongle at 100
 * reports a second up to the browser and kept each one parked in the endpoint
 * for up to 10 ms. See the queue below for why that mattered. */
#define MC_HID_IN_INTERVAL_MS 1

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
    TUD_HID_DESCRIPTOR(0, 4, false, sizeof(hid_report_desc), 0x81, 64, MC_HID_IN_INTERVAL_MS),
};

/* Product and serial strings are per dongle, built from the MAC at start-up.
 * Every dongle used to report the same product name and serial "01", so a host
 * with two plugged in could not tell them apart: the WebHID picker listed two
 * identical entries, and Chrome keys remembered permissions on the serial.
 * WebHID does not expose the serial to the page, so the tag also goes in the
 * product name, which it does. */
static char s_tag[5];
static char s_product[24];
static char s_serial[13];

static const char *minicore_string_descriptor[] = {
    (char[]){0x09, 0x04},
    "Lancer Robotics",
    s_product,
    s_serial,
    "MiniCore HID",
};

static uint8_t s_mac[6];
static bool s_mac_read;

static const uint8_t *dongle_mac(void)
{
    if (!s_mac_read) {
        if (esp_read_mac(s_mac, ESP_MAC_WIFI_STA) != ESP_OK) {
            memset(s_mac, 0, sizeof(s_mac));
        }
        s_mac_read = true;
    }
    return s_mac;
}

const char *minicore_usb_dongle_tag(void)
{
    if (!s_tag[0]) {
        const uint8_t *m = dongle_mac();
        snprintf(s_tag, sizeof(s_tag), "%02X%02X", m[4], m[5]);
    }
    return s_tag;
}

/* --- Input reports (dongle -> host) ---
 *
 * There is one interrupt-IN endpoint, and tud_hid_report() refuses -- returns
 * false, report gone -- while the previous report is still waiting for the host
 * to poll it. It used to be called directly from the ESP-NOW receive callback
 * and from the status task, return value ignored, so every report that arrived
 * while another was in the endpoint was silently dropped.
 *
 * Robots answer in bursts: a scan gets a discovery response, a neutral ack and a
 * speed-limit ack back to back from every robot at once, and the boot announce
 * is a heartbeat plus a neutral ack. Everything after the first frame of a burst
 * landed within ~1 ms, while the first was still parked for up to 10 ms. The
 * driver station saw robots missing from scans, calibration that never filled
 * in, and speed limits it could never confirm -- and re-scanned and re-pushed
 * on timers trying to recover, adding airtime for every station in the room.
 *
 * Now every report is queued and usb_in_task puts them on the wire one at a
 * time, the next as soon as the host has taken the last. The status report is
 * not queued: it is latest-wins, so a burst of robot traffic cannot fill the
 * queue with stale copies of it. */
#define MC_HID_IN_MAX_LEN MC_HID_IN_HEARTBEAT_LEN /* the largest IN report */
#define MC_HID_IN_QUEUE_DEPTH 32

typedef struct {
    uint8_t report_id;
    uint8_t len;
    uint8_t data[MC_HID_IN_MAX_LEN];
} in_report_t;

_Static_assert(MC_HID_IN_DISCOVERY_LEN <= MC_HID_IN_MAX_LEN, "IN queue slot too small");
_Static_assert(MC_HID_IN_NEUTRAL_LEN <= MC_HID_IN_MAX_LEN, "IN queue slot too small");
_Static_assert(MC_HID_IN_SPEED_LIMIT_LEN <= MC_HID_IN_MAX_LEN, "IN queue slot too small");
_Static_assert(MC_HID_IN_STATUS_LEN <= MC_HID_IN_MAX_LEN, "IN queue slot too small");

static QueueHandle_t s_in_q;
static TaskHandle_t s_in_task;
static portMUX_TYPE s_status_lock = portMUX_INITIALIZER_UNLOCKED;
static in_report_t s_status;
static bool s_status_pending;
/* Reports lost to a full queue. Logged from the task, never the caller. */
static volatile uint32_t s_in_dropped;

bool minicore_usb_send_in(uint8_t report_id, const void *data, size_t len)
{
    if (!s_in_q || len > MC_HID_IN_MAX_LEN || !tud_mounted()) {
        return false;
    }
    in_report_t r = {.report_id = report_id, .len = (uint8_t)len};
    memcpy(r.data, data, len);
    if (xQueueSend(s_in_q, &r, 0) != pdTRUE) {
        s_in_dropped++;
        return false;
    }
    xTaskNotifyGive(s_in_task);
    return true;
}

void minicore_usb_set_status(const void *data, size_t len)
{
    if (!s_in_task || len > MC_HID_IN_MAX_LEN) {
        return;
    }
    taskENTER_CRITICAL(&s_status_lock);
    s_status.report_id = MC_HID_RID_DONGLE_STATUS;
    s_status.len = (uint8_t)len;
    memcpy(s_status.data, data, len);
    s_status_pending = true;
    taskEXIT_CRITICAL(&s_status_lock);
    xTaskNotifyGive(s_in_task);
}

/* The host took the last report; the endpoint is free for the next. Runs in the
 * TinyUSB task. */
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
    in_report_t held;
    bool have = false;
    uint32_t dropped_logged = 0;
    for (;;) {
        /* Woken by a new report or a completed transfer. The timeout is only a
         * backstop for a completion that never comes (e.g. a bus reset). */
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(5));

        uint32_t dropped = s_in_dropped;
        if (dropped != dropped_logged) {
            ESP_LOGW(TAG, "IN queue full: %lu reports to the host lost so far", (unsigned long)dropped);
            dropped_logged = dropped;
        }

        if (!tud_mounted()) {
            /* Nobody to deliver to. Don't let stale frames reach the next host. */
            xQueueReset(s_in_q);
            have = false;
            taskENTER_CRITICAL(&s_status_lock);
            s_status_pending = false;
            taskEXIT_CRITICAL(&s_status_lock);
            continue;
        }
        if (!tud_hid_ready()) {
            continue; /* still busy; the completion wakes us */
        }
        if (!have) {
            if (xQueueReceive(s_in_q, &held, 0) == pdTRUE) {
                have = true;
            } else {
                taskENTER_CRITICAL(&s_status_lock);
                if (s_status_pending) {
                    held = s_status;
                    s_status_pending = false;
                    have = true;
                }
                taskEXIT_CRITICAL(&s_status_lock);
            }
        }
        if (!have) {
            continue;
        }
        /* Held across a refusal rather than dropped, and retried on the next
         * wake: losing reports on a busy endpoint is the bug this replaces. */
        if (tud_hid_report(held.report_id, held.data, held.len)) {
            have = false;
        }
    }
}

void minicore_usb_start(void)
{
    const uint8_t *m = dongle_mac();
    snprintf(s_product, sizeof(s_product), "MiniCore Dongle %s", minicore_usb_dongle_tag());
    snprintf(s_serial, sizeof(s_serial), "%02X%02X%02X%02X%02X%02X", m[0], m[1], m[2], m[3], m[4], m[5]);

    s_in_q = xQueueCreate(MC_HID_IN_QUEUE_DEPTH, sizeof(in_report_t));
    configASSERT(s_in_q);
    /* Above the status task (5): delivery is what keeps the queue short. */
    xTaskCreate(usb_in_task, "mc_usb_in", 3072, NULL, 6, &s_in_task);

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
