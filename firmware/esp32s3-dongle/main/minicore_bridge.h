#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void minicore_bridge_init(uint8_t wifi_channel);
void minicore_bridge_hid_output(uint8_t report_id, const uint8_t *buf, size_t len);

uint8_t minicore_get_channel(void);
unsigned minicore_paired_count(void);
bool minicore_global_enabled(void);
uint8_t minicore_error_flags(void);
/** Bit i set: paired slot i has had nothing acknowledged for >= 250 ms. */
uint8_t minicore_fault_slots(void);
/** Wrapping counters: per-slot unacknowledged unicasts, and sends refused before
 * reaching the air (all paths). Sized by MC_MAX_ROBOTS (4). */
void minicore_tx_stats(uint16_t fail_n[4], uint16_t *sync_err_n);

#ifdef __cplusplus
}
#endif
