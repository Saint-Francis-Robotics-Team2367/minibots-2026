#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void minicore_usb_start(void);

/** Queue an input report for the host. Safe from any task (not from an ISR);
 * returns false if the queue is full or USB is not up, and the report is lost.
 * Every robot -> browser frame goes through here, never tud_hid_report(). */
bool minicore_usb_send_in(uint8_t report_id, const void *data, size_t len);

/** Replace the pending dongle-status report. Latest wins: a status that was
 * superseded before it reached the host is not worth sending. */
void minicore_usb_set_status(const void *data, size_t len);

/** Four hex digits from this dongle's MAC, e.g. "A1B2". It is the suffix of the
 * USB product name ("MiniCore Dongle A1B2") and is shown on the LCD, so the
 * dongle in someone's hand can be matched to the one a browser tab is using. */
const char *minicore_usb_dongle_tag(void);

#ifdef __cplusplus
}
#endif
