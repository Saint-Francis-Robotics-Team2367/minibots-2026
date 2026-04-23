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

#ifdef __cplusplus
}
#endif
