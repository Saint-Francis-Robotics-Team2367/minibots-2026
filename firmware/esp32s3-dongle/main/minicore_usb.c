/**
 * TinyUSB composite HID: report layout matches web/js/constants.js and minicore_protocol.h.
 */

#include "minicore_usb.h"

#include <stddef.h>

#include "esp_check.h"
#include "tinyusb.h"
#include "class/hid/hid_device.h"
#include "minicore_bridge.h"
#include "minicore_protocol.h"
#include "tusb_config.h"
#include "tusb.h"

#define TUSB_DESC_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN)

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
    TUD_HID_DESCRIPTOR(0, 4, false, sizeof(hid_report_desc), 0x81, 64, 10),
};

static const char *minicore_string_descriptor[] = {
    (char[]){0x09, 0x04},
    "Lancer Robotics",
    "MiniCore Dongle",
    "01",
    "MiniCore HID",
};

void minicore_usb_start(void)
{
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
