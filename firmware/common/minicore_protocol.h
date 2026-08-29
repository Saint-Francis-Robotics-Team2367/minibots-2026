/**
 * MiniCore WIRE PROTOCOL — packet layouts, message types, HID report IDs.
 * Shared by the dongle (ESP-IDF), the robot (MicroPython) and the web app.
 * Keep in sync with web/js/protocol.js + web/js/constants.js + minibot.py.
 *
 * THIS HEADER IS COMPILED INTO THE DONGLE. Any change here means a dongle
 * rebuild and a physical BOOT/RESET reflash, not just a robot upload — and
 * MC_PROTOCOL_VERSION below must be bumped so a stale dongle is detected
 * instead of silently misbehaving.
 *
 * Behaviour constants that the dongle does NOT need (timeouts, calibration
 * ranges) live in minicore_policy.h precisely so they can change without any of
 * that. Put new policy there, not here.
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
#define MC_MSG_SET_SPEED_LIMIT 0x08u /* dongle -> robot, broadcast only */
#define MC_MSG_SPEED_LIMIT_ACK 0x09u /* robot -> dongle */

/* Bumped whenever anything structural in THIS file changes: a message type, a
 * HID report id, a report length, or a packet layout. The dongle reports it in
 * dongle_status_t so the web app can tell the driver their dongle firmware is
 * older than the page, rather than leaving them to debug a silent mismatch --
 * which is exactly what a stale trim clamp cost us once already. */
#define MC_PROTOCOL_VERSION 2u

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
#define MC_HID_RID_SET_SPEED_LIMIT 0x13u

/* --- HID report IDs: dongle -> host (input) --- */
#define MC_HID_RID_HEARTBEAT_IN 0x03u
#define MC_HID_RID_NEUTRAL_IN 0x06u
#define MC_HID_RID_DISCOVERY_IN 0x05u
#define MC_HID_RID_SPEED_LIMIT_IN 0x07u
#define MC_HID_RID_DONGLE_STATUS 0xFEu

/* Fixed sizes for HID reports (padded where needed) */
#define MC_HID_OUT_JOYSTICK_LEN 25u /* 1 byte controller idx + joystick_packet_t */
#define MC_HID_OUT_ENABLE_LEN 8u
#define MC_HID_OUT_DISCOVERY_LEN 8u
#define MC_HID_OUT_PAIR_LEN 8u
#define MC_HID_OUT_UNPAIR_LEN 8u
#define MC_HID_OUT_SET_NEUTRAL_LEN 8u /* 1 byte slot idx + two uint16 us, padded */
#define MC_HID_OUT_SET_SPEED_LIMIT_LEN 8u /* one uint16 milli, padded */

#define MC_HID_IN_HEARTBEAT_LEN 26u
#define MC_HID_IN_DISCOVERY_LEN 24u
#define MC_HID_IN_NEUTRAL_LEN 12u
#define MC_HID_IN_SPEED_LIMIT_LEN 9u
#define MC_HID_IN_STATUS_LEN 16u

#define MC_ROBOT_ID_MAX 16u
#define MC_JOY_AUX_BYTES 8u
#define MC_MAX_ROBOTS 4u

/* Dongle-owned: how long it collects discovery responses before closing the
 * window. Behaviour of THIS device, so it belongs here rather than in policy. */
#define MC_DISCOVERY_COLLECT_MS 500u

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

/** Browser -> dongle -> robot: cap the normalized motor output.
 *
 * Broadcast, which is the opposite of MC_MSG_SET_NEUTRAL and deliberately so.
 * Neutral trim is per-robot ESC calibration, so applying one robot's value
 * field-wide would be a bug; a speed limit is a field-wide rule, and a robot
 * that missed it would be the fastest thing on the floor.
 *
 * limit_milli is thousandths of full output, so 1000 means unrestricted. Those
 * are the units of Minibot.drive_left_motor() scaled by 1000 -- the number the
 * robot clamps against, not a percentage of it -- so the value the driver sets
 * and the value a student writes in main.py can be compared directly.
 *
 * No target_mac: a broadcast frame has no single addressee, and the robot must
 * not be able to decide the cap was meant for someone else. */
typedef struct {
    uint8_t type; /* MC_MSG_SET_SPEED_LIMIT */
    uint16_t limit_milli;
} set_speed_limit_packet_t;

/** Robot -> dongle -> browser: the speed limit actually in force (post-clamp).
 *
 * Sent on applying a MC_MSG_SET_SPEED_LIMIT and in answer to a discovery
 * request. There is no `stored` flag because the robot deliberately does not
 * persist this: a speed limit is event policy, not a property of the robot, and
 * one that survived a power cycle would silently cap a robot days later. The
 * station is the durable copy and re-sends to any robot whose ack does not match
 * what it asked for, which is what covers a robot rebooting mid-match. */
typedef struct {
    uint8_t type; /* MC_MSG_SPEED_LIMIT_ACK */
    uint8_t mac[6];
    uint16_t limit_milli;
} speed_limit_ack_packet_t;

/** Dongle -> browser status (report 0xFE) */
typedef struct {
    uint8_t wifi_channel;
    uint8_t paired_count;
    uint8_t global_enabled; /* 0/1 */
    uint8_t error_flags;    /* bit0: espnow send err */
    uint8_t protocol_version; /* MC_PROTOCOL_VERSION the dongle was built with */
    uint8_t reserved[11];
} dongle_status_t;

#pragma pack(pop)

#if defined(__GNUC__) || defined(__clang__)
_Static_assert(sizeof(joystick_packet_t) == 24, "joystick_packet_t size");
_Static_assert(sizeof(enable_packet_t) == 8, "enable_packet_t size");
_Static_assert(sizeof(heartbeat_packet_t) == 26, "heartbeat_packet_t size");
_Static_assert(sizeof(discovery_request_t) == 2, "discovery_request_t size");
_Static_assert(sizeof(discovery_response_t) == 24, "discovery_response_t size");
_Static_assert(sizeof(set_neutral_packet_t) == 11, "set_neutral_packet_t size");
_Static_assert(sizeof(set_speed_limit_packet_t) == 3, "set_speed_limit_packet_t size");
_Static_assert(sizeof(dongle_status_t) == 16, "dongle_status_t size");
/* The HID report descriptor's byte counts must track these, or reports are
 * silently truncated rather than rejected. Tie them together here. */
_Static_assert(sizeof(neutral_ack_packet_t) == MC_HID_IN_NEUTRAL_LEN, "neutral_ack_packet_t size");
_Static_assert(1 + 2 * sizeof(uint16_t) <= MC_HID_OUT_SET_NEUTRAL_LEN, "set-neutral report too small");
_Static_assert(sizeof(speed_limit_ack_packet_t) == MC_HID_IN_SPEED_LIMIT_LEN, "speed_limit_ack_packet_t size");
_Static_assert(sizeof(uint16_t) <= MC_HID_OUT_SET_SPEED_LIMIT_LEN, "set-speed-limit report too small");
#endif

#ifdef __cplusplus
}
#endif

#endif /* MINICORE_PROTOCOL_H */
