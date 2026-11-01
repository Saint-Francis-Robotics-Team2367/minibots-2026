#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void minicore_usb_start(void);

/** Queue one robot-originated IN report for the host. Never blocks; safe from
 * the Wi-Fi receive callback. False if the link is down or the queue is full. */
bool minicore_usb_send_in(uint8_t report_id, const void *data, size_t len);

/** Replace the pending dongle status report (latest-only, never queued). */
void minicore_usb_set_status(const void *data, size_t len);

/** Reports refused because the queue was full (wrapping). */
uint32_t minicore_usb_in_dropped(void);

#ifdef __cplusplus
}
#endif
