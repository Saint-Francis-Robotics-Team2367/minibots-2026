/**
 * MiniCore wire protocol — shared by dongle (ESP-IDF), robot (Arduino), and web (protocol.js).
 * Keep in sync with web/js/protocol.js
 */
#ifndef MINICORE_PROTOCOL_H
#define MINICORE_PROTOCOL_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- ESP-NOW message types --- */
#define MC_MSG_JOYSTICK 0x01u
#define MC_MSG_ENABLE 0x02u
#define MC_MSG_HEARTBEAT 0x03u
#define MC_MSG_DISCOVERY_REQ 0x04u
#define MC_MSG_DISCOVERY_RESP 0x05u

/* --- USB HID identity (Espressif VID, project-specific PID) --- */
#define MINICORE_USB_VID 0x303Au
#define MINICORE_USB_PID 0x4002u

/* --- HID report IDs: host -> dongle (output) --- */
#define MC_HID_RID_JOYSTICK 0x01u
#define MC_HID_RID_ENABLE 0x02u
#define MC_HID_RID_DISCOVERY 0x04u
#define MC_HID_RID_PAIR 0x10u
#define MC_HID_RID_UNPAIR 0x11u
#define MC_HID_RID_SPECTRUM_SCAN 0x12u

/* --- HID report IDs: dongle -> host (input) --- */
#define MC_HID_RID_HEARTBEAT_IN 0x03u
#define MC_HID_RID_DISCOVERY_IN 0x05u
#define MC_HID_RID_SPECTRUM_IN 0x07u
#define MC_HID_RID_DONGLE_STATUS 0xFEu

/* Fixed sizes for HID reports (padded where needed) */
#define MC_HID_OUT_JOYSTICK_LEN 25u /* 1 byte controller idx + joystick_packet_t */
#define MC_HID_OUT_ENABLE_LEN 8u
#define MC_HID_OUT_DISCOVERY_LEN 8u
#define MC_HID_OUT_PAIR_LEN 8u
#define MC_HID_OUT_UNPAIR_LEN 8u
#define MC_HID_OUT_SPECTRUM_LEN 8u

#define MC_HID_IN_HEARTBEAT_LEN 20u
#define MC_HID_IN_DISCOVERY_LEN 24u
#define MC_HID_IN_SPECTRUM_LEN 32u
#define MC_HID_IN_STATUS_LEN 16u

/** 2.4 GHz channels 1..14 for spectrum aggregation */
#define MC_WIFI_CH_24_MAX 14u

#define MC_ROBOT_ID_MAX 16u
#define MC_JOY_AUX_BYTES 8u
#define MC_MAX_ROBOTS 4u

#define MC_DISCOVERY_COLLECT_MS 500u
#define MC_HEARTBEAT_INTERVAL_MS 1000u
#define MC_MOTOR_TIMEOUT_MS 250u

#define MC_BROADCAST_MAC_BYTE 0xFFu

#pragma pack(push, 1)

typedef struct {
    uint8_t type;   /* MC_MSG_JOYSTICK */
    uint8_t seq;
    int16_t axis_lx;
    int16_t axis_ly;
    int16_t axis_rx;
    int16_t axis_ry;
    int16_t axis_lt;
    int16_t axis_rt;
    uint16_t buttons;
    uint8_t aux[MC_JOY_AUX_BYTES];
} joystick_packet_t;

typedef struct {
    uint8_t type;          /* MC_MSG_ENABLE */
    uint8_t enabled;       /* 1 = enable */
    uint8_t target_mac[6]; /* FF:FF:FF:FF:FF:FF = all */
} enable_packet_t;

typedef struct {
    uint8_t type;           /* MC_MSG_HEARTBEAT */
    uint8_t robot_id_len;
    char robot_id[MC_ROBOT_ID_MAX];
    uint8_t battery_pct;    /* 0-100 or 0xFF unknown */
    uint8_t status_flags;
} heartbeat_packet_t;

typedef struct {
    uint8_t type;    /* MC_MSG_DISCOVERY_REQ */
    uint8_t channel; /* Wi-Fi channel */
} discovery_request_t;

typedef struct {
    uint8_t type; /* MC_MSG_DISCOVERY_RESP */
    uint8_t mac[6];
    uint8_t robot_id_len;
    char robot_id[MC_ROBOT_ID_MAX];
} discovery_response_t;

/** Dongle -> browser status (report 0xFE) */
typedef struct {
    uint8_t wifi_channel;
    uint8_t paired_count;
    uint8_t global_enabled; /* 0/1 */
    uint8_t error_flags;    /* bit0: espnow send err */
    uint8_t reserved[12];
} dongle_status_t;

/**
 * Wi-Fi channel survey (report 0x07): passive+active scan aggregate.
 * ap_count[] / strongest_rssi[] index 0 = channel 1, index 13 = channel 14.
 * strongest_rssi is strongest observed BSSID RSSI (dBm), or -127 if no APs on that channel.
 */
typedef struct {
    uint8_t recommended_channel; /* usually 1, 6, or 11; 0 if scan failed */
    uint8_t scan_seq;
    uint8_t ap_count[MC_WIFI_CH_24_MAX];
    int8_t strongest_rssi[MC_WIFI_CH_24_MAX];
    uint8_t reserved[2];
} spectrum_scan_result_t;

#pragma pack(pop)

#if defined(__GNUC__) || defined(__clang__)
_Static_assert(sizeof(joystick_packet_t) == 24, "joystick_packet_t size");
_Static_assert(sizeof(enable_packet_t) == 8, "enable_packet_t size");
_Static_assert(sizeof(heartbeat_packet_t) == 20, "heartbeat_packet_t size");
_Static_assert(sizeof(discovery_request_t) == 2, "discovery_request_t size");
_Static_assert(sizeof(discovery_response_t) == 24, "discovery_response_t size");
_Static_assert(sizeof(dongle_status_t) == 16, "dongle_status_t size");
_Static_assert(sizeof(spectrum_scan_result_t) == 32, "spectrum_scan_result_t size");
#endif

#ifdef __cplusplus
}
#endif

#endif /* MINICORE_PROTOCOL_H */
