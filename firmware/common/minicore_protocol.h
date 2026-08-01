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
#define MC_MSG_SET_NEUTRAL 0x06u /* dongle -> robot, unicast only */
#define MC_MSG_NEUTRAL_ACK 0x07u /* robot -> dongle */

/* --- USB HID identity (Espressif VID, project-specific PID) --- */
#define MINICORE_USB_VID 0x303Au
#define MINICORE_USB_PID 0x4002u

/* --- HID report IDs: host -> dongle (output) --- */
#define MC_HID_RID_JOYSTICK 0x01u
#define MC_HID_RID_ENABLE 0x02u
#define MC_HID_RID_DISCOVERY 0x04u
#define MC_HID_RID_PAIR 0x10u
#define MC_HID_RID_UNPAIR 0x11u
#define MC_HID_RID_SET_NEUTRAL 0x12u

/* --- HID report IDs: dongle -> host (input) --- */
#define MC_HID_RID_HEARTBEAT_IN 0x03u
#define MC_HID_RID_NEUTRAL_IN 0x06u
#define MC_HID_RID_DISCOVERY_IN 0x05u
#define MC_HID_RID_DONGLE_STATUS 0xFEu

/* Fixed sizes for HID reports (padded where needed) */
#define MC_HID_OUT_JOYSTICK_LEN 25u /* 1 byte controller idx + joystick_packet_t */
#define MC_HID_OUT_ENABLE_LEN 8u
#define MC_HID_OUT_DISCOVERY_LEN 8u
#define MC_HID_OUT_PAIR_LEN 8u
#define MC_HID_OUT_UNPAIR_LEN 8u
#define MC_HID_OUT_SET_NEUTRAL_LEN 8u /* 1 byte slot idx + two uint16 us, padded */

#define MC_HID_IN_HEARTBEAT_LEN 26u
#define MC_HID_IN_DISCOVERY_LEN 24u
#define MC_HID_IN_NEUTRAL_LEN 12u
#define MC_HID_IN_STATUS_LEN 16u

#define MC_ROBOT_ID_MAX 16u
#define MC_JOY_AUX_BYTES 8u
#define MC_MAX_ROBOTS 4u

#define MC_DISCOVERY_COLLECT_MS 500u
#define MC_HEARTBEAT_INTERVAL_MS 1000u
#define MC_MOTOR_TIMEOUT_MS 250u

#define MC_BROADCAST_MAC_BYTE 0xFFu

/* Clamp for a neutral pulse arriving over the air (MC_MSG_SET_NEUTRAL).
 *
 * Deliberately much tighter than the robot's own 1000-2000 us PWM limits. A
 * neutral set in main.py is a number a student reads in context; one arriving
 * from a web text box is not, and neutral_us = 2000 would mean "motors stopped"
 * is full forward. Real ESC trim is +/-30-50 us, so +/-100 us is generous and
 * bounds a typo to roughly 20% throttle instead of 100%. */
#define MC_NEUTRAL_TRIM_MIN_US 1400u
#define MC_NEUTRAL_TRIM_MAX_US 1600u

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
    uint8_t mac[6];
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

/** Browser -> dongle -> robot: set the per-motor neutral pulse widths.
 *
 * Unicast only. target_mac is carried so the robot can verify the frame was
 * meant for it and refuse anything broadcast: neutral trim is per-robot ESC
 * calibration, and applying one robot's values field-wide would set every other
 * robot's idea of "stopped" to the wrong pulse. */
typedef struct {
    uint8_t type; /* MC_MSG_SET_NEUTRAL */
    uint8_t target_mac[6];
    uint16_t neutral_left_us;
    uint16_t neutral_right_us;
} set_neutral_packet_t;

/** Robot -> dongle -> browser: the neutrals actually in force.
 *
 * Sent after applying a MC_MSG_SET_NEUTRAL, in answer to a discovery request,
 * and unprompted on the robot's first few heartbeats, so the driver station can
 * fill its calibration fields with what the robot is really running however the
 * two came up in relation to each other.
 *
 * The values are post-clamp, so the station sees what landed rather than what it
 * asked for. `stored` distinguishes "applied right now" from "will survive a
 * reset" -- the flash write is allowed to fail without the change being lost. */
typedef struct {
    uint8_t type; /* MC_MSG_NEUTRAL_ACK */
    uint8_t mac[6];
    uint16_t neutral_left_us;
    uint16_t neutral_right_us;
    uint8_t stored; /* 1 = saved to the robot's filesystem */
} neutral_ack_packet_t;

/** Dongle -> browser status (report 0xFE) */
typedef struct {
    uint8_t wifi_channel;
    uint8_t paired_count;
    uint8_t global_enabled; /* 0/1 */
    uint8_t error_flags;    /* bit0: espnow send err */
    uint8_t reserved[12];
} dongle_status_t;

#pragma pack(pop)

#if defined(__GNUC__) || defined(__clang__)
_Static_assert(sizeof(joystick_packet_t) == 24, "joystick_packet_t size");
_Static_assert(sizeof(enable_packet_t) == 8, "enable_packet_t size");
_Static_assert(sizeof(heartbeat_packet_t) == 26, "heartbeat_packet_t size");
_Static_assert(sizeof(discovery_request_t) == 2, "discovery_request_t size");
_Static_assert(sizeof(discovery_response_t) == 24, "discovery_response_t size");
_Static_assert(sizeof(set_neutral_packet_t) == 11, "set_neutral_packet_t size");
_Static_assert(sizeof(dongle_status_t) == 16, "dongle_status_t size");
/* The HID report descriptor's byte counts must track these, or reports are
 * silently truncated rather than rejected. Tie them together here. */
_Static_assert(sizeof(neutral_ack_packet_t) == MC_HID_IN_NEUTRAL_LEN, "neutral_ack_packet_t size");
_Static_assert(1 + 2 * sizeof(uint16_t) <= MC_HID_OUT_SET_NEUTRAL_LEN, "set-neutral report too small");
#endif

#ifdef __cplusplus
}
#endif

#endif /* MINICORE_PROTOCOL_H */
