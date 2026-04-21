#include "class/hid/hid_device.h"
#include "espnow_bridge.h"
#include "minicore_protocol.h"
#include "tusb.h"

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
    minicore_hid_output(report_id, buffer, bufsize);
}
